-- Add "settlement" field and switch the laba formula to "Laba Fee":
--   Laba Fee = (Saldo Akhir + total saldo rekening AKHIR + Pengeluaran + settlement)
--            - (Saldo Awal + total saldo rekening AWAL + Penambahan Saldo)
-- where:
--   Saldo Akhir         = final_physical_balance
--   saldo rekening AKHIR = SUM(bank_balances.final_amount)
--   Pengeluaran          = total_expenses
--   settlement           = settlement_amount (NEW)
--   Saldo Awal           = initial_physical_balance
--   saldo rekening AWAL  = SUM(bank_balances.initial_amount)
--   Penambahan Saldo     = topup_request

-- 1) Add settlement_amount column
ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS settlement_amount NUMERIC(16,2) NOT NULL DEFAULT 0;

ALTER TABLE public.shifts
  DROP CONSTRAINT IF EXISTS shifts_settlement_amount_check;
ALTER TABLE public.shifts
  ADD CONSTRAINT shifts_settlement_amount_check CHECK (settlement_amount >= 0);

-- 2) Recreate close_shift_atomic to accept & store settlement
DROP FUNCTION IF EXISTS public.close_shift_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, JSONB, JSONB);

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

  FOR _bank IN SELECT * FROM jsonb_to_recordset(_bank_snapshots) AS x(bank_name TEXT, final_amount NUMERIC)
  LOOP
    INSERT INTO public.bank_balances (shift_id, bank_name, final_amount)
    VALUES (_shift_id, _bank.bank_name, COALESCE(_bank.final_amount, 0))
    ON CONFLICT (shift_id, bank_name)
    DO UPDATE SET final_amount = EXCLUDED.final_amount;
    _bank_total := _bank_total + COALESCE(_bank.final_amount, 0);
  END LOOP;

  FOR _ppob IN SELECT * FROM jsonb_to_recordset(_ppob_snapshots) AS x(provider_name TEXT, final_amount NUMERIC, topup_amount NUMERIC)
  LOOP
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
    additional_capital = COALESCE(_additional_capital, 0),
    modal_akhir = _modal_akhir,
    total_expenses = _expenses,
    expense_notes = _expense_notes,
    topup_request = _topup,
    deposit_amount = _deposit,
    settlement_amount = COALESCE(_settlement, 0),
    end_time = NOW(),
    status = 'closed'
  WHERE id = _shift_id;
END;
$$;

-- 3) Grant for the new signature
REVOKE ALL ON FUNCTION public.close_shift_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_shift_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, NUMERIC, JSONB, JSONB) TO authenticated, service_role;

-- 4) Protect settlement_amount from edits after close
CREATE OR REPLACE FUNCTION public.prevent_closed_shift_financial_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    IF NEW.final_physical_balance IS DISTINCT FROM OLD.final_physical_balance
       OR NEW.initial_physical_balance IS DISTINCT FROM OLD.initial_physical_balance
       OR NEW.total_expenses IS DISTINCT FROM OLD.total_expenses
       OR NEW.topup_request IS DISTINCT FROM OLD.topup_request
       OR NEW.deposit_amount IS DISTINCT FROM OLD.deposit_amount
       OR NEW.settlement_amount IS DISTINCT FROM OLD.settlement_amount
    THEN
      RAISE EXCEPTION 'Tidak boleh mengubah data keuangan shift yang sudah ditutup';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
