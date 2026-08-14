-- Backfill legacy shifts (opened before the capital model) so reports are
-- consistent under "Laba = modal akhir - modal awal".
-- Legacy shifts only recorded physical cash as opening capital, and never
-- stored modal_awal/modal_akhir.

ALTER TABLE public.shifts DISABLE TRIGGER trg_prevent_closed_shift_edit;

-- modal_awal: opening capital was just the physical cash.
UPDATE public.shifts
SET modal_awal = initial_physical_balance
WHERE modal_awal IS NULL;

-- modal_akhir: gross final capital = final cash + final bank + final PPOB.
UPDATE public.shifts s
SET modal_akhir = COALESCE(s.final_physical_balance, 0)
  + COALESCE((SELECT SUM(bb.final_amount) FROM public.bank_balances bb WHERE bb.shift_id = s.id), 0)
  + COALESCE((SELECT SUM(pb.final_amount) FROM public.ppob_balances pb WHERE pb.shift_id = s.id), 0)
WHERE s.status = 'closed' AND s.modal_akhir IS NULL;

ALTER TABLE public.shifts ENABLE TRIGGER trg_prevent_closed_shift_edit;
