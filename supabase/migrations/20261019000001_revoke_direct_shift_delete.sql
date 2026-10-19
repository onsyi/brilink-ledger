-- Menutup temuan S-4 (audit 19 Oktober 2026, supabase/AUDIT.md).
--
-- `authenticated` memegang DELETE pada public.shifts (20260815000006), dan
-- policy shifts_delete_owner (20260804000000) membukanya untuk owner. Trigger
-- prevent_closed_shift_delete sudah melindungi shift TERTUTUP -- sejarah ledger
-- memang utuh. Yang terbuka adalah shift yang masih BERJALAN:
--
--   DELETE /rest/v1/shifts?id=eq.<uuid>
--
-- Jalur itu melewati seluruh penjagaan yang dipasang cancel_open_shift():
--
--   | Penjagaan di cancel_open_shift      | Lewat DELETE langsung          |
--   | hanya shift milik sendiri           | dilewati -- shift kasir mana pun|
--   | menolak shift yang laporannya ditolak| dilewati                      |
--   | menolak shift yang punya transaksi  | dilewati, cascade ikut menghapus|
--   | menulis baris 'cancel' ke jejak     | TIDAK ADA JEJAK SAMA SEKALI    |
--
-- Baris terakhir itu intinya. Seluruh arsitektur ini berdiri di atas premis
-- bahwa setiap perubahan angka meninggalkan jejak yang bisa diaudit --
-- 20260815000008 bahkan sengaja TIDAK memberi foreign key dari
-- shift_amendments ke shifts, justru agar baris pembatalan hidup lebih lama
-- daripada shift yang dihapusnya. DELETE langsung melubangi premis itu: shift
-- beserta transaksi, piutang, dan saldonya hilang lewat cascade, dan tidak ada
-- apa pun yang menyatakan ia pernah ada.
--
-- Tidak ada UI yang memanggilnya: `grep -rn 'from("shifts")' src/ | grep -i
-- delete` tidak menghasilkan apa pun. Jadi ini permukaan yang menganggur, dan
-- menutupnya tidak mengubah perilaku aplikasi.
--
-- cancel_open_shift() tetap bisa menghapus: ia SECURITY DEFINER, berjalan
-- sebagai pemilik tabel, jadi ia tidak bergantung pada grant `authenticated`
-- maupun pada policy yang dihapus di bawah.
--
-- Kalau owner suatu saat memang perlu menghapus shift kasir lain, jalurnya
-- adalah RPC tersendiri yang menulis jejaknya -- bukan mengembalikan grant ini.
--
-- Idempotent: safe to re-run.

REVOKE DELETE ON public.shifts FROM authenticated;

-- Policy-nya ikut dibuang, bukan ditinggalkan tanpa privilege. Policy yang
-- tidak bisa dicapai hanya membuat kumpulan aturan menggambarkan keadaan yang
-- tidak lagi benar -- persis temuan M-3 soal txn_update.
DROP POLICY IF EXISTS "shifts_delete_owner" ON public.shifts;

-- Trigger prevent_closed_shift_delete (20260909000002) sengaja DIPERTAHANKAN.
-- Setelah perubahan di atas tidak ada klien yang bisa mencapainya, tapi ia
-- tetap menjaga service_role dan jalur SQL langsung dari menghapus shift
-- tertutup -- dan cancel_open_shift tetap lolos karena hanya menyentuh shift
-- yang masih berstatus 'open'.

COMMENT ON TABLE public.shifts IS
  'Shift kasir. Penghapusan hanya lewat cancel_open_shift() (shift terbuka, tanpa transaksi, milik sendiri, dan tercatat di shift_amendments). Klien tidak punya privilege DELETE -- lihat supabase/AUDIT.md temuan S-4.';
