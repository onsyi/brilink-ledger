-- Let the owner correct a bank or PPOB balance on any shift, including closed
-- ones, with a mandatory reason and a full trail.
--
-- Until now nobody could: 20260815000006 left authenticated with SELECT only on
-- bank_balances / ppob_balances, and every writing RPC refuses a shift that is
-- not open. That lock is what stops a cashier faking profit, so it stays --
-- the owner gets a separate, audited door rather than the lock being removed.
--
-- Two things this has to get right beyond the UPDATE itself:
--
--   1. modal_awal and modal_akhir are STORED on shifts, not derived at read
--      time. Changing a balance without recomputing them leaves the report
--      contradicting itself -- per-account rows saying one thing, the capital
--      totals and Laba Fee saying another, with nothing to flag it.
--
--   2. prevent_closed_shift_financial_edit() blocks writes to those very
--      columns once a shift is closed. Rather than dropping the guard, it now
--      honours a transaction-local override that only this function sets.
--      set_config() is not reachable through PostgREST, and UPDATE on shifts is
--      revoked from clients anyway, so the override cannot be forged.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Allow the new action in the amendment trail
-- ---------------------------------------------------------------------------
ALTER TABLE public.shift_amendments DROP CONSTRAINT IF EXISTS shift_amendments_action_check;
ALTER TABLE public.shift_amendments
  ADD CONSTRAINT shift_amendments_action_check
  CHECK (action IN ('amend', 'cancel', 'audit'));

-- ---------------------------------------------------------------------------
-- 2) Teach the closed-shift guard about the audited override
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_closed_shift_financial_edit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Set only inside owner_adjust_balance(), and only for the duration of that
  -- transaction. Everything else still hits the wall below.
  IF current_setting('brilink.audit_override', true) = 'on' THEN
    RETURN NEW;
  END IF;

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

-- ---------------------------------------------------------------------------
-- 3) The audit function
-- ---------------------------------------------------------------------------
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

REVOKE ALL ON FUNCTION public.owner_adjust_balance(UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_adjust_balance(UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO authenticated, service_role;
