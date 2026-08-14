-- Replace destructive account deletion with deactivation.
--
-- admin_delete_user() ran `DELETE FROM auth.users`, and shifts.user_id is
-- declared REFERENCES auth.users(id) ON DELETE CASCADE. Removing one cashier
-- therefore cascaded through shifts -> transactions / receivables /
-- bank_balances / ppob_balances and destroyed that cashier's entire audit
-- trail — the opposite of what this application exists to do. The settings
-- dialog even promised the data would be kept.
--
-- Deactivation keeps every row, keeps the cashier's name resolvable in reports,
-- and is reversible. Login is blocked at the GoTrue level via banned_until.
-- Idempotent: safe to re-run.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- is_active must not be self-servable: a deactivated cashier still holds a
-- valid access token for up to jwt_expiry and could otherwise re-enable itself.
-- Column-level privileges are enforced by Postgres core, ahead of RLS.
REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT UPDATE (username, full_name, branch_id) ON public.profiles TO authenticated;

-- ---------------------------------------------------------------------------
-- Deactivate / reactivate
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_set_user_active(
  target_user_id UUID,
  active BOOLEAN
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat mengubah status akun';
  END IF;
  IF target_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Tidak dapat mengubah status akun sendiri';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = target_user_id) THEN
    RAISE EXCEPTION 'Pengguna tidak ditemukan';
  END IF;
  -- Guards against locking the business out of its own owner account.
  IF NOT active AND public.has_role(target_user_id, 'owner') THEN
    RAISE EXCEPTION 'Akun owner tidak dapat dinonaktifkan';
  END IF;

  UPDATE public.profiles SET is_active = active WHERE id = target_user_id;

  -- A finite far-future timestamp rather than 'infinity': GoTrue parses this
  -- column into a Go time.Time and infinity is not reliably representable.
  UPDATE auth.users
  SET banned_until = CASE WHEN active THEN NULL ELSE NOW() + interval '100 years' END,
      updated_at   = NOW()
  WHERE id = target_user_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Hard delete is retired. Kept as a callable stub so any cached client build
-- gets an explanation instead of either a 404 or a cascading delete.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_delete_user(
  target_user_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Penghapusan akun dinonaktifkan karena akan menghapus seluruh shift dan transaksi milik akun tersebut. Gunakan fitur "Nonaktifkan" (admin_set_user_active).';
END;
$$;

-- ---------------------------------------------------------------------------
-- Expose is_active to the owner's user list
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_list_users();
CREATE FUNCTION public.admin_list_users()
RETURNS TABLE (
  id uuid,
  email text,
  username text,
  full_name text,
  created_at timestamptz,
  branch_id uuid,
  is_active boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat melihat daftar pengguna';
  END IF;

  RETURN QUERY
  SELECT p.id, u.email::text, p.username, p.full_name, p.created_at, p.branch_id, p.is_active
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  ORDER BY p.is_active DESC, p.username;
END;
$$;

-- ---------------------------------------------------------------------------
-- A deactivated cashier must not be able to start new work with a still-valid
-- access token. Closing is deliberately still allowed, so deactivating someone
-- mid-shift cannot strand an open shift.
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

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_set_user_active(UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_delete_user(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_list_users() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_active(UUID, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, JSONB, JSONB) TO authenticated, service_role;
