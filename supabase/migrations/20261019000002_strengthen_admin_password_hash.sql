-- Menutup temuan S-1 (audit 19 Oktober 2026, supabase/AUDIT.md).
--
-- admin_create_user() menghitung hash password dengan:
--
--   crypt(target_password, gen_salt('bf'))
--
-- gen_salt('bf') tanpa argumen kedua memakai iter_count 6, sementara GoTrue --
-- yang menangani login, reset, dan updateUser() -- memakai bcrypt cost 10.
-- Selisih empat pangkat dua: hash kasir 16x lebih murah untuk di-brute force
-- daripada hash yang dibuat jalur mana pun lainnya.
--
-- Yang membuatnya penting bukan angkanya, tapi di mana ia berada.
-- admin_create_user adalah SATU-SATUNYA cara akun kasir dibuat di aplikasi ini
-- (src/routes/_authenticated/settings.tsx). Jadi setiap akun kasir yang pernah
-- ada memakai cost 6; hanya akun owner pertama -- yang lahir dari pendaftaran
-- GoTrue biasa -- yang memakai cost 10.
--
-- Ini juga persis kebalikan dari tujuan migrasi yang memuatnya. Header
-- 20260822000000 menulis: "Angkanya (10) disamakan dengan setelan project
-- supaya tidak ada satu pun jalur yang lebih longgar dari yang lain." Panjang
-- password-nya memang disamakan; kekuatan hash-nya terlewat.
--
-- PENTING, dan ini tidak bisa diselesaikan oleh migrasi:
--
--   bcrypt menyimpan cost di dalam string hash-nya, jadi hash lama tetap
--   terverifikasi dan tidak ada akun yang kehilangan akses. Tapi hash lama juga
--   TIDAK ikut naik ke cost 10. Akun kasir yang sudah ada baru benar-benar
--   terlindungi setelah password-nya diganti -- lewat Reset Password di
--   Pengaturan, atau dibuat ulang oleh owner.
--
--   Karena hash cost 6 sudah lama beredar, sebaiknya password seluruh kasir
--   memang diganti setelah migrasi ini, bukan hanya dibiarkan.
--
--   Akun mana saja yang masih memakai cost 6 bisa didaftar begini (dijalankan
--   owner/service_role, read-only):
--
--     SELECT u.id, u.email
--     FROM auth.users u
--     WHERE u.encrypted_password LIKE '$2a$06$%'
--        OR u.encrypted_password LIKE '$2b$06$%';
--
-- Selain satu argumen pada gen_salt, badan fungsinya identik dengan definisi di
-- 20260822000000 -- disalin apa adanya supaya perubahannya mudah diperiksa.
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
  IF target_password IS NULL OR length(target_password) < 10 THEN
    RAISE EXCEPTION 'Password minimal 10 karakter';
  END IF;
  IF target_password !~ '[a-zA-Z]' OR target_password !~ '[0-9]' THEN
    RAISE EXCEPTION 'Password harus memuat huruf dan angka';
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
    -- Cost 10, disamakan dengan bcrypt GoTrue. Tanpa argumen kedua
    -- gen_salt('bf') memakai 6 -- lihat header migrasi ini.
    crypt(target_password, gen_salt('bf', 10)),
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

  RETURN new_user_id;
END;
$$;

-- CREATE OR REPLACE mempertahankan grant, tapi ditegaskan ulang mengikuti pola
-- migrasi lain di repositori ini: keadaan hak akses terbaca dari file yang
-- terakhir menyentuh fungsinya.
REVOKE ALL ON FUNCTION public.admin_create_user(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_user(TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.admin_create_user(TEXT, TEXT, TEXT, TEXT) IS
  'Membuat akun kasir (owner saja). Password di-hash bcrypt cost 10, sama dengan GoTrue. Akun yang dibuat sebelum 19 Oktober 2026 masih memakai cost 6 sampai password-nya diganti -- lihat supabase/AUDIT.md temuan S-1.';
