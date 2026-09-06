-- Fix closing capital accounting: include deposit_amount in modal_akhir.
--
-- Kasir menghitung sisa uang kas fisik di laci *setelah* uang setoran (deposit_amount)
-- diserahkan kepada owner. Agar nilai modal akhir mencerminkan posisi total aset kotor
-- shift (kas di laci + kas di tangan owner + bank + PPOB), modal_akhir harus
-- menjumlahkan COALESCE(_deposit, 0).
--
-- Idempotent: safe to re-run.

-- 1) Recreate close_shift_atomic with deposit in modal_akhir
CREATE OR REPLACE FUNCTION public.close_shift_atomic(
  _shift_id UUID,
  _final_cash NUMERIC,
  _additional_capital NUMERIC,
  _expenses NUMERIC,
  _expense_notes TEXT,
  _topup NUMERIC,
  _deposit NUMERIC,
  _settlement NUMERIC,
  _bank_snapshots JSONB,
  _ppob_snapshots JSONB
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _bank RECORD;
  _ppob RECORD;
  _bank_total NUMERIC := 0;
  _ppob_total NUMERIC := 0;
  _modal_akhir NUMERIC;
  _shift_status public.shift_status;
BEGIN
  IF NOT (public.shift_is_writable(_shift_id)) THEN
    RAISE EXCEPTION 'Shift tidak dapat ditulis — hanya shift terbuka milik sendiri yang bisa ditutup';
  END IF;

  SELECT status INTO _shift_status FROM public.shifts WHERE id = _shift_id;
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
    _bank_total := _bank_total + COALESCE(_bank.final_amount, 0);
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
    _ppob_total := _ppob_total + COALESCE(_ppob.final_amount, 0);
  END LOOP;

  -- Gross closing capital = cash in drawer + cash handed to owner + bank + PPOB
  _modal_akhir := COALESCE(_final_cash, 0) + COALESCE(_deposit, 0) + _bank_total + _ppob_total;

  UPDATE public.shifts
  SET
    final_physical_balance = _final_cash,
    additional_capital     = COALESCE(_additional_capital, 0),
    modal_akhir            = _modal_akhir,
    total_expenses         = _expenses,
    expense_notes          = _expense_notes,
    topup_request          = _topup,
    deposit_amount         = _deposit,
    settlement_amount      = COALESCE(_settlement, 0),
    end_time               = NOW(),
    status                 = 'closed'
  WHERE id = _shift_id;
END;
$$;

-- 2) Recreate owner_adjust_balance to include deposit_amount in modal_akhir
CREATE OR REPLACE FUNCTION public.owner_adjust_balance(
  _shift_id UUID,
  _kind TEXT,        -- 'bank' | 'ppob'
  _name TEXT,        -- bank_name / provider_name
  _field TEXT,       -- 'initial' | 'final'
  _new_value NUMERIC,
  _reason TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _shift public.shifts%ROWTYPE;
  _old_value NUMERIC;
  _reason_clean TEXT := btrim(COALESCE(_reason, ''));
  _before JSONB;
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
  IF COALESCE(_new_value, -1) < 0 THEN
    RAISE EXCEPTION 'Nilai saldo tidak boleh negatif';
  END IF;
  IF length(_reason_clean) < 5 THEN
    RAISE EXCEPTION 'Alasan audit wajib diisi (minimal 5 karakter)';
  END IF;

  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id;
  IF _shift.id IS NULL THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;

  -- Read the current value, creating the row if that account was never recorded.
  IF _kind = 'bank' THEN
    INSERT INTO public.bank_balances (shift_id, bank_name)
    VALUES (_shift_id, _name)
    ON CONFLICT (shift_id, bank_name) DO NOTHING;
    SELECT CASE WHEN _field = 'initial' THEN initial_amount ELSE final_amount END
      INTO _old_value FROM public.bank_balances
      WHERE shift_id = _shift_id AND bank_name = _name;
  ELSE
    INSERT INTO public.ppob_balances (shift_id, provider_name)
    VALUES (_shift_id, _name)
    ON CONFLICT (shift_id, provider_name) DO NOTHING;
    SELECT CASE WHEN _field = 'initial' THEN initial_amount ELSE final_amount END
      INTO _old_value FROM public.ppob_balances
      WHERE shift_id = _shift_id AND provider_name = _name;
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

  -- Keep the stored capital totals consistent with the balances just changed.
  PERFORM set_config('brilink.audit_override', 'on', true);

  UPDATE public.shifts s
  SET modal_awal = s.initial_physical_balance
        + COALESCE((SELECT SUM(initial_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
        + COALESCE((SELECT SUM(initial_amount) FROM public.ppob_balances WHERE shift_id = s.id), 0),
      modal_akhir = CASE WHEN s.status = 'closed' THEN
          COALESCE(s.final_physical_balance, 0)
          + COALESCE(s.deposit_amount, 0)
          + COALESCE((SELECT SUM(final_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
          + COALESCE((SELECT SUM(final_amount) FROM public.ppob_balances WHERE shift_id = s.id), 0)
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
$$;

-- 3) Grants
REVOKE ALL ON FUNCTION public.close_shift_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_shift_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.owner_adjust_balance(UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_adjust_balance(UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO authenticated, service_role;

-- 4) Backfill historical closed shifts so stored modal_akhir includes deposit_amount
DO $$
BEGIN
  PERFORM set_config('brilink.audit_override', 'on', true);

  UPDATE public.shifts s
  SET modal_akhir = COALESCE(s.final_physical_balance, 0)
        + COALESCE(s.deposit_amount, 0)
        + COALESCE((SELECT SUM(final_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
        + COALESCE((SELECT SUM(final_amount) FROM public.ppob_balances WHERE shift_id = s.id), 0)
  WHERE s.status = 'closed'
    AND s.modal_akhir IS NOT NULL
    AND COALESCE(s.deposit_amount, 0) > 0
    AND s.modal_akhir = (
      COALESCE(s.final_physical_balance, 0)
      + COALESCE((SELECT SUM(final_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
      + COALESCE((SELECT SUM(final_amount) FROM public.ppob_balances WHERE shift_id = s.id), 0)
    );

  PERFORM set_config('brilink.audit_override', 'off', true);
END;
$$;
