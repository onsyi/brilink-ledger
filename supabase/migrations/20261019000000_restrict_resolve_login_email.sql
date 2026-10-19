-- Menutup temuan K-1 (audit 19 Oktober 2026, supabase/AUDIT.md).
--
-- resolve_login_email() di-GRANT ke `anon`, dan ia SECURITY DEFINER yang
-- membaca auth.users. Karena VITE_SUPABASE_PUBLISHABLE_KEY memang dikirim ke
-- setiap pengunjung di dalam bundle JavaScript, siapa pun bisa memanggilnya
-- tanpa login:
--
--   POST /rest/v1/rpc/resolve_login_email  { "identifier": "santi" }
--   -> "santi@namatoko.com"
--
-- Username bukan rahasia: ia tampil di kolom "Kasir" pada setiap laporan dan di
-- kolom "ditutup oleh" pada serah terima shift. Jadi satu tebakan username
-- menghasilkan alamat email akun itu -- satu dari dua bagian kredensial, plus
-- kepastian bahwa akunnya ada. Itu bahan phishing terarah dan credential
-- stuffing yang tidak lagi membuang tebakan pada akun yang tidak eksis.
--
-- Fungsinya sendiri tidak salah; yang salah adalah siapa yang boleh
-- memanggilnya. Penerjemahan username -> email tetap dibutuhkan (kasir login
-- dengan username di terminal toko), tapi mulai sekarang yang melakukannya
-- adalah Edge Function `login`, yang berjalan di server dengan service_role,
-- memanggil sign-in GoTrue di sana, dan hanya mengembalikan sesi atau galat
-- generik. Email tidak pernah lagi sampai ke klien.
--
-- Dua perubahan di bawah, keduanya perlu:
--
--   1. Grant dipersempit ke service_role saja. `anon` dan `authenticated`
--      dicabut -- tidak ada kode klien yang memanggilnya lagi.
--
--   2. Perilaku "pantulkan input kalau tidak ditemukan" dibuang. Dulu fungsi
--      ini mengembalikan identifier apa adanya saat tidak ada akun yang cocok,
--      supaya pemanggil bisa meneruskannya ke signInWithPassword. Itu membuatnya
--      berguna sebagai orakel keberadaan akun. Kontraknya kini tegas: username
--      yang dikenal menghasilkan email, apa pun selain itu menghasilkan NULL,
--      dan pemanggil tidak bisa membedakan "tidak ada" dari "bukan username".
--
-- Cabang '@' juga dihapus dari fungsi ini. Input yang sudah berupa email tidak
-- perlu diterjemahkan sama sekali -- Edge Function memakainya langsung, dan
-- GoTrue yang menolaknya kalau salah. Satu pencarian yang tidak dilakukan
-- adalah satu kebocoran yang tidak mungkin terjadi.
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.resolve_login_email(identifier TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  _needle TEXT := lower(btrim(COALESCE(identifier, '')));
  _email  TEXT;
BEGIN
  IF _needle = '' THEN
    RETURN NULL;
  END IF;

  -- Hanya username. Email tidak diterjemahkan: lihat catatan di header.
  SELECT u.email INTO _email
  FROM public.profiles p
  JOIN auth.users u ON u.id = p.id
  WHERE lower(p.username) = _needle
  LIMIT 1;

  -- NULL, bukan pantulan input: pemanggil tidak boleh bisa membedakan
  -- "username tidak terdaftar" dari "yang dikirim bukan username".
  RETURN _email;
END;
$$;

-- CREATE OR REPLACE mempertahankan grant yang sudah ada, jadi pencabutannya
-- harus eksplisit dan harus setelah definisinya.
REVOKE ALL ON FUNCTION public.resolve_login_email(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_login_email(TEXT) TO service_role;

COMMENT ON FUNCTION public.resolve_login_email(TEXT) IS
  'Username -> email untuk alur login. HANYA service_role: dipanggil Edge Function `login`, tidak pernah dari browser. Mengembalikan NULL bila username tidak terdaftar. Lihat supabase/AUDIT.md temuan K-1.';
