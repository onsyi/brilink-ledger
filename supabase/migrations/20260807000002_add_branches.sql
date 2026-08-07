-- Create branches table
CREATE TABLE IF NOT EXISTS public.branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Add branch_id to profiles (nullable for backward compatibility)
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;

-- Add branch_id to shifts (nullable for backward compatibility)
ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id) ON DELETE SET NULL;

-- RLS: owners can manage branches, cashiers can read their branch
ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;

-- Owner full access
CREATE POLICY "Owner can manage branches"
  ON public.branches FOR ALL
  USING (public.has_role(auth.uid(), 'owner'::public.app_role));

-- Cashiers can read active branches
CREATE POLICY "Cashiers can view active branches"
  ON public.branches FOR SELECT
  USING (
    is_active = true
    AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid())
  );

-- Update shift_is_readable to include branch context
CREATE OR REPLACE FUNCTION public.shift_is_readable(_shift_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.id = _shift_id
      AND (public.has_role(auth.uid(),'owner') OR s.user_id = auth.uid())
  )
$$;

-- Create index for branch lookups
CREATE INDEX IF NOT EXISTS idx_profiles_branch_id ON public.profiles(branch_id);
CREATE INDEX IF NOT EXISTS idx_shifts_branch_id ON public.shifts(branch_id);
