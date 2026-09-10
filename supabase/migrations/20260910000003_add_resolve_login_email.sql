-- Migration: resolve_login_email
-- Allows users (owner or cashier) to log in using either their username or email.

CREATE OR REPLACE FUNCTION public.resolve_login_email(identifier TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  _email TEXT;
BEGIN
  IF identifier IS NULL OR trim(identifier) = '' THEN
    RETURN NULL;
  END IF;

  -- If it contains '@', check auth.users directly
  IF identifier LIKE '%@%' THEN
    SELECT email INTO _email FROM auth.users WHERE lower(email) = lower(trim(identifier)) LIMIT 1;
    RETURN COALESCE(_email, trim(identifier));
  END IF;

  -- Look up by profile username
  SELECT u.email INTO _email
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE lower(p.username) = lower(trim(identifier))
  LIMIT 1;

  RETURN COALESCE(_email, trim(identifier));
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_login_email(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_login_email(TEXT) TO anon, authenticated, service_role;