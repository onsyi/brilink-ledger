-- Shift capital model: replace transaction-based expected-cash/variance with
-- asset-based modal awal / modal akhir accounting.
--
-- Buka shift  : modal_awal  = initial_physical + additional_capital + sum(bank initial) + sum(ppob initial)
-- Tutup shift : modal_akhir = final_physical + sum(bank final) + sum(ppob final) - modal_awal
--
-- Expenses and owner deposits are recorded but NOT part of the calculation.

-- 1) New columns on shifts
ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS additional_capital NUMERIC(16,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS modal_awal NUMERIC(16,2),
  ADD COLUMN IF NOT EXISTS modal_akhir NUMERIC(16,2);

-- 2) Opening balances on bank/ppob snapshot tables
ALTER TABLE public.bank_balances
  ADD COLUMN IF NOT EXISTS initial_amount NUMERIC(16,2) NOT NULL DEFAULT 0;

ALTER TABLE public.ppob_balances
  ADD COLUMN IF NOT EXISTS initial_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS topup_amount NUMERIC(16,2) NOT NULL DEFAULT 0;

-- 3) CHECK constraints for the new monetary columns
ALTER TABLE public.shifts
  DROP CONSTRAINT IF EXISTS shifts_additional_capital_check;
ALTER TABLE public.shifts
  ADD CONSTRAINT shifts_additional_capital_check CHECK (additional_capital >= 0);

ALTER TABLE public.bank_balances
  DROP CONSTRAINT IF EXISTS bank_balances_initial_amount_check;
ALTER TABLE public.bank_balances
  ADD CONSTRAINT bank_balances_initial_amount_check CHECK (initial_amount >= 0);

ALTER TABLE public.ppob_balances
  DROP CONSTRAINT IF EXISTS ppob_balances_initial_amount_check;
ALTER TABLE public.ppob_balances
  ADD CONSTRAINT ppob_balances_initial_amount_check CHECK (initial_amount >= 0);

ALTER TABLE public.ppob_balances
  DROP CONSTRAINT IF EXISTS ppob_balances_topup_amount_check;
ALTER TABLE public.ppob_balances
  ADD CONSTRAINT ppob_balances_topup_amount_check CHECK (topup_amount >= 0);

-- 4) Extend the closed-shift guard to protect the new financial columns
CREATE OR REPLACE FUNCTION public.prevent_closed_shift_financial_edit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    IF NEW.final_physical_balance IS DISTINCT FROM OLD.final_physical_balance
       OR NEW.initial_physical_balance IS DISTINCT FROM OLD.initial_physical_balance
       OR NEW.additional_capital IS DISTINCT FROM OLD.additional_capital
       OR NEW.modal_awal IS DISTINCT FROM OLD.modal_awal
       OR NEW.modal_akhir IS DISTINCT FROM OLD.modal_akhir
       OR NEW.total_expenses IS DISTINCT FROM OLD.total_expenses
       OR NEW.topup_request IS DISTINCT FROM OLD.topup_request
       OR NEW.deposit_amount IS DISTINCT FROM OLD.deposit_amount
    THEN
      RAISE EXCEPTION 'Tidak boleh mengubah data keuangan shift yang sudah ditutup';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 5) Atomic open-shift RPC: creates the shift plus opening bank/ppob balances.
CREATE OR REPLACE FUNCTION public.open_shift_atomic(
  _user_id UUID,
  _branch_id UUID,
  _initial_cash NUMERIC,
  _additional_capital NUMERIC,
  _bank_snapshots JSONB,
  _ppob_snapshots JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _bank RECORD;
  _ppob RECORD;
  _bank_total NUMERIC := 0;
  _ppob_total NUMERIC := 0;
  _modal_awal NUMERIC;
  _shift_id UUID;
BEGIN
  IF _user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Hanya dapat membuka shift untuk akun sendiri';
  END IF;

  IF EXISTS (SELECT 1 FROM public.shifts WHERE user_id = _user_id AND status = 'open') THEN
    RAISE EXCEPTION 'Masih ada shift aktif di akun ini. Tutup dulu shift tersebut.';
  END IF;

  FOR _bank IN SELECT * FROM jsonb_to_recordset(_bank_snapshots) AS x(bank_name TEXT, initial_amount NUMERIC)
  LOOP
    _bank_total := _bank_total + COALESCE(_bank.initial_amount, 0);
  END LOOP;

  FOR _ppob IN SELECT * FROM jsonb_to_recordset(_ppob_snapshots) AS x(provider_name TEXT, initial_amount NUMERIC)
  LOOP
    _ppob_total := _ppob_total + COALESCE(_ppob.initial_amount, 0);
  END LOOP;

  _modal_awal := COALESCE(_initial_cash, 0) + COALESCE(_additional_capital, 0) + _bank_total + _ppob_total;

  INSERT INTO public.shifts (user_id, branch_id, initial_physical_balance, additional_capital, modal_awal, status)
  VALUES (_user_id, _branch_id, COALESCE(_initial_cash, 0), COALESCE(_additional_capital, 0), _modal_awal, 'open')
  RETURNING id INTO _shift_id;

  FOR _bank IN SELECT * FROM jsonb_to_recordset(_bank_snapshots) AS x(bank_name TEXT, initial_amount NUMERIC)
  LOOP
    INSERT INTO public.bank_balances (shift_id, bank_name, initial_amount)
    VALUES (_shift_id, _bank.bank_name, COALESCE(_bank.initial_amount, 0));
  END LOOP;

  FOR _ppob IN SELECT * FROM jsonb_to_recordset(_ppob_snapshots) AS x(provider_name TEXT, initial_amount NUMERIC)
  LOOP
    INSERT INTO public.ppob_balances (shift_id, provider_name, initial_amount)
    VALUES (_shift_id, _ppob.provider_name, COALESCE(_ppob.initial_amount, 0));
  END LOOP;

  RETURN _shift_id;
END;
$$;

-- 6) Update close-shift RPC to compute & store modal_akhir
CREATE OR REPLACE FUNCTION public.close_shift_atomic(
  _shift_id UUID,
  _final_cash NUMERIC,
  _expenses NUMERIC,
  _expense_notes TEXT,
  _topup NUMERIC,
  _deposit NUMERIC,
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
  _modal_awal NUMERIC;
  _modal_akhir NUMERIC;
  _shift_status public.shift_status;
BEGIN
  IF NOT (public.shift_is_writable(_shift_id)) THEN
    RAISE EXCEPTION 'Shift tidak dapat ditulis — hanya shift terbuka milik sendiri yang bisa ditutup';
  END IF;

  SELECT status, COALESCE(modal_awal, initial_physical_balance) INTO _shift_status, _modal_awal
  FROM public.shifts WHERE id = _shift_id;
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

  _modal_akhir := COALESCE(_final_cash, 0) + _bank_total + _ppob_total - COALESCE(_modal_awal, 0);

  UPDATE public.shifts
  SET
    final_physical_balance = _final_cash,
    modal_akhir = _modal_akhir,
    total_expenses = _expenses,
    expense_notes = _expense_notes,
    topup_request = _topup,
    deposit_amount = _deposit,
    end_time = NOW(),
    status = 'closed'
  WHERE id = _shift_id;
END;
$$;

-- 7) Permissions for the new open-shift RPC
REVOKE ALL ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, NUMERIC, JSONB, JSONB) TO authenticated, service_role;

-- Re-assert close-shift RPC grants (idempotent, in case the earlier migration is skipped)
REVOKE ALL ON FUNCTION public.close_shift_atomic(UUID, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_shift_atomic(UUID, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, JSONB, JSONB) TO authenticated, service_role;
