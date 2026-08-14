-- Make receivable amounts immutable once recorded.
--
-- The recv_update policy uses shift_is_readable() rather than
-- shift_is_writable(), which is deliberate: a debt must stay settleable long
-- after the shift that created it has closed. The side effect was that a
-- cashier could also rewrite customer_name, debt_amount and due_date on a
-- closed shift, so the "closed shifts are locked" guarantee that
-- prevent_closed_shift_financial_edit provides for shifts did not extend to
-- the money owed to the outlet.
--
-- Settling a debt only ever needs to move `status`. Everything else is fixed at
-- INSERT time, which still requires shift_is_writable() — i.e. your own open
-- shift. paid_at is stamped server-side so the timestamp cannot be back-dated.
--
-- Note: the receivables feature has no UI yet (README 3.3 is unimplemented);
-- this hardens the table ahead of that work rather than fixing a live path.
-- Idempotent: safe to re-run.

REVOKE UPDATE ON public.receivables FROM authenticated;
GRANT UPDATE (status) ON public.receivables TO authenticated;

CREATE OR REPLACE FUNCTION public.stamp_receivable_paid_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' THEN
    NEW.paid_at := NOW();
  ELSIF NEW.status IS DISTINCT FROM 'paid' THEN
    NEW.paid_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_receivable_paid_at ON public.receivables;
CREATE TRIGGER trg_stamp_receivable_paid_at
  BEFORE UPDATE ON public.receivables
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_receivable_paid_at();
