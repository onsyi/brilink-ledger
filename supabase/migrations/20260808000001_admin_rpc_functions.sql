-- Admin RPC functions for owner user management.
-- All three are SECURITY DEFINER (run as postgres) so they can touch auth.users.
-- A guard inside each function restricts execution to the owner role,
-- because SECURITY DEFINER bypasses RLS. Grants to anon/PUBLIC are revoked.

-- 1) admin_create_user: create auth user + profile + cashier role, return new user id
CREATE OR REPLACE FUNCTION public.admin_create_user(
  target_email TEXT,
  target_password TEXT,
  target_username TEXT DEFAULT NULL,
  target_full_name TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_user_id UUID;
  enc_password TEXT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat membuat akun kasir';
  END IF;

  enc_password := crypt(target_password, gen_salt('bf'));

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, recovery_sent_at, last_sign_in_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, email_change_token_new, email_change
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(),
    'authenticated', 'authenticated', target_email, enc_password,
    NOW(), NOW(), NOW(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    COALESCE(('{"username":"' || COALESCE(target_username, '') || '"}')::jsonb, '{}'::jsonb),
    NOW(), NOW(), '', '', ''
  )
  RETURNING id INTO new_user_id;

  INSERT INTO public.profiles (id, username, full_name)
  VALUES (new_user_id, target_username, target_full_name);

  INSERT INTO public.user_roles (user_id, role)
  VALUES (new_user_id, 'cashier');

  RETURN new_user_id;
END;
$$;

-- 2) admin_update_user_email: change a user's email + mark confirmed
CREATE OR REPLACE FUNCTION public.admin_update_user_email(
  target_user_id UUID,
  new_email TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat mengubah email';
  END IF;

  UPDATE auth.users
  SET
    email = new_email,
    raw_user_meta_data = COALESCE(raw_user_meta_data, '{}') || jsonb_build_object('email', new_email),
    updated_at = NOW()
  WHERE id = target_user_id;

  UPDATE auth.users
  SET email_confirmed_at = NOW()
  WHERE id = target_user_id AND email_confirmed_at IS NULL;
END;
$$;

-- 3) admin_delete_user: delete auth user (cascades to profiles & user_roles)
CREATE OR REPLACE FUNCTION public.admin_delete_user(
  target_user_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat menghapus user';
  END IF;

  DELETE FROM auth.users WHERE id = target_user_id;
END;
$$;

-- Revoke from anon / PUBLIC, allow only authenticated (guard enforces owner-only)
REVOKE ALL ON FUNCTION public.admin_create_user(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_update_user_email(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_delete_user(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_user(TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_user_email(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_user(UUID) TO authenticated, service_role;
