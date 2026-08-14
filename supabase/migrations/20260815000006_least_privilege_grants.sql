-- Reduce table privileges to what each role actually uses.
--
-- Supabase's default privileges hand `anon` and `authenticated` ALL on every
-- table created in public. The explicit GRANTs in the initial schema (e.g.
-- "GRANT SELECT ON public.user_roles TO authenticated") added to that default
-- rather than replacing it, so the real state was far wider than intended:
--
--   anon          | shifts | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--   authenticated | user_roles | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
--
-- Two problems follow.
--
-- 1. TRUNCATE is not filtered by RLS -- row policies simply do not apply to it.
--    It is not reachable through PostgREST, which only issues SELECT / INSERT /
--    UPDATE / DELETE, so this was latent rather than live; but no client role
--    has any reason to hold it.
--
-- 2. Everything else was resting entirely on RLS. `authenticated` holding
--    INSERT on user_roles is safe only because that table happens to have no
--    INSERT policy -- one permissive policy added later and a cashier could
--    grant themselves 'owner'. Privileges and RLS should both have to agree.
--
-- `anon` is stripped completely: no policy in this schema grants it anything,
-- and the app never reads a table before signing in (the login screen talks to
-- GoTrue, not PostgREST).
--
-- Column-level UPDATE grants from 20260815000002 / 20260815000003 /
-- 20260815000005 are re-asserted at the end, because REVOKE ALL drops them too.
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Start from zero for both client roles.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles','user_roles','shifts','transactions',
    'receivables','bank_balances','ppob_balances','branches'
  ] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Grant back exactly what the application performs, leaving RLS to decide
--    which rows are in scope.
-- ---------------------------------------------------------------------------

-- profiles: read own/all (RLS), edit own name, owner assigns branch and
-- activation. Rows are created by handle_new_user() and removed by cascade.
GRANT SELECT ON public.profiles TO authenticated;
GRANT UPDATE (username, full_name, branch_id, is_active) ON public.profiles TO authenticated;

-- user_roles: read only. Role assignment happens in SECURITY DEFINER functions.
GRANT SELECT ON public.user_roles TO authenticated;

-- shifts: open/close go through the atomic RPCs; deposit_confirmed is the one
-- column a client writes directly. DELETE stays for the owner-only policy.
GRANT SELECT, DELETE ON public.shifts TO authenticated;
GRANT UPDATE (deposit_confirmed) ON public.shifts TO authenticated;

-- transactions: full CRUD, scoped by shift_is_writable() (README 3.3).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transactions TO authenticated;

-- receivables: created on an open shift, settled later via status only.
GRANT SELECT, INSERT, DELETE ON public.receivables TO authenticated;
GRANT UPDATE (status) ON public.receivables TO authenticated;

-- balance snapshots: written only by open_shift_atomic / close_shift_atomic.
GRANT SELECT ON public.bank_balances TO authenticated;
GRANT SELECT ON public.ppob_balances TO authenticated;

-- branches: owner-managed through RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.branches TO authenticated;

-- service_role keeps unrestricted access for server-side tooling.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- ---------------------------------------------------------------------------
-- 3) Stop future tables inheriting ALL, so a new table has to opt in.
--    Mirrors auto_expose_new_tables = false, the current Supabase default.
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;
