-- Migration 00007: Remove owner_withdrawal from DB functions
--
-- Owner penarikan workflow changed: owner audits bank balance down, kasir records
-- as Pengeluaran. Net effect on Saldo Akhir = 0.
--
-- Formula:
--   Saldo Awal  = Kas Awal + Bank Awal + Modal Tambahan (no PPOB)
--   Saldo Akhir = Kas Tutup + Bank Tutup + Settlement + Pengeluaran (no owner_withdrawal)

BEGIN;

-- 0. Drop old overloaded close_shift_atomic (with _owner_withdrawal param)
DROP FUNCTION IF EXISTS public.close_shift_atomic(uuid, numeric, numeric, numeric, text, numeric, numeric, numeric, jsonb, jsonb, numeric);

-- 1. close_shift_atomic: remove _owner_withdrawal from modal_akhir + store
CREATE OR REPLACE FUNCTION public.close_shift_atomic(
  _shift_id        UUID,
  _final_cash      NUMERIC,
  _additional_capital NUMERIC,
  _expenses        NUMERIC,
  _expense_notes   TEXT,
  _topup           NUMERIC,
  _deposit         NUMERIC,
  _settlement      NUMERIC,
  _bank_snapshots  JSONB,
  _ppob_snapshots  JSONB
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _bank            RECORD;
  _ppob            RECORD;
  _bank_total_final   NUMERIC := 0;
  _bank_total_initial NUMERIC := 0;
  _modal_awal      NUMERIC;
  _modal_akhir     NUMERIC;
  _shift_status    public.shift_status;
  _initial_cash    NUMERIC;
BEGIN
  IF NOT (public.shift_is_writable(_shift_id)) THEN
    RAISE EXCEPTION 'Shift tidak dapat ditulis — hanya shift terbuka milik sendiri yang bisa ditutup';
  END IF;

  SELECT status, initial_physical_balance INTO _shift_status, _initial_cash
  FROM public.shifts WHERE id = _shift_id;

  IF _shift_status IS NULL THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;
  IF _shift_status <> 'open' THEN
    RAISE EXCEPTION 'Shift sudah ditutup sebelumnya';
  END IF;

  IF COALESCE(_final_cash, 0) < 0 THEN
    RAISE EXCEPTION 'Saldo fisik akhir tidak boleh negatif';
  END IF;
  IF COALESCE(_additional_capital, 0) < 0 THEN
    RAISE EXCEPTION 'Modal tambahan tidak boleh negatif';
  END IF;
  IF COALESCE(_expenses, 0) < 0 THEN
    RAISE EXCEPTION 'Pengeluaran tidak boleh negatif';
  END IF;
  IF COALESCE(_topup, 0) < 0 THEN
    RAISE EXCEPTION 'Penambahan saldo PPOB tidak boleh negatif';
  END IF;
  IF COALESCE(_deposit, 0) < 0 THEN
    RAISE EXCEPTION 'Setoran tidak boleh negatif';
  END IF;
  IF COALESCE(_settlement, 0) < 0 THEN
    RAISE EXCEPTION 'Settlement tidak boleh negatif';
  END IF;

  FOR _bank IN SELECT * FROM jsonb_to_recordset(_bank_snapshots) AS x(bank_name TEXT, final_amount NUMERIC)
  LOOP
    IF COALESCE(_bank.final_amount, 0) < 0 THEN
      RAISE EXCEPTION 'Saldo akhir % tidak boleh negatif', _bank.bank_name;
    END IF;
    INSERT INTO public.bank_balances (shift_id, bank_name, final_amount)
    VALUES (_shift_id, _bank.bank_name, COALESCE(_bank.final_amount, 0))
    ON CONFLICT (shift_id, bank_name)
    DO UPDATE SET final_amount = EXCLUDED.final_amount;
    _bank_total_final := _bank_total_final + COALESCE(_bank.final_amount, 0);
  END LOOP;

  FOR _ppob IN SELECT * FROM jsonb_to_recordset(_ppob_snapshots) AS x(provider_name TEXT, final_amount NUMERIC, topup_amount NUMERIC)
  LOOP
    IF COALESCE(_ppob.final_amount, 0) < 0 OR COALESCE(_ppob.topup_amount, 0) < 0 THEN
      RAISE EXCEPTION 'Saldo akhir % tidak boleh negatif', _ppob.provider_name;
    END IF;
    INSERT INTO public.ppob_balances (shift_id, provider_name, final_amount, topup_amount)
    VALUES (_shift_id, _ppob.provider_name, COALESCE(_ppob.final_amount, 0), COALESCE(_ppob.topup_amount, 0))
    ON CONFLICT (shift_id, provider_name)
    DO UPDATE SET final_amount = EXCLUDED.final_amount, topup_amount = EXCLUDED.topup_amount;
  END LOOP;

  SELECT COALESCE(SUM(initial_amount), 0) INTO _bank_total_initial
  FROM public.bank_balances WHERE shift_id = _shift_id;

  -- Rumus Saldo Awal  = Kas Awal + Bank Awal + Modal Tambahan (no PPOB)
  _modal_awal := COALESCE(_initial_cash, 0) + _bank_total_initial + COALESCE(_additional_capital, 0);
  -- Rumus Saldo Akhir = Kas Tutup + Bank Tutup + Settlement + Pengeluaran (no owner_withdrawal)
  _modal_akhir := COALESCE(_final_cash, 0)
    + _bank_total_final
    + COALESCE(_settlement, 0)
    + COALESCE(_expenses, 0);

  PERFORM set_config('brilink.audit_override', 'on', true);

  UPDATE public.shifts
  SET
    final_physical_balance = _final_cash,
    additional_capital     = COALESCE(_additional_capital, 0),
    modal_awal             = _modal_awal,
    modal_akhir            = _modal_akhir,
    total_expenses         = _expenses,
    expense_notes          = _expense_notes,
    topup_request          = _topup,
    deposit_amount         = _deposit,
    settlement_amount      = COALESCE(_settlement, 0),
    end_time               = NOW(),
    status                 = 'closed'
  WHERE id = _shift_id;

  PERFORM set_config('brilink.audit_override', 'off', true);
END;
$function$;

-- 2. owner_adjust_balance: remove owner_withdrawal from modal_akhir recalc
CREATE OR REPLACE FUNCTION public.owner_adjust_balance(
  _shift_id  UUID,
  _kind      TEXT,
  _name      TEXT,
  _field     TEXT,
  _new_value NUMERIC,
  _reason    TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _shift      public.shifts%ROWTYPE;
  _old_value  NUMERIC;
  _reason_clean TEXT := btrim(COALESCE(_reason, ''));
  _before     JSONB;
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat mengaudit saldo';
  END IF;
  IF _kind NOT IN ('bank', 'ppob') THEN
    RAISE EXCEPTION 'Jenis akun harus bank atau ppob';
  END IF;
  IF _field NOT IN ('initial', 'final') THEN
    RAISE EXCEPTION 'Kolom harus initial atau final';
  END IF;
  IF _new_value IS NULL OR _new_value < 0 THEN
    RAISE EXCEPTION 'Nilai saldo baru tidak boleh negatif';
  END IF;
  IF length(_reason_clean) < 3 THEN
    RAISE EXCEPTION 'Alasan koreksi wajib diisi (minimal 3 karakter)';
  END IF;

  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id;
  IF _shift.id IS NULL THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;

  IF _kind = 'bank' THEN
    SELECT CASE WHEN _field = 'initial' THEN initial_amount ELSE final_amount END
    INTO _old_value
    FROM public.bank_balances
    WHERE shift_id = _shift_id AND bank_name = _name;
    IF _old_value IS NULL THEN
      RAISE EXCEPTION 'Akun bank % tidak ditemukan di shift ini', _name;
    END IF;
  ELSE
    SELECT CASE WHEN _field = 'initial' THEN initial_amount ELSE final_amount END
    INTO _old_value
    FROM public.ppob_balances
    WHERE shift_id = _shift_id AND provider_name = _name;
    IF _old_value IS NULL THEN
      RAISE EXCEPTION 'Akun PPOB % tidak ditemukan di shift ini', _name;
    END IF;
  END IF;

  IF _old_value = _new_value THEN
    RETURN;
  END IF;

  _before := jsonb_build_object(
    'kind', _kind, 'name', _name, 'field', _field,
    'value', _old_value,
    'modal_awal', _shift.modal_awal,
    'modal_akhir', _shift.modal_akhir,
    'reason', _reason_clean
  );

  IF _kind = 'bank' THEN
    UPDATE public.bank_balances
    SET initial_amount = CASE WHEN _field = 'initial' THEN _new_value ELSE initial_amount END,
        final_amount   = CASE WHEN _field = 'final'   THEN _new_value ELSE final_amount END
    WHERE shift_id = _shift_id AND bank_name = _name;
  ELSE
    UPDATE public.ppob_balances
    SET initial_amount = CASE WHEN _field = 'initial' THEN _new_value ELSE initial_amount END,
        final_amount   = CASE WHEN _field = 'final'   THEN _new_value ELSE final_amount END
    WHERE shift_id = _shift_id AND provider_name = _name;
  END IF;

  PERFORM set_config('brilink.audit_override', 'on', true);

  -- Saldo Awal  = Kas Awal + Bank Awal + Modal Tambahan (no PPOB)
  -- Saldo Akhir = Kas Tutup + Bank Tutup + Settlement + Pengeluaran (no owner_withdrawal)
  UPDATE public.shifts s
  SET modal_awal = COALESCE(s.initial_physical_balance, 0)
        + COALESCE((SELECT SUM(initial_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
        + COALESCE(s.additional_capital, 0),
      modal_akhir = CASE WHEN s.status = 'closed' THEN
          COALESCE(s.final_physical_balance, 0)
          + COALESCE((SELECT SUM(final_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
          + COALESCE(s.settlement_amount, 0)
          + COALESCE(s.total_expenses, 0)
        ELSE s.modal_akhir END
  WHERE s.id = _shift_id;

  PERFORM set_config('brilink.audit_override', 'off', true);

  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id;

  INSERT INTO public.shift_amendments (shift_id, user_id, action, before_data, after_data)
  VALUES (
    _shift_id, auth.uid(), 'audit', _before,
    jsonb_build_object(
      'kind', _kind, 'name', _name, 'field', _field,
      'value', _new_value,
      'modal_awal', _shift.modal_awal,
      'modal_akhir', _shift.modal_akhir,
      'reason', _reason_clean
    )
  );
END;
$function$;

-- 3. owner_adjust_shift_field: remove owner_withdrawal from allowed fields + modal_akhir recalc
CREATE OR REPLACE FUNCTION public.owner_adjust_shift_field(
  _shift_id  UUID,
  _field     TEXT,
  _new_value NUMERIC,
  _reason    TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _shift       public.shifts%ROWTYPE;
  _old_value   NUMERIC;
  _reason_clean TEXT := btrim(COALESCE(_reason, ''));
  _label       TEXT;
  _before      JSONB;
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat mengaudit angka penutupan';
  END IF;

  IF _field NOT IN ('total_expenses', 'settlement_amount',
                    'final_physical_balance', 'additional_capital') THEN
    RAISE EXCEPTION 'Kolom tidak dikenal: %', COALESCE(_field, 'NULL');
  END IF;

  IF _new_value IS NULL OR _new_value < 0 THEN
    RAISE EXCEPTION 'Nilai baru tidak boleh negatif';
  END IF;
  IF length(_reason_clean) < 3 THEN
    RAISE EXCEPTION 'Alasan koreksi wajib diisi (minimal 3 karakter)';
  END IF;

  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id;
  IF _shift.id IS NULL THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;
  IF _shift.status <> 'closed' THEN
    RAISE EXCEPTION 'Shift masih terbuka — kasir dapat mengoreksinya sendiri lewat Tutup Shift / Perbaiki modal awal';
  END IF;

  _old_value := CASE _field
    WHEN 'total_expenses' THEN _shift.total_expenses
    WHEN 'settlement_amount' THEN _shift.settlement_amount
    WHEN 'final_physical_balance' THEN _shift.final_physical_balance
    WHEN 'additional_capital' THEN _shift.additional_capital
  END;

  _label := CASE _field
    WHEN 'total_expenses' THEN 'Pengeluaran'
    WHEN 'settlement_amount' THEN 'Settlement'
    WHEN 'final_physical_balance' THEN 'Kas Fisik Akhir'
    WHEN 'additional_capital' THEN 'Modal Tambahan'
  END;

  IF _old_value IS NOT DISTINCT FROM _new_value THEN
    RETURN;
  END IF;

  _before := jsonb_build_object(
    'kind', 'shift', 'name', _label, 'field', _field,
    'value', _old_value,
    'modal_awal', _shift.modal_awal,
    'modal_akhir', _shift.modal_akhir,
    'reason', _reason_clean
  );

  PERFORM set_config('brilink.audit_override', 'on', true);

  UPDATE public.shifts
  SET total_expenses         = CASE WHEN _field = 'total_expenses' THEN _new_value ELSE total_expenses END,
      settlement_amount      = CASE WHEN _field = 'settlement_amount' THEN _new_value ELSE settlement_amount END,
      final_physical_balance = CASE WHEN _field = 'final_physical_balance' THEN _new_value ELSE final_physical_balance END,
      additional_capital     = CASE WHEN _field = 'additional_capital' THEN _new_value ELSE additional_capital END
  WHERE id = _shift_id;

  -- Saldo Awal  = Kas Awal + Bank Awal + Modal Tambahan (no PPOB)
  -- Saldo Akhir = Kas Tutup + Bank Tutup + Settlement + Pengeluaran (no owner_withdrawal)
  UPDATE public.shifts s
  SET modal_awal = COALESCE(s.initial_physical_balance, 0)
        + COALESCE((SELECT SUM(initial_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
        + COALESCE(s.additional_capital, 0),
      modal_akhir = COALESCE(s.final_physical_balance, 0)
        + COALESCE((SELECT SUM(final_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
        + COALESCE(s.settlement_amount, 0)
        + COALESCE(s.total_expenses, 0)
  WHERE s.id = _shift_id;

  PERFORM set_config('brilink.audit_override', 'off', true);

  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id;

  INSERT INTO public.shift_amendments (shift_id, user_id, action, before_data, after_data)
  VALUES (
    _shift_id, auth.uid(), 'audit', _before,
    jsonb_build_object(
      'kind', 'shift', 'name', _label, 'field', _field,
      'value', _new_value,
      'modal_awal', _shift.modal_awal,
      'modal_akhir', _shift.modal_akhir,
      'reason', _reason_clean
    )
  );
END;
$function$;

COMMIT;
