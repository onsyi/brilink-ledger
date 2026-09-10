-- =========================================================================
-- Fix: close_shift_atomic — query bank_balances for final total after upsert
-- =========================================================================
-- In close_shift_atomic, _bank_total_initial is queried from public.bank_balances,
-- but _bank_total_final was accumulated from the _bank_snapshots JSON loop.
-- Querying public.bank_balances directly after upsert ensures modal_akhir reflects
-- the true database state, matching the pattern in amend_open_shift and owner_adjust_shift_field.

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

  -- Query bank_balances table AFTER upsert for both initial and final totals
  SELECT COALESCE(SUM(initial_amount), 0) INTO _bank_total_initial
  FROM public.bank_balances WHERE shift_id = _shift_id;

  SELECT COALESCE(SUM(final_amount), 0) INTO _bank_total_final
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

REVOKE ALL ON FUNCTION public.close_shift_atomic(
  UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.close_shift_atomic(
  UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB
) TO authenticated, service_role;
