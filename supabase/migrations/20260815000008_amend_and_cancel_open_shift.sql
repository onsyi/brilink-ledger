-- Let a cashier correct or cancel their own OPEN shift.
--
-- Typos at opening are routine, but 20260815000002 revoked direct writes to
-- shifts / bank_balances / ppob_balances precisely because a cashier who can
-- rewrite initial_physical_balance can inflate Laba Fee by the whole opening
-- capital just before closing. Re-opening those grants would hand that back.
--
-- So the correction goes through a SECURITY DEFINER RPC that (a) only touches a
-- shift that is open and belongs to the caller, and (b) records what changed.
-- The cashier gets to fix mistakes; the owner keeps a trail showing that an
-- opening balance was amended, and from what to what.
--
-- Cancelling deletes the shift outright. That is safe today because a shift
-- cannot yet hold transactions (README 3.3 is unimplemented) -- the guard below
-- refuses once any exist, so this stays correct when that feature lands.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Audit trail for amendments and cancellations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shift_amendments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('amend', 'cancel')),
  before_data JSONB NOT NULL,
  after_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Deliberately no FK to shifts: a cancellation row must outlive the shift row
-- it describes, otherwise the cascade erases the very evidence of the deletion.
CREATE INDEX IF NOT EXISTS shift_amendments_shift_idx ON public.shift_amendments (shift_id);
CREATE INDEX IF NOT EXISTS shift_amendments_user_idx ON public.shift_amendments (user_id);

ALTER TABLE public.shift_amendments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.shift_amendments FROM anon, authenticated;
GRANT SELECT ON public.shift_amendments TO authenticated;
GRANT ALL ON public.shift_amendments TO service_role;

DROP POLICY IF EXISTS "amendments_select" ON public.shift_amendments;
CREATE POLICY "amendments_select" ON public.shift_amendments FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'owner'));

-- Writes happen only inside the SECURITY DEFINER functions below; there is no
-- INSERT policy, so a client cannot forge or suppress a trail entry.

-- ---------------------------------------------------------------------------
-- 2) Amend an open shift's opening figures
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.amend_open_shift(
  _shift_id UUID,
  _initial_cash NUMERIC,
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
  _shift public.shifts%ROWTYPE;
  _before JSONB;
BEGIN
  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id;
  IF _shift.id IS NULL THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;
  IF _shift.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Hanya dapat mengubah shift milik sendiri';
  END IF;
  IF _shift.status <> 'open' THEN
    RAISE EXCEPTION 'Shift sudah ditutup — tidak dapat diubah lagi';
  END IF;
  IF COALESCE(_initial_cash, 0) < 0 THEN
    RAISE EXCEPTION 'Saldo Tunai Awal Buka Kasir tidak boleh negatif';
  END IF;

  _before := jsonb_build_object(
    'initial_physical_balance', _shift.initial_physical_balance,
    'modal_awal', _shift.modal_awal,
    'bank', (SELECT COALESCE(jsonb_object_agg(bank_name, initial_amount), '{}'::jsonb)
             FROM public.bank_balances WHERE shift_id = _shift_id),
    'ppob', (SELECT COALESCE(jsonb_object_agg(provider_name, initial_amount), '{}'::jsonb)
             FROM public.ppob_balances WHERE shift_id = _shift_id)
  );

  FOR _bank IN SELECT * FROM jsonb_to_recordset(_bank_snapshots) AS x(bank_name TEXT, initial_amount NUMERIC)
  LOOP
    IF COALESCE(_bank.initial_amount, 0) < 0 THEN
      RAISE EXCEPTION 'Saldo awal % tidak boleh negatif', _bank.bank_name;
    END IF;
    INSERT INTO public.bank_balances (shift_id, bank_name, initial_amount)
    VALUES (_shift_id, _bank.bank_name, COALESCE(_bank.initial_amount, 0))
    ON CONFLICT (shift_id, bank_name) DO UPDATE SET initial_amount = EXCLUDED.initial_amount;
    _bank_total := _bank_total + COALESCE(_bank.initial_amount, 0);
  END LOOP;

  FOR _ppob IN SELECT * FROM jsonb_to_recordset(_ppob_snapshots) AS x(provider_name TEXT, initial_amount NUMERIC)
  LOOP
    IF COALESCE(_ppob.initial_amount, 0) < 0 THEN
      RAISE EXCEPTION 'Saldo awal % tidak boleh negatif', _ppob.provider_name;
    END IF;
    INSERT INTO public.ppob_balances (shift_id, provider_name, initial_amount)
    VALUES (_shift_id, _ppob.provider_name, COALESCE(_ppob.initial_amount, 0))
    ON CONFLICT (shift_id, provider_name) DO UPDATE SET initial_amount = EXCLUDED.initial_amount;
    _ppob_total := _ppob_total + COALESCE(_ppob.initial_amount, 0);
  END LOOP;

  _modal_awal := COALESCE(_initial_cash, 0) + _bank_total + _ppob_total;

  UPDATE public.shifts
  SET initial_physical_balance = COALESCE(_initial_cash, 0),
      modal_awal = _modal_awal
  WHERE id = _shift_id;

  INSERT INTO public.shift_amendments (shift_id, user_id, action, before_data, after_data)
  VALUES (
    _shift_id, auth.uid(), 'amend', _before,
    jsonb_build_object(
      'initial_physical_balance', COALESCE(_initial_cash, 0),
      'modal_awal', _modal_awal,
      'bank', (SELECT COALESCE(jsonb_object_agg(bank_name, initial_amount), '{}'::jsonb)
               FROM public.bank_balances WHERE shift_id = _shift_id),
      'ppob', (SELECT COALESCE(jsonb_object_agg(provider_name, initial_amount), '{}'::jsonb)
               FROM public.ppob_balances WHERE shift_id = _shift_id)
    )
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) Cancel an open shift
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

-- ---------------------------------------------------------------------------
-- 4) Permissions
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.amend_open_shift(UUID, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.amend_open_shift(UUID, NUMERIC, JSONB, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.cancel_open_shift(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_open_shift(UUID) TO authenticated, service_role;
