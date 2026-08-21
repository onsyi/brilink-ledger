-- Menutup tiga temuan audit 21 Agustus 2026: T-1, T-2, dan T-4.
--
-- Ketiganya berbagi satu pola: kontrolnya sudah benar di satu lapis, tapi lapis
-- di bawahnya tidak ikut ditutup.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- T-1  Kasir bisa mengaktifkan kembali akunnya sendiri
--
-- 20260815000006 memberi authenticated UPDATE atas (username, full_name,
-- branch_id, is_active) pada profiles, dan profiles_update_own mengizinkan
-- baris milik sendiri. guard_profile_branch_change hanya menjaga branch_id --
-- is_active tidak dijaga siapa pun, jadi kasir yang dinonaktifkan bisa
-- membalik flag-nya sendiri selama tokennya masih hidup, lalu membuka shift
-- (open_shift_atomic hanya memeriksa profiles.is_active).
--
-- branch_id tetap perlu grant-nya: owner memakai role authenticated yang sama
-- dan memindahkan cabang kasir lewat tulisan tabel langsung, jadi trigger-lah
-- yang membedakan owner dari kasir. is_active tidak begitu -- tidak ada satu
-- pun jalur klien yang menulisnya, hanya admin_set_user_active yang SECURITY
-- DEFINER. Jadi grant-nya dicabut, dan trigger tetap diperluas agar kontrolnya
-- bertahan seandainya grant itu kembali suatu hari.
-- ---------------------------------------------------------------------------
REVOKE UPDATE ON public.profiles FROM authenticated;
GRANT UPDATE (username, full_name, branch_id) ON public.profiles TO authenticated;

CREATE OR REPLACE FUNCTION public.guard_profile_privileged_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    IF NEW.branch_id IS DISTINCT FROM OLD.branch_id THEN
      RAISE EXCEPTION 'Hanya owner yang dapat mengubah cabang';
    END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'Hanya owner yang dapat mengubah status akun';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_profile_branch ON public.profiles;
DROP TRIGGER IF EXISTS trg_guard_profile_fields ON public.profiles;
CREATE TRIGGER trg_guard_profile_fields
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.guard_profile_privileged_fields();

DROP FUNCTION IF EXISTS public.guard_profile_branch_change();

-- ---------------------------------------------------------------------------
-- T-2  Username bebas diganti dan tidak unik
--
-- Mengubah username sendiri memang fitur (Profil Saya). Yang salah adalah
-- tidak adanya jaminan keunikan: kasir bisa mengambil nama persis milik
-- rekannya, dan username adalah cara sistem menyebut orang di seluruh jejak
-- yang bisa diaudit -- kolom "ditutup oleh" pada serah terima shift, riwayat
-- shift_amendments, dan laporan owner. Tanpa keunikan, pertanyaan "siapa yang
-- menutup shift ini" tidak punya jawaban tunggal.
--
-- Dibandingkan case-insensitive: "Lili" dan "lili" harus dianggap sama, kalau
-- tidak penyamarannya cukup dengan mengubah kapitalisasi.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_key
  ON public.profiles (lower(username));

-- handle_new_user() menurunkan username dari alamat email bila owner tidak
-- mengisinya. Dengan index di atas, budi@toko-a.com dan budi@toko-b.com akan
-- bertabrakan dan pembuatan akun kedua gagal dengan galat duplicate key dari
-- dalam trigger -- membingungkan, dan bukan salah si owner.
--
-- Jadi dua kasusnya dibedakan: nama yang diketik owner ditolak dengan pesan
-- jelas kalau bentrok (dia harus tahu, karena yang tersimpan bukan yang dia
-- isi), sedangkan nama turunan email diberi akhiran angka.
--
-- Pemeriksaan EXISTS di bawah hanya untuk pesannya. Dua pendaftaran bersamaan
-- masih bisa lolos berbarengan lalu ditahan index -- itu memang jaminannya.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  first_user BOOLEAN;
  wanted     TEXT := nullif(trim(NEW.raw_user_meta_data->>'username'), '');
  base       TEXT;
  final_name TEXT;
  n          INT := 1;
BEGIN
  IF wanted IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.profiles WHERE lower(username) = lower(wanted)) THEN
      RAISE EXCEPTION 'Username % sudah dipakai', wanted;
    END IF;
    final_name := wanted;
  ELSE
    base := split_part(NEW.email, '@', 1);
    final_name := base;
    WHILE EXISTS (SELECT 1 FROM public.profiles WHERE lower(username) = lower(final_name)) LOOP
      n := n + 1;
      final_name := base || n::text;
    END LOOP;
  END IF;

  INSERT INTO public.profiles (id, username, full_name)
  VALUES (NEW.id, final_name, NEW.raw_user_meta_data->>'full_name');

  PERFORM pg_advisory_xact_lock(hashtext('brilink_first_user'));

  SELECT NOT EXISTS (SELECT 1 FROM public.user_roles) INTO first_user;
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, CASE WHEN first_user THEN 'owner'::public.app_role ELSE 'cashier'::public.app_role END);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- T-4  Grant lebih longgar dari yang dipakai
--
-- transactions memberi authenticated INSERT/UPDATE/DELETE penuh atas semua
-- kolom yang bisa ditulis. Tidak ada satu pun kode klien yang menulis ke tabel
-- ini -- hanya .select() -- karena fiturnya belum dikerjakan (README 3.3).
-- Permukaan itu menganggur, jadi ditutup.
--
-- Koreksi atas laporan auditnya: temuan T-4 menyebut profit_net ikut bisa
-- dikarang kasir. Itu keliru -- profit_net adalah kolom GENERATED ALWAYS, jadi
-- database sejak awal yang menghitungnya dan nilai kiriman klien ditolak.
-- Yang memang terbuka adalah customer_fee dan provider_cost, dan itu sudah
-- cukup untuk menggeser laba, jadi pencabutannya tetap tepat.
--
-- Kalau pencatatan transaksi nanti dibangun, arahkan lewat RPC seperti pola
-- shift. Membuka kembali grant ini adalah jalan yang salah.
--
-- CATATAN, dan ini koreksi terhadap laporan auditnya sendiri: branches SENGAJA
-- tidak disentuh. Temuan T-4 menyebutnya "hanya diselamatkan RLS", tapi owner
-- memakai role authenticated yang sama dan menulis langsung ke tabel itu dari
-- BranchManagement.tsx. RLS memang satu-satunya lapis yang bisa membedakan
-- owner dari kasir di sana; mencabut grant-nya akan mematikan manajemen cabang
-- bagi owner. Menutupnya perlu memindahkan branches ke RPC lebih dulu --
-- pekerjaan tersendiri, bukan bagian dari perbaikan ini.
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE ON public.transactions FROM authenticated;
