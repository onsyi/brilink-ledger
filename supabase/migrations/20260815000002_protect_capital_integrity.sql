-- Protect the capital baseline (modal awal / modal akhir) from client tampering.
--
-- Three related holes, all in the "a cashier can rewrite their own numbers" family:
--
--   1. The shifts_update policy allowed a cashier to UPDATE *any* column of their
--      own open shift. Because prevent_closed_shift_financial_edit() only fires
--      when OLD.status = 'closed', a cashier could PATCH
--      /shifts?id=eq.<own> {"initial_physical_balance": 0} before closing, which
--      inflates Laba Fee by the entire opening cash. bank_balances.initial_amount
--      was writable the same way via shift_is_writable(). The close/open RPCs
--      were therefore advisory only.
--
--   2. 20260814000004 recreated prevent_closed_shift_financial_edit() and dropped
--      the additional_capital / modal_awal / modal_akhir checks that
--      20260814000000 had added, so those stayed editable after close.
--
--   3. open_shift_atomic() trusted the client-supplied _branch_id, and
--      profiles_update_own let a cashier change their own profiles.branch_id,
--      so shifts could be attributed to any branch.
--
-- The fix is layered: column-level GRANTs (enforced by Postgres core, not app
-- logic) + tightened RLS + a restored trigger. The RPCs are SECURITY DEFINER and
-- run as the table owner, so revoking client privileges does not affect them.
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Only the RPCs may write shift financials. Clients keep exactly one column:
--    deposit_confirmed, which the owner toggles from the Setoran page.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE ON public.shifts FROM authenticated;
GRANT UPDATE (deposit_confirmed) ON public.shifts TO authenticated;

DROP POLICY IF EXISTS "shifts_update" ON public.shifts;
CREATE POLICY "shifts_update" ON public.shifts FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

-- shifts_insert is now unreachable for clients (INSERT revoked above); open_shift_atomic
-- is the only path. Kept so the policy set stays self-describing.
DROP POLICY IF EXISTS "shifts_insert" ON public.shifts;
CREATE POLICY "shifts_insert" ON public.shifts FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2) Balance snapshots are written exclusively by open_shift_atomic /
--    close_shift_atomic. Clients read only.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON public.bank_balances FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.ppob_balances FROM authenticated;

-- ---------------------------------------------------------------------------
-- 3) Restore the full closed-shift guard (regression from 20260814000004),
--    now covering every monetary column plus the lifecycle fields.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_closed_shift_financial_edit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    IF NEW.initial_physical_balance IS DISTINCT FROM OLD.initial_physical_balance
       OR NEW.final_physical_balance IS DISTINCT FROM OLD.final_physical_balance
       OR NEW.additional_capital     IS DISTINCT FROM OLD.additional_capital
       OR NEW.modal_awal             IS DISTINCT FROM OLD.modal_awal
       OR NEW.modal_akhir            IS DISTINCT FROM OLD.modal_akhir
       OR NEW.total_expenses         IS DISTINCT FROM OLD.total_expenses
       OR NEW.topup_request          IS DISTINCT FROM OLD.topup_request
       OR NEW.deposit_amount         IS DISTINCT FROM OLD.deposit_amount
       OR NEW.settlement_amount      IS DISTINCT FROM OLD.settlement_amount
       OR NEW.expense_notes          IS DISTINCT FROM OLD.expense_notes
       OR NEW.user_id                IS DISTINCT FROM OLD.user_id
       OR NEW.branch_id              IS DISTINCT FROM OLD.branch_id
       OR NEW.start_time             IS DISTINCT FROM OLD.start_time
       OR NEW.end_time               IS DISTINCT FROM OLD.end_time
       OR NEW.status                 IS DISTINCT FROM OLD.status
    THEN
      RAISE EXCEPTION 'Tidak boleh mengubah data keuangan shift yang sudah ditutup';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_closed_shift_edit ON public.shifts;
CREATE TRIGGER trg_prevent_closed_shift_edit
  BEFORE UPDATE ON public.shifts
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_closed_shift_financial_edit();

-- ---------------------------------------------------------------------------
-- 4) Branch assignment is an owner-only decision.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profile_branch_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id
     AND NOT public.has_role(auth.uid(), 'owner')
  THEN
    RAISE EXCEPTION 'Hanya owner yang dapat mengubah cabang';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_profile_branch ON public.profiles;
CREATE TRIGGER trg_guard_profile_branch
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_branch_change();

-- ---------------------------------------------------------------------------
-- 5) open_shift_atomic derives the branch server-side instead of trusting the
--    client. _branch_id is retained for signature compatibility but ignored.
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
BEGIN
  IF _user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Hanya dapat membuka shift untuk akun sendiri';
  END IF;

  IF EXISTS (SELECT 1 FROM public.shifts WHERE user_id = _user_id AND status = 'open') THEN
    RAISE EXCEPTION 'Masih ada shift aktif di akun ini. Tutup dulu shift tersebut.';
  END IF;

  -- Authoritative source: the cashier's assigned branch, not the request body.
  SELECT branch_id INTO _resolved_branch FROM public.profiles WHERE id = _user_id;
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

REVOKE ALL ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, JSONB, JSONB) TO authenticated, service_role;
