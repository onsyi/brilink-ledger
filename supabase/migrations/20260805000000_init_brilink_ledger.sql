-- ============================================
-- BRILink Ledger - Complete Database Schema
-- Jalankan di Supabase Dashboard > SQL Editor
-- ============================================

-- Enums
CREATE TYPE public.app_role AS ENUM ('owner','cashier');
CREATE TYPE public.shift_status AS ENUM ('open','closed');
CREATE TYPE public.receivable_status AS ENUM ('pending','paid');
CREATE TYPE public.txn_type AS ENUM ('tarik_tunai','setor_tunai','transfer','ppob');

-- Profiles
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- User Roles
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Helper function
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

-- RLS Policies: profiles
CREATE POLICY "profiles_select_own_or_owner" ON public.profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.has_role(auth.uid(),'owner'));
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.has_role(auth.uid(),'owner'))
  WITH CHECK (id = auth.uid() OR public.has_role(auth.uid(),'owner'));

-- RLS Policies: user_roles
CREATE POLICY "roles_select_own_or_owner" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(),'owner'));

-- Auto-create profile + role on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE first_user BOOLEAN;
BEGIN
  INSERT INTO public.profiles (id, username, full_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email,'@',1)), NEW.raw_user_meta_data->>'full_name');

  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles) INTO first_user;
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, CASE WHEN first_user THEN 'owner'::public.app_role ELSE 'cashier'::public.app_role END);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Shifts
CREATE TABLE IF NOT EXISTS public.shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  start_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  end_time TIMESTAMPTZ,
  initial_physical_balance NUMERIC(16,2) NOT NULL DEFAULT 0,
  final_physical_balance NUMERIC(16,2),
  total_expenses NUMERIC(16,2) NOT NULL DEFAULT 0,
  topup_request NUMERIC(16,2) NOT NULL DEFAULT 0,
  deposit_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
  expense_notes TEXT,
  status public.shift_status NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_user ON public.shifts (user_id) WHERE status = 'open';
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shifts TO authenticated;
GRANT ALL ON public.shifts TO service_role;
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "shifts_select" ON public.shifts FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(),'owner'));
CREATE POLICY "shifts_insert" ON public.shifts FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "shifts_update" ON public.shifts FOR UPDATE TO authenticated
  USING ((user_id = auth.uid() AND status = 'open') OR public.has_role(auth.uid(),'owner'))
  WITH CHECK (user_id = auth.uid() OR public.has_role(auth.uid(),'owner'));
CREATE POLICY "shifts_delete_owner" ON public.shifts FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(),'owner'));

-- Shift helper functions
CREATE OR REPLACE FUNCTION public.shift_is_writable(_shift_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.id = _shift_id
      AND (public.has_role(auth.uid(),'owner') OR (s.user_id = auth.uid() AND s.status = 'open'))
  )
$$;

CREATE OR REPLACE FUNCTION public.shift_is_readable(_shift_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.id = _shift_id
      AND (public.has_role(auth.uid(),'owner') OR s.user_id = auth.uid())
  )
$$;

-- Transactions
CREATE TABLE IF NOT EXISTS public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  transaction_type public.txn_type NOT NULL,
  source_account TEXT NOT NULL,
  destination_account TEXT NOT NULL,
  principal_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
  customer_fee NUMERIC(16,2) NOT NULL DEFAULT 0,
  provider_cost NUMERIC(16,2) NOT NULL DEFAULT 0,
  profit_net NUMERIC(16,2) GENERATED ALWAYS AS (customer_fee - provider_cost) STORED,
  note TEXT,
  client_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS transactions_idempotency ON public.transactions (shift_id, client_ref) WHERE client_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS transactions_shift_idx ON public.transactions (shift_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transactions TO authenticated;
GRANT ALL ON public.transactions TO service_role;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "txn_select" ON public.transactions FOR SELECT TO authenticated USING (public.shift_is_readable(shift_id));
CREATE POLICY "txn_insert" ON public.transactions FOR INSERT TO authenticated WITH CHECK (public.shift_is_writable(shift_id));
CREATE POLICY "txn_update" ON public.transactions FOR UPDATE TO authenticated USING (public.shift_is_writable(shift_id)) WITH CHECK (public.shift_is_writable(shift_id));
CREATE POLICY "txn_delete" ON public.transactions FOR DELETE TO authenticated USING (public.shift_is_writable(shift_id));

-- Bank Balances
CREATE TABLE IF NOT EXISTS public.bank_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL,
  final_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shift_id, bank_name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bank_balances TO authenticated;
GRANT ALL ON public.bank_balances TO service_role;
ALTER TABLE public.bank_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bank_select" ON public.bank_balances FOR SELECT TO authenticated USING (public.shift_is_readable(shift_id));
CREATE POLICY "bank_insert" ON public.bank_balances FOR INSERT TO authenticated WITH CHECK (public.shift_is_writable(shift_id));
CREATE POLICY "bank_update" ON public.bank_balances FOR UPDATE TO authenticated USING (public.shift_is_writable(shift_id)) WITH CHECK (public.shift_is_writable(shift_id));
CREATE POLICY "bank_delete" ON public.bank_balances FOR DELETE TO authenticated USING (public.shift_is_writable(shift_id));

-- PPOB Balances
CREATE TABLE IF NOT EXISTS public.ppob_balances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  provider_name TEXT NOT NULL,
  final_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shift_id, provider_name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ppob_balances TO authenticated;
GRANT ALL ON public.ppob_balances TO service_role;
ALTER TABLE public.ppob_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ppob_select" ON public.ppob_balances FOR SELECT TO authenticated USING (public.shift_is_readable(shift_id));
CREATE POLICY "ppob_insert" ON public.ppob_balances FOR INSERT TO authenticated WITH CHECK (public.shift_is_writable(shift_id));
CREATE POLICY "ppob_update" ON public.ppob_balances FOR UPDATE TO authenticated USING (public.shift_is_writable(shift_id)) WITH CHECK (public.shift_is_writable(shift_id));
CREATE POLICY "ppob_delete" ON public.ppob_balances FOR DELETE TO authenticated USING (public.shift_is_writable(shift_id));

-- Receivables
CREATE TABLE IF NOT EXISTS public.receivables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES public.transactions(id) ON DELETE SET NULL,
  shift_id UUID NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  debt_amount NUMERIC(16,2) NOT NULL,
  due_date DATE,
  status public.receivable_status NOT NULL DEFAULT 'pending',
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receivables_shift_idx ON public.receivables (shift_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.receivables TO authenticated;
GRANT ALL ON public.receivables TO service_role;
ALTER TABLE public.receivables ENABLE ROW LEVEL SECURITY;
CREATE POLICY "recv_select" ON public.receivables FOR SELECT TO authenticated USING (public.shift_is_readable(shift_id));
CREATE POLICY "recv_insert" ON public.receivables FOR INSERT TO authenticated WITH CHECK (public.shift_is_writable(shift_id));
CREATE POLICY "recv_update" ON public.receivables FOR UPDATE TO authenticated
  USING (public.shift_is_readable(shift_id)) WITH CHECK (public.shift_is_readable(shift_id));
CREATE POLICY "recv_delete_owner" ON public.receivables FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'owner'));

-- Enable Realtime (optional)
ALTER PUBLICATION supabase_realtime ADD TABLE public.shifts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.receivables;
