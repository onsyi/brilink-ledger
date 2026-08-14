-- Fix the owner-facing user-management RPCs.
--
-- admin_create_user had four defects that made "Tambah Kasir" fail every time:
--   1. It inserted into public.profiles and public.user_roles even though the
--      on_auth_user_created trigger (AFTER INSERT ON auth.users) already does
--      exactly that. The trigger fires at the end of the auth.users INSERT
--      statement, so the function's own INSERT always hit
--      "duplicate key value violates unique constraint profiles_pkey" and the
--      whole transaction rolled back.
--   2. SET search_path = public hid pgcrypto (installed in the "extensions"
--      schema on Supabase), so crypt()/gen_salt() could not be resolved.
--   3. raw_user_meta_data was assembled by string concatenation, so a username
--      containing a double quote produced invalid JSON or injected extra keys.
--   4. No auth.identities row was created. GoTrue expects one for every
--      email/password account; without it, identity-dependent flows break.
--
-- admin_update_user_email left auth.identities stale for the same reason, and
-- did not normalise or de-duplicate the address.
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.admin_create_user(
  target_email TEXT,
  target_password TEXT,
  target_username TEXT DEFAULT NULL,
  target_full_name TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  new_user_id UUID := gen_random_uuid();
  norm_email  TEXT := lower(trim(target_email));
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat membuat akun kasir';
  END IF;

  IF norm_email IS NULL OR norm_email = '' THEN
    RAISE EXCEPTION 'Email wajib diisi';
  END IF;
  IF target_password IS NULL OR length(target_password) < 6 THEN
    RAISE EXCEPTION 'Password minimal 6 karakter';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = norm_email) THEN
    RAISE EXCEPTION 'Email % sudah terdaftar', norm_email;
  END IF;

  -- profiles + user_roles are populated by public.handle_new_user(), which runs
  -- as an AFTER INSERT trigger on this statement. Metadata is what it reads.
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, last_sign_in_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, recovery_token,
    email_change_token_new, email_change_token_current, email_change
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    new_user_id,
    'authenticated', 'authenticated', norm_email,
    crypt(target_password, gen_salt('bf')),
    NOW(), NOW(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_strip_nulls(jsonb_build_object(
      'username',       nullif(trim(target_username), ''),
      'full_name',      nullif(trim(target_full_name), ''),
      'email',          norm_email,
      'email_verified', true
    )),
    NOW(), NOW(),
    '', '', '', '', ''
  );

  INSERT INTO auth.identities (
    provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    new_user_id::text,
    new_user_id,
    jsonb_build_object(
      'sub',            new_user_id::text,
      'email',          norm_email,
      'email_verified', true,
      'phone_verified', false
    ),
    'email',
    NOW(), NOW(), NOW()
  );

  RETURN new_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_user_email(
  target_user_id UUID,
  new_email TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  norm_email TEXT := lower(trim(new_email));
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat mengubah email';
  END IF;

  IF norm_email IS NULL OR norm_email = '' THEN
    RAISE EXCEPTION 'Email wajib diisi';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = norm_email AND id <> target_user_id) THEN
    RAISE EXCEPTION 'Email % sudah dipakai akun lain', norm_email;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = target_user_id) THEN
    RAISE EXCEPTION 'Pengguna tidak ditemukan';
  END IF;

  UPDATE auth.users
  SET
    email              = norm_email,
    email_confirmed_at = COALESCE(email_confirmed_at, NOW()),
    raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb)
                         || jsonb_build_object('email', norm_email),
    updated_at         = NOW()
  WHERE id = target_user_id;

  -- Keep the email identity in sync, otherwise GoTrue still reports the old
  -- address on user.identities.
  UPDATE auth.identities
  SET
    identity_data = COALESCE(identity_data, '{}'::jsonb)
                    || jsonb_build_object('email', norm_email),
    updated_at    = NOW()
  WHERE user_id = target_user_id AND provider = 'email';
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_user(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_update_user_email(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_user(TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_user_email(UUID, TEXT) TO authenticated, service_role;
