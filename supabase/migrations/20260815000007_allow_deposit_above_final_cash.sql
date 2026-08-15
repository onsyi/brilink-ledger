-- Drop the "deposit must not exceed final cash" rule from close_shift_atomic.
--
-- 20260815000004 added it on the assumption that the drawer is counted before
-- the money is handed to the owner, so a deposit larger than the closing cash
-- had to be a typo. The real workflow is the reverse: the cashier hands the
-- money over first and then counts what is left, so a deposit of Rp 7.035.000
-- against a closing balance of Rp 3.880.000 is perfectly normal -- the drawer
-- held Rp 10.915.000 before the handover.
--
-- The rule made shifts impossible to close. Every other validation from that
-- migration is kept.
--
-- Idempotent: safe to re-run.

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

  _modal_akhir := COALESCE(_final_cash, 0) + _bank_total + _ppob_total;

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

REVOKE ALL ON FUNCTION public.close_shift_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_shift_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB) TO authenticated, service_role;
