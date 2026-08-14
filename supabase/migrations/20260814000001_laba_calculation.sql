-- Refine capital semantics: modal_akhir now stores GROSS final capital
-- (final physical + final bank + final PPOB). Laba = modal_akhir - modal_awal
-- and is computed in the application layer.
--
-- Previously modal_akhir stored the net (final assets - modal_awal).

-- 1) Recreate close-shift RPC to store gross modal_akhir
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

-- 2) Backfill: convert previously-stored net modal_akhir to gross.
--    Old value = final assets - modal_awal, so gross = old + modal_awal.
--    Temporarily disable the closed-shift edit guard (it protects against
--    app-level edits, not migration backfills).
ALTER TABLE public.shifts DISABLE TRIGGER trg_prevent_closed_shift_edit;
UPDATE public.shifts
SET modal_akhir = modal_akhir + COALESCE(modal_awal, initial_physical_balance)
WHERE status = 'closed' AND modal_akhir IS NOT NULL;
ALTER TABLE public.shifts ENABLE TRIGGER trg_prevent_closed_shift_edit;

-- 3) Re-assert grants
REVOKE ALL ON FUNCTION public.close_shift_atomic(UUID, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_shift_atomic(UUID, NUMERIC, NUMERIC, TEXT, NUMERIC, NUMERIC, JSONB, JSONB) TO authenticated, service_role;
