-- Menutup T-3 dan T-5 dari audit 21 Agustus 2026.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- T-3  Kebijakan password terlalu longgar
--
-- Setelan kekuatan password di project (panjang minimum, syarat karakter,
-- penolakan password bocor) ditegakkan GoTrue di lapis API -- berlaku untuk
-- login, reset, dan updateUser(). Tapi admin_create_user() TIDAK melewati
-- lapis itu: ia menulis langsung ke auth.users dengan crypt(), jadi setiap
-- akun kasir yang dibuat owner sepenuhnya luput dari kebijakan tersebut.
--
-- Ini bagian yang tidak bisa ditutup dari dashboard. Ambangnya harus ada di
-- sini juga, kalau tidak jalur pembuatan akun -- justru jalur yang dipakai
-- untuk SEMUA kasir -- tetap menerima password enam karakter.
--
-- Angkanya (10) disamakan dengan setelan project supaya tidak ada satu pun
-- jalur yang lebih longgar dari yang lain.
-- ---------------------------------------------------------------------------
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

  RETURN new_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_user(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_user(TEXT, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- T-5  Policy SELECT ganda pada branches
--
-- 20260807000002 membuat "Cashiers can view active branches"; 20260808000000
-- membuangnya lalu memasang "Cashiers can view active or assigned branches"
-- yang merupakan superset-nya. Di database yang hidup keduanya ada -- migrasi
-- lama tampaknya pernah dijalankan ulang setelah yang baru.
--
-- Hasil akhirnya tetap benar karena policy permissive digabung dengan OR, jadi
-- ini bukan lubang. Tapi siapa pun yang membaca ulang aturan akses cabang
-- harus memastikan dulu mana yang sebenarnya berlaku, dan itu ongkos yang
-- tidak perlu ada.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Cashiers can view active branches" ON public.branches;
