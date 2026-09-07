-- Guard shift concurrency and prevent cancellation of rejected shifts awaiting revision
--
-- 1. In open_shift_atomic:
--    - Verify branch is active (branches.is_active = true)
--    - Prevent concurrent open shifts in the same branch
--
-- 2. In cancel_open_shift:
--    - Disallow cancelling shifts where rejected_at IS NOT NULL (shifts that owner returned for correction)

-- ---------------------------------------------------------------------------
-- 1) open_shift_atomic update
-- ---------------------------------------------------------------------------
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
  _resolved_branch UUID;
  _is_active BOOLEAN;
  _branch_active BOOLEAN;
BEGIN
  IF _user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Hanya dapat membuka shift untuk akun sendiri';
  END IF;

  IF EXISTS (SELECT 1 FROM public.shifts WHERE user_id = _user_id AND status = 'open') THEN
    RAISE EXCEPTION 'Masih ada shift aktif di akun ini. Tutup dulu shift tersebut.';
  END IF;

  -- Authoritative source: the cashier's own profile, not the request body.
  SELECT branch_id, is_active INTO _resolved_branch, _is_active
  FROM public.profiles WHERE id = _user_id;

  IF NOT COALESCE(_is_active, true) THEN
    RAISE EXCEPTION 'Akun Anda dinonaktifkan. Hubungi owner.';
  END IF;
  IF _resolved_branch IS NULL THEN
    RAISE EXCEPTION 'Akun belum terdaftar di cabang manapun. Hubungi owner.';
  END IF;

  SELECT is_active INTO _branch_active
  FROM public.branches WHERE id = _resolved_branch;

  IF NOT COALESCE(_branch_active, true) THEN
    RAISE EXCEPTION 'Cabang ini dinonaktifkan. Hubungi owner.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.shifts WHERE branch_id = _resolved_branch AND status = 'open') THEN
    RAISE EXCEPTION 'Masih ada shift aktif di cabang ini. Tunggu kasir sebelumnya menutup shift.';
  END IF;

  IF COALESCE(_initial_cash, 0) < 0 THEN
    RAISE EXCEPTION 'Modal awal tidak boleh negatif';
  END IF;

  FOR _bank IN SELECT * FROM jsonb_to_recordset(_bank_snapshots) AS x(bank_name TEXT, initial_amount NUMERIC)
  LOOP
    IF COALESCE(_bank.initial_amount, 0) < 0 THEN
      RAISE EXCEPTION 'Saldo awal % tidak boleh negatif', _bank.bank_name;
    END IF;
    _bank_total := _bank_total + COALESCE(_bank.initial_amount, 0);
  END LOOP;

  FOR _ppob IN SELECT * FROM jsonb_to_recordset(_ppob_snapshots) AS x(provider_name TEXT, initial_amount NUMERIC)
  LOOP
    IF COALESCE(_ppob.initial_amount, 0) < 0 THEN
      RAISE EXCEPTION 'Saldo awal % tidak boleh negatif', _ppob.provider_name;
    END IF;
    _ppob_total := _ppob_total + COALESCE(_ppob.initial_amount, 0);
  END LOOP;

  PERFORM public.assert_opening_continuity(
    public.previous_closed_shift_id(_resolved_branch, _user_id),
    _bank_snapshots,
    _ppob_snapshots
  );

  _modal_awal := COALESCE(_initial_cash, 0) + _bank_total + _ppob_total;

  INSERT INTO public.shifts (user_id, branch_id, initial_physical_balance, additional_capital, modal_awal, status)
  VALUES (_user_id, _resolved_branch, COALESCE(_initial_cash, 0), 0, _modal_awal, 'open')
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

REVOKE ALL ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, JSONB, JSONB) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) cancel_open_shift update
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cancel_open_shift(_shift_id UUID)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _shift public.shifts%ROWTYPE;
  _txn_count INT;
BEGIN
  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id;
  IF _shift.id IS NULL THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;
  IF _shift.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Hanya dapat membatalkan shift milik sendiri';
  END IF;
  IF _shift.status <> 'open' THEN
    RAISE EXCEPTION 'Shift sudah ditutup — tidak dapat dibatalkan';
  END IF;
  IF _shift.rejected_at IS NOT NULL THEN
    RAISE EXCEPTION 'Laporan shift ini ditolak owner untuk diperbaiki — tidak dapat dibatalkan';
  END IF;

  SELECT count(*) INTO _txn_count FROM public.transactions WHERE shift_id = _shift_id;
  IF _txn_count > 0 THEN
    RAISE EXCEPTION 'Shift sudah punya % transaksi — tutup shift, jangan dibatalkan', _txn_count;
  END IF;

  INSERT INTO public.shift_amendments (shift_id, user_id, action, before_data, after_data)
  VALUES (
    _shift_id, auth.uid(), 'cancel',
    jsonb_build_object(
      'start_time', _shift.start_time,
      'branch_id', _shift.branch_id,
      'initial_physical_balance', _shift.initial_physical_balance,
      'modal_awal', _shift.modal_awal,
      'bank', (SELECT COALESCE(jsonb_object_agg(bank_name, initial_amount), '{}'::jsonb)
               FROM public.bank_balances WHERE shift_id = _shift_id),
      'ppob', (SELECT COALESCE(jsonb_object_agg(provider_name, initial_amount), '{}'::jsonb)
               FROM public.ppob_balances WHERE shift_id = _shift_id)
    ),
    NULL
  );

  DELETE FROM public.shifts WHERE id = _shift_id;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_open_shift(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_open_shift(UUID) TO authenticated, service_role;
