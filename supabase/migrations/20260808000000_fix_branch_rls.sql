-- Fix Branch RLS Policy for Cashiers
-- Allow cashiers to read active branches OR their own assigned branch even if inactive.
-- Idempotent: safe to re-run.

DROP POLICY IF EXISTS "Cashiers can view active branches" ON public.branches;
DROP POLICY IF EXISTS "Cashiers can view active or assigned branches" ON public.branches;

CREATE POLICY "Cashiers can view active or assigned branches"
  ON public.branches FOR SELECT
  USING (
    (
      is_active = true
      OR id IN (SELECT branch_id FROM public.profiles WHERE id = auth.uid())
    )
    AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid())
  );
