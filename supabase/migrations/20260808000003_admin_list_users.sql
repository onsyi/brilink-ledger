-- Admin RPC to list all users with their emails.
-- Emails live in auth.users (not readable via RLS from the client), so a
-- SECURITY DEFINER function owned by postgres exposes them to the owner.
-- Owner-only guard because SECURITY DEFINER bypasses RLS.

CREATE OR REPLACE FUNCTION public.admin_list_users()
RETURNS TABLE (
  id uuid,
  email text,
  username text,
  full_name text,
  created_at timestamptz,
  branch_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat melihat daftar pengguna';
  END IF;

  RETURN QUERY
  SELECT p.id, u.email::text, p.username, p.full_name, p.created_at, p.branch_id
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  ORDER BY p.username;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_users() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_users() TO authenticated, service_role;
