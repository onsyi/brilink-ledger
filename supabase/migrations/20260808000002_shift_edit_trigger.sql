-- Protect closed shifts from financial-field edits.
-- Blocks changes to financial columns once a shift is closed, while still
-- allowing owner to edit non-financial fields (e.g. notes) AND to confirm a
-- deposit by setting deposit_amount to 0.
-- Idempotent: safe to re-run.

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
       OR (NEW.deposit_amount IS DISTINCT FROM OLD.deposit_amount AND NEW.deposit_amount <> 0)
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
