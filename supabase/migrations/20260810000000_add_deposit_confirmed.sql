-- Add deposit_confirmed flag to shifts so the audit trail preserves the
-- original deposit_amount after the owner confirms receipt. Previously,
-- confirming set deposit_amount=0, which destroyed historical data.
-- Idempotent: safe to re-run.

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS deposit_confirmed boolean NOT NULL DEFAULT false;

-- Backfill: any shift that already has deposit_amount zeroed out likely
-- had its deposit confirmed before this column existed.
UPDATE public.shifts
SET deposit_confirmed = true
WHERE deposit_amount = 0 AND end_time IS NOT NULL AND status = 'closed';
