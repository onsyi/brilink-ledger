-- Move "modal tambahan" (additional capital) from open shift to close shift.
-- modal_awal no longer includes additional capital; it is now recorded at close
-- and subtracted from laba: laba = modal_akhir - modal_awal - modal_tambahan.

-- 1) Recreate open_shift_atomic WITHOUT additional capital
DROP FUNCTION IF EXISTS public.open_shift_atomic(UUID, UUID, NUMERIC, NUMERIC, JSONB, JSONB);

CREATE OR REPLACE FUNCTION public.open_shift_atomic(
  _user_id UUID,
  _branch_id UUID,
  _initial_cash NUMERIC,
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

  _modal_awal := COALESCE(_initial_cash, 0) + _bank_total + _ppob_total;

  INSERT INTO public.shifts (user_id, branch_id, initial_physical_balance, additional_capital, modal_awal, status)
  VALUES (_user_id, _branch_id, COALESCE(_initial_cash, 0), 0, _modal_awal, 'open')
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

-- 2) Recreate close_shift_atomic WITH additional capital
DROP FUNCTION IF EXISTS public.close_shift_atomic(UUID, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, JSONB, JSONB);

CREATE OR REPLACE FUNCTION public.close_shift_atomic(
  _shift_id UUID,
  _final_cash NUMERIC,
  _additional_capital NUMERIC,
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
    end_time = NOW(),
    status = 'closed'
  WHERE id = _shift_id;
END;
$$;

-- 3) Grants for the new signatures
REVOKE ALL ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, JSONB, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.close_shift_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_shift_atomic(UUID, NUMERIC, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, JSONB, JSONB) TO authenticated, service_role;
