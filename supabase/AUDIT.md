# Audit Keamanan & Integritas Database — BRILink Ledger

Tanggal audit: 19 Oktober 2026
Cakupan: seluruh 50 file di `supabase/migrations/`, `supabase/config.toml`, dan
`reset_database.sql`, dibandingkan terhadap `src/lib/ledger.ts` dan pemakaian
RPC di `src/`.

Metode: membaca kode, berurutan menurut nama file. Banyak fungsi di-`CREATE OR
REPLACE` berulang kali di migrasi yang berbeda, jadi yang diaudit adalah
**definisi terakhir** setiap fungsi, bukan definisi pertamanya. Tidak ada SQL
yang dijalankan terhadap database mana pun, dan tidak ada data yang diubah.

Temuan di bawah **belum diperbaiki**. Perubahan skema produksi adalah keputusan
pemilik proyek, jadi laporan ini sengaja berhenti di usulan.

---

## Ringkasan

| Tingkat | Jumlah | Inti masalahnya                                                                                        |
| ------- | ------ | ------------------------------------------------------------------------------------------------------ |
| Kritis  | 1      | ~~Alamat email seluruh akun bisa dipanen tanpa login~~ — **sudah ditutup**                             |
| Serius  | 4      | Hash password kasir lemah; rantai saldo bisa bercabang & putus; shift terbuka bisa dihapus tanpa jejak |
| Minor   | 8      | Rumus latent, constraint & policy mati, bahaya replay migrasi                                          |

Yang perlu ditegaskan lebih dulu: **lapisan inti aplikasi ini sudah benar.**
Kasir tidak bisa mempromosikan dirinya jadi owner, tidak bisa menulis angka
keuangan shift secara langsung, dan shift yang sudah ditutup benar-benar
terkunci oleh lima trigger yang saling melengkapi. Mekanisme
`brilink.audit_override` — yang paling saya curigai sebelum membacanya — ternyata
tidak bisa dinyalakan oleh klien. Rincian apa saja yang sudah benar ada di
bagian [Yang sudah ditegakkan dengan benar](#yang-sudah-ditegakkan-dengan-benar)
di bawah, dan bagian itu bukan pelengkap sopan — isinya informasi yang perlu
diketahui sebelum menyentuh apa pun.

---

## KRITIS

### K-1 `resolve_login_email` terbuka untuk `anon` — daftar email seluruh akun bisa dipanen tanpa login

> **Status: sudah ditutup (19 Oktober 2026).** Diperbaiki dengan opsi 1 di bawah.
> Grant `anon` dicabut di `20261019000000_restrict_resolve_login_email.sql`;
> penerjemahan username pindah ke `supabase/functions/login/index.ts`; dan
> `src/routes/auth.tsx` kini memanggil Edge Function itu, bukan RPC-nya.
> Uraian di bawah dibiarkan utuh sebagai catatan mengapa perubahan itu
> dilakukan.
>
> **Edge Function-nya perlu di-deploy terpisah** — `git push` hanya menerbitkan
> frontend ke Vercel:
>
> ```
> supabase functions deploy login --no-verify-jwt
> ```
>
> Dan karena project ini memakai key gaya baru (JWT anon/service_role lama
> dimatikan, lihat `AGENTS.md`), Edge Function butuh dua secret:
>
> ```
> supabase secrets set BRILINK_PUBLISHABLE_KEY=sb_publishable_... BRILINK_SECRET_KEY=sb_secret_...
> ```
>
> Sampai keduanya terpasang, login akan menjawab "Layanan masuk belum
> dikonfigurasi."

**Lokasi:** `20260910000003_add_resolve_login_email.sql`

```sql
GRANT EXECUTE ON FUNCTION public.resolve_login_email(TEXT) TO anon, authenticated, service_role;
```

Ini satu-satunya fungsi di seluruh skema yang diberikan ke `anon`, dan ia
`SECURITY DEFINER` yang membaca `auth.users`:

```sql
SELECT u.email INTO _email
FROM public.profiles p
JOIN auth.users u ON u.id = p.id
WHERE lower(p.username) = lower(trim(identifier))
```

Fungsinya sendiri wajar — ia yang membuat login dengan username bisa bekerja,
dipanggil dari `src/routes/auth.tsx:77` sebelum pengguna punya sesi. Masalahnya
ada pada apa yang ia kembalikan ke pemanggil yang belum login.

**Skenario konkret.** `VITE_SUPABASE_PUBLISHABLE_KEY` ada di dalam bundle
JavaScript yang dikirim ke setiap pengunjung, jadi kunci itu milik publik —
memang begitu desainnya, dan itu normal. Tapi dengan kunci itu siapa pun bisa:

```
POST /rest/v1/rpc/resolve_login_email
{ "identifier": "santi" }
→ "santi@namatoko.com"
```

Tanpa autentikasi apa pun. Username bukan rahasia: ia tampil di kolom "Kasir"
pada setiap laporan, di kolom "ditutup oleh" pada serah terima shift, dan
nama-nama seperti `owner`, `santi`, `tiara`, `eci` mudah ditebak — beberapa di
antaranya bahkan tertulis di komentar migrasi repositori ini sendiri. Jadi
penyerang yang menebak atau mengetahui satu username langsung memperoleh alamat
email akun itu: satu dari dua bagian kredensial, plus kepastian bahwa akunnya
ada. Itu bahan untuk phishing yang terarah dan untuk credential stuffing yang
tidak lagi membuang tebakan pada akun yang tidak eksis.

Cabang `@` pada fungsi yang sama juga berfungsi sebagai orakel keberadaan email,
meski lebih lemah: ia mengembalikan email tersimpan bila ada, dan memantulkan
input bila tidak.

**Usulan.** Tiga arah, dari yang paling kecil ongkosnya:

1. **Pindahkan penerjemahan ke sisi server yang tidak mengembalikan email.**
   Buat Edge Function yang menerima `{identifier, password}`, menerjemahkan
   username ke email memakai `service_role`, lalu memanggil sign-in dan hanya
   mengembalikan sesi atau galat. Klien tidak pernah melihat email siapa pun.
   Ini menutup lubangnya sepenuhnya dan tidak mengubah pengalaman login.
2. **Cabut grant `anon`** dan minta kasir login dengan email. Paling murah,
   tapi mengorbankan fitur yang jelas berguna di terminal toko.
3. **Jadikan username bagian dari email** (`santi@brilink.local`) sehingga
   penerjemahan bisa dihitung di klien tanpa query. Mengubah cara akun dibuat.

Yang **tidak** menutup lubangnya: membatasi rate, atau mengembalikan `NULL`
alih-alih memantulkan input. Keduanya hanya memperlambat pemanenan.

---

## SERIUS

### S-1 `admin_create_user` memakai bcrypt cost 6 — jalur satu-satunya pembuatan akun kasir justru yang paling lemah

**Lokasi:** `20260822000000_password_floor_and_policy_cleanup.sql:69`

```sql
crypt(target_password, gen_salt('bf'))
```

`gen_salt('bf')` tanpa argumen kedua memakai `iter_count` **6**, sementara
GoTrue — yang menangani login, reset, dan `updateUser()` — memakai bcrypt cost
**10**. Selisih empat pangkat dua: hash kasir 16× lebih murah untuk di-brute
force daripada hash yang dibuat jalur mana pun lainnya.

Yang membuat ini pantas disebut serius bukan angkanya, tapi di mana ia berada.
`admin_create_user` adalah **satu-satunya** cara akun kasir dibuat di aplikasi
ini (`src/routes/_authenticated/settings.tsx:317`). Jadi setiap akun kasir yang
pernah ada memakai hash cost 6; hanya akun owner pertama — yang dibuat lewat
pendaftaran GoTrue normal — yang memakai cost 10.

Ini juga persis kebalikan dari tujuan migrasi yang memuatnya. Header filenya
menulis: _"Angkanya (10) disamakan dengan setelan project supaya tidak ada satu
pun jalur yang lebih longgar dari yang lain."_ Panjang password-nya memang
disamakan; kekuatan hash-nya terlewat.

**Usulan.** `gen_salt('bf', 10)`. Satu argumen. Hash yang sudah ada tidak
ikut berubah — bcrypt menyimpan cost di dalam string hash-nya, jadi hash lama
tetap terverifikasi — sehingga akun kasir yang sudah ada perlu reset password
agar ikut naik ke cost 10. Pertimbangkan sekalian mengganti password seluruh
kasir setelah perbaikan ini, karena hash lemahnya sudah lama ada.

---

### S-2 Eksklusivitas shift per cabang hanya dijaga `SELECT` tanpa kunci — dua kasir bisa membuka shift bersamaan dan merusak rantai saldo

**Lokasi:** `20260907000002_align_saldo_awal_akhir_formulas.sql` (definisi
terakhir `open_shift_atomic`)

```sql
IF EXISTS (SELECT 1 FROM public.shifts WHERE branch_id = _resolved_branch AND status = 'open') THEN
  RAISE EXCEPTION 'Masih ada shift aktif di cabang ini. Tunggu kasir sebelumnya menutup shift.';
END IF;
```

Pemeriksaan ini adalah klasik _check-then-act_ tanpa penguncian. Dua transaksi
bersamaan masing-masing membaca snapshot-nya sendiri, keduanya tidak melihat
shift terbuka, keduanya lolos, keduanya `INSERT`.

Bandingkan dengan aturan per-akun yang ditegakkan di tempat yang tidak bisa
dibalap — indeks unik parsial di `20260804000000_initial_schema.sql:109`:

```sql
CREATE UNIQUE INDEX shifts_one_open_per_user ON public.shifts (user_id) WHERE status = 'open';
```

Aturan per-cabang tidak punya padanannya. Nama migrasi yang memperkenalkannya
adalah `guard_shift_concurrency_and_cancellation`, tapi yang ditambahkan hanya
`EXISTS`-nya.

**Skenario konkret.** Dua kasir di outlet yang sama membuka shift dalam detik
yang sama — pergantian pagi, dua orang menekan "Mulai shift" hampir serentak.
Keduanya berhasil. Keduanya diisi otomatis dengan saldo akhir shift sebelumnya
yang **sama**, karena `last_closed_shift_balances()` mengembalikan baris yang
sama untuk keduanya, dan `assert_opening_continuity()` meloloskan keduanya
karena keduanya memang cocok dengan shift sebelumnya. Mulai titik itu rantai
saldo bercabang: uang yang sama dipakai sebagai modal awal dua shift, dan ketika
keduanya ditutup, selisih saldo yang sama dihitung sebagai laba dua kali.

Kerusakannya tidak terlihat dari layar mana pun — kedua shift tampak sah, dan
laporan hanya menjumlahkan Laba keduanya.

**Usulan.** Pilih satu, keduanya menutup lubangnya:

```sql
-- Opsi A: tegakkan di indeks, seperti aturan per-akun
CREATE UNIQUE INDEX shifts_one_open_per_branch
  ON public.shifts (branch_id) WHERE status = 'open' AND branch_id IS NOT NULL;

-- Opsi B: serialkan per cabang di dalam RPC, sebelum pemeriksaan EXISTS
PERFORM pg_advisory_xact_lock(hashtext('brilink_branch_open:' || _resolved_branch::text));
```

Opsi A lebih kuat (berlaku untuk jalur apa pun, bukan hanya RPC ini) tapi perlu
dipastikan dulu tidak ada data lama yang sudah melanggarnya. Opsi B tidak
menyentuh data yang ada. Memakai keduanya juga wajar: A sebagai jaminan, B agar
galat yang muncul ke kasir berupa pesan yang bisa dibaca, bukan `23505`.

---

### S-3 `owner_adjust_balance` tidak memeriksa shift penerus — koreksi saldo akhir memutus rantai yang sudah terkunci

**Lokasi:** `20260909000008_fix_audit_override_ordering.sql` (definisi terakhir)

`assert_opening_continuity()` mewajibkan saldo awal shift N+1 sama persis dengan
saldo akhir shift N, dan itu diperiksa **saat shift N+1 dibuka**. Pemeriksaan itu
tidak pernah dijalankan ulang.

Jadi ketika owner mengoreksi `final_amount` shift N lewat tombol Audit, padahal
shift N+1 sudah dibuka dengan angka lama, rantainya langsung tidak konsisten:
`bank_balances[N].final_amount ≠ bank_balances[N+1].initial_amount`. Tidak ada
galat, tidak ada peringatan, dan tidak ada baris mana pun yang menandai bahwa
selisih itu ada.

Yang menarik: **`owner_reject_shift_report` punya persis penjagaan yang
dibutuhkan di sini** (`20260910000000_fix_audit_bugs.sql:51`):

```sql
IF public.previous_closed_shift_id(_shift.branch_id, _shift.user_id)
     IS DISTINCT FROM _shift.id THEN
  RAISE EXCEPTION 'Sudah ada shift lain yang ditutup setelah shift ini ...
    koreksi lewat tombol Audit, atau tolak shift yang terbaru lebih dulu.';
END IF;
```

Pesan galat itu mengarahkan owner ke tombol Audit justru untuk kasus ini — dan
tombol Audit tidak punya penjagaan apa pun. `src/components/ShiftAuditDialogs.tsx:174`
mengulang anjuran yang sama ke layar owner.

**Dampak angka.** Laba shift N berubah (memang itu maksud koreksinya), tapi Laba
shift N+1 ikut salah dan tidak ada yang memberi tahu: Saldo Awal-nya masih
memakai angka yang sudah dinyatakan keliru.

**Usulan.** Dua pelengkap, bukan alternatif:

1. Saat `_field = 'final'` dan shift punya penerus di cabang yang sama,
   **rambatkan** koreksinya ke `initial_amount` shift penerus dan hitung ulang
   `modal_awal`-nya — di dalam transaksi yang sama, dengan barisnya sendiri di
   `shift_amendments` agar rambatannya ikut terekam.
2. Kalau rambatan otomatis dianggap terlalu berani, minimal **tolak** koreksinya
   dengan pesan yang menyebut shift penerusnya, seperti yang dilakukan
   `owner_reject_shift_report`. Lebih baik owner diminta mengoreksi dari shift
   terbaru ke belakang daripada meninggalkan rantai yang putus tanpa jejak.

Pertimbangkan juga fungsi pemeriksa terpisah yang bisa dijalankan kapan saja:
cari semua pasangan shift berurutan per cabang yang `final ≠ initial`, dan
tampilkan di halaman audit owner. Itu menangkap rantai putus dari sebab apa pun,
termasuk yang sudah terjadi sebelum perbaikan ini.

---

### S-4 Owner bisa menghapus shift terbuka langsung lewat API, melewati seluruh penjagaan `cancel_open_shift`

**Lokasi:** `20260815000006_least_privilege_grants.sql:60` +
`20260804000000_initial_schema.sql:125`

```sql
GRANT SELECT, DELETE ON public.shifts TO authenticated;

CREATE POLICY "shifts_delete_owner" ON public.shifts FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(),'owner'));
```

Trigger `prevent_closed_shift_delete` menutup shift **tertutup** — sejarah
ledger memang terlindungi. Tapi shift **terbuka** boleh dihapus, dan jalur
`DELETE /rest/v1/shifts?id=eq.<uuid>` melewati semua penjagaan yang dipasang di
`cancel_open_shift` (`20260907000001`):

| Penjagaan di `cancel_open_shift`                      | Lewat `DELETE` langsung                                  |
| ----------------------------------------------------- | -------------------------------------------------------- |
| Hanya shift milik sendiri                             | Dilewati — owner boleh menghapus shift kasir mana pun    |
| Menolak shift yang laporannya ditolak (`rejected_at`) | Dilewati                                                 |
| Menolak shift yang sudah punya transaksi              | Dilewati — `ON DELETE CASCADE` ikut membawa transaksinya |
| Menulis baris `cancel` ke `shift_amendments`          | **Tidak ada jejak sama sekali**                          |

Baris terakhir itu yang penting. Seluruh arsitektur ini dibangun di atas premis
bahwa setiap perubahan angka meninggalkan jejak yang bisa diaudit; komentar di
`20260815000008` bahkan menjelaskan bahwa `shift_amendments` sengaja tidak
punya foreign key ke `shifts` justru _agar_ baris pembatalan hidup lebih lama
daripada shift yang dihapusnya. Jalur `DELETE` langsung melubangi premis itu:
shift beserta transaksinya hilang dan tidak ada apa pun yang menyatakan ia
pernah ada.

Tidak ada UI yang memanggilnya — ini permukaan yang menganggur, bukan jalur yang
dipakai. Tapi ia terbuka bagi siapa pun yang memegang token owner.

**Usulan.** `REVOKE DELETE ON public.shifts FROM authenticated` dan hapus policy
`shifts_delete_owner`. `cancel_open_shift` adalah `SECURITY DEFINER`, jadi ia
tetap bisa menghapus tanpa grant itu. Kalau owner memang perlu bisa menghapus
shift kasir lain, buat RPC terpisah yang menulis jejaknya.

---

## MINOR

### M-1 `amend_open_shift` menjatuhkan `additional_capital` dari rumus Saldo Awal

`20260910000000_fix_audit_bugs.sql:210`

```sql
_modal_awal := COALESCE(_initial_cash, 0) + _bank_total;
```

Rumus kanoniknya `kas awal + bank awal + modal tambahan`. Tiga fungsi lain
(`close_shift_atomic`, `owner_adjust_balance`, `owner_adjust_shift_field`)
memakai bentuk lengkapnya.

Hari ini **tidak ada dampaknya**, dan itu bisa dibuktikan: `open_shift_atomic`
menulis `additional_capital = 0`, `owner_adjust_shift_field` menolak shift
terbuka, dan `owner_reject_shift_report` mengembalikannya ke 0. Jadi setiap kali
`amend_open_shift` berjalan, nilainya pasti 0 dan `+ 0` tidak mengubah apa pun.

Yang membuatnya pantas dicatat: jaminan itu berasal dari tiga fungsi lain, bukan
dari fungsi ini. Begitu ada satu jalur baru yang mengisi `additional_capital`
pada shift terbuka, `amend_open_shift` akan diam-diam menghapusnya dari Saldo
Awal. Menambahkan `+ COALESCE(_shift.additional_capital, 0)` sekarang tidak
mengubah hasil apa pun dan menghilangkan ranjaunya.

### M-2 `shifts.final_physical_balance` tidak punya CHECK `>= 0`

`20260807000001_add_check_constraints.sql` dan `20260814000004_add_settlement.sql`
memberi CHECK `>= 0` pada `initial_physical_balance`, `total_expenses`,
`topup_request`, `deposit_amount`, `additional_capital`, `settlement_amount`,
serta kolom uang di `transactions`, `bank_balances`, `ppob_balances`, dan
`receivables`. `final_physical_balance` terlewat.

`close_shift_atomic` dan `owner_adjust_shift_field` sudah memvalidasinya, jadi
tidak ada jalur yang bisa menulis nilai negatif sekarang. Ini murni
defense-in-depth yang tidak konsisten dengan tetangganya.

### M-3 Policy `txn_update` sudah mati

`20260804000000_initial_schema.sql:173` memasang policy UPDATE pada
`transactions`, tapi privilege UPDATE-nya dicabut di `20260821000002:147` dan
tidak dikembalikan — `20260910000002` hanya memberi `SELECT, INSERT, DELETE`.
Policy-nya tidak bisa dicapai. Bukan lubang; menghapusnya membuat kumpulan
policy menggambarkan keadaan yang sebenarnya.

### M-4 Kasir memegang INSERT/UPDATE/DELETE pada `branches`, hanya ditahan RLS

`20260815000006:75` memberi CRUD penuh atas `branches` ke `authenticated`.
Satu-satunya yang menahan kasir adalah tidak adanya policy permissive untuk
mereka selain SELECT.

Ini **sudah diketahui dan diterima secara sadar** —
`20260821000002:139-145` menjelaskan alasannya: owner memakai role
`authenticated` yang sama dan menulis langsung ke tabel itu dari
`BranchManagement.tsx`, jadi RLS memang satu-satunya lapis yang bisa membedakan
keduanya. Mencabut grant-nya akan mematikan manajemen cabang.

Saya tidak menganggap ini temuan baru, hanya mencatatnya agar tidak hilang:
menutupnya perlu memindahkan `branches` ke RPC lebih dulu. Satu catatan tambahan
yang relevan — `branches.id` direferensikan `profiles.branch_id` dan
`shifts.branch_id` dengan `ON DELETE SET NULL`, jadi penghapusan cabang tidak
memutus data, tapi shift lama kehilangan atribusi cabangnya.

### M-5 Policy `branches` tidak menyebut `TO authenticated`

`20260807000002:23` dan `20260808000000:8` membuat policy tanpa klausa `TO`,
sehingga berlaku untuk `PUBLIC` termasuk `anon`. Setiap policy lain di skema ini
menyebut `TO authenticated` secara eksplisit.

Tidak bisa dieksploitasi: `anon` sudah dicabut seluruh grant tabelnya di
`20260815000006`, dan kedua ekspresinya bernilai false saat `auth.uid()` NULL.
Murni soal keseragaman — dan keseragaman itu ada gunanya ketika seseorang
membaca ulang aturan akses dan harus memastikan mana yang berlaku.

### M-6 Bahaya replay: dua migrasi yang mengaku idempoten mengembalikan privilege yang sudah dicabut

`20260815000006_least_privilege_grants.sql` menulis:

```sql
GRANT UPDATE (username, full_name, branch_id, is_active) ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transactions TO authenticated;
```

Keduanya **dicabut lagi oleh migrasi berikutnya** — `is_active` oleh
`20260821000002:25` (karena kasir yang dinonaktifkan bisa mengaktifkan diri
sendiri), dan UPDATE pada `transactions` oleh `20260821000002:147`.

Setiap file itu memang idempoten kalau dijalankan sendiri. Yang tidak aman
adalah menjalankannya **di luar urutan** — misalnya seseorang menjalankan ulang
`20260815000006` saja untuk "memastikan grant-nya benar". Hasilnya: `is_active`
kembali bisa ditulis kasir, dan UPDATE pada `transactions` kembali terbuka.

Untuk `is_active` kerusakannya tertahan — trigger
`guard_profile_privileged_fields` (`20260821000002:28`) tetap menolaknya, dan
komentar migrasinya menyatakan trigger itu sengaja dipertahankan "seandainya
grant itu kembali suatu hari". Lapisan itu bekerja persis sebagaimana
dimaksudkan. Untuk `transactions` tidak ada trigger penyeimbangnya: `customer_fee`
dan `provider_cost` akan kembali bisa diubah kasir pada shift yang masih
terbuka.

**Usulan.** Jadikan keadaan akhir privilege sebagai satu migrasi "desired state"
yang dijalankan paling akhir, alih-alih menyebar GRANT/REVOKE di sepuluh file
yang saling menimpa. Saat ini, menjawab "apa sebenarnya hak `authenticated` atas
`profiles`?" perlu membaca empat file dalam urutan yang benar.

### M-7 `ALTER TABLE ... DISABLE TRIGGER` di dua migrasi backfill bisa meninggalkan trigger mati

`20260814000001_laba_calculation.sql:81` dan
`20260814000002_backfill_legacy_capital.sql:6` mematikan
`trg_prevent_closed_shift_edit`, menjalankan `UPDATE`, lalu menyalakannya lagi.
Kalau `UPDATE`-nya gagal di tengah dan transaksinya tidak membungkus ketiganya,
trigger itu tetap mati untuk **seluruh tabel** — bukan hanya untuk sesi yang
menjalankannya.

Keduanya backfill sekali pakai dan sudah lewat. Yang membuatnya masih relevan:
`reset_database.sql` + replay seluruh migrasi akan menjalankannya lagi. Migrasi
yang lebih baru sudah memakai pola yang benar — `set_config('brilink.audit_override',
'on', true)`, yang transaction-local dan otomatis hilang saat transaksinya batal.
Dua file ini mendahului pola itu.

### M-8 Kasir tidak bisa melihat jejak `audit` dan `reject` atas shiftnya sendiri

`20260815000008:43`

```sql
CREATE POLICY "amendments_select" ON public.shift_amendments FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'owner'));
```

`shift_amendments.user_id` adalah **penulis** barisnya, bukan pemilik shiftnya.
Untuk baris `audit` dan `reject`, penulisnya adalah owner. Jadi kasir hanya
pernah melihat baris `amend` dan `cancel` buatannya sendiri; koreksi owner atas
angkanya tidak terlihat.

Ini **disengaja dan sudah dikompensasi**: `src/routes/_authenticated/dashboard.tsx:640`
menjelaskan bahwa alasan penolakan sengaja ditempelkan ke baris `shifts`
(`rejection_reason`) justru karena RLS ini. Saya mencatatnya karena tabel
"Riwayat Perbaikan, Penolakan & Pembatalan Shift" di `reports.tsx` tampil juga
untuk kasir dan akan selalu terasa kurang lengkap dari sisi mereka — bukan bug,
tapi sesuatu yang perlu diketahui sebelum ada yang "memperbaikinya".

---

## Yang sudah ditegakkan dengan benar

Bagian ini sama pentingnya dengan temuan di atas: ia menandai apa yang **tidak**
boleh diubah sambil memperbaiki yang lain.

**Kasir tidak bisa mempromosikan dirinya.** `user_roles` hanya diberi `SELECT`
ke `authenticated` (`20260815000006:56`) dan tidak punya policy INSERT/UPDATE/DELETE
sama sekali. RLS aktif tanpa policy berarti tertutup. Dua lapis sekaligus, dan
komentar `20260815000006` menunjukkan ini hasil perbaikan sadar atas default
Supabase yang semula memberi ALL.

**Angka keuangan shift hanya bisa ditulis RPC.** `20260815000002` mencabut
INSERT/UPDATE pada `shifts` dan menyisakan tepat satu kolom untuk klien:
`GRANT UPDATE (deposit_confirmed)`. Privilege kolom ditegakkan Postgres core,
sebelum RLS. `bank_balances` dan `ppob_balances` read-only penuh bagi klien.
Jadi `initial_physical_balance` — yang dulu bisa di-`PATCH` jadi 0 untuk
menggelembungkan Laba sebesar seluruh kas pembukaan — kini tidak bisa disentuh.

**Imutabilitas shift tertutup berlapis lima.** Trigger pada `shifts`
(`prevent_closed_shift_financial_edit`, memeriksa 19 kolom satu per satu), pada
`bank_balances`/`ppob_balances` (`prevent_closed_shift_account_edit`), pada
`transactions` (`prevent_closed_shift_txn_edit`), pada `receivables`
(`prevent_closed_shift_receivable_edit`, yang tetap mengizinkan pelunasan lintas
shift tapi mengunci nominal dan identitasnya), ditambah
`prevent_closed_shift_delete` dan `prevent_direct_shift_close`. Yang terakhir
menutup kasus yang pernah benar-benar terjadi: shift "ditutup" lewat SQL
langsung tanpa mengisi baris saldo (komentar `20260909000006` menyebutnya "kasus
Eci").

**`brilink.audit_override` tidak bisa dinyalakan klien.** Ini yang paling saya
curigai sebelum membacanya, dan ia aman karena tiga hal yang berlaku bersamaan:
`set_config` ada di `pg_catalog`, sementara `supabase/config.toml:13` hanya
memaparkan `schemas = ["public", "graphql_public"]` — jadi tidak ada endpoint
`/rpc/set_config`; setiap fungsi yang menyalakannya memakai bentuk
transaction-local (`set_config(..., true)`) dan mematikannya lagi secara
eksplisit; dan transaksi yang batal membuang setelan itu dengan sendirinya. Tidak
ada fungsi di `public` yang memaparkan `set_config` ke pemanggil.

**Urutan override sudah benar.** `20260909000008` memperbaiki bug nyata:
`owner_adjust_balance` dulu menyalakan override _setelah_ meng-`UPDATE`
`bank_balances`, sehingga trigger BEFORE UPDATE memblokir perubahannya sendiri.
Definisi terakhirnya menyalakan override lebih dulu.

**Semua fungsi `SECURITY DEFINER` punya `SET search_path`.** Saya periksa satu
per satu; tidak ada yang terlewat. Tanpa itu, fungsi definer bisa dibajak lewat
skema milik pemanggil.

**Fungsi `admin_*` memeriksa role di baris pertama.** `admin_create_user`,
`admin_update_user_email`, `admin_set_user_active`, dan `admin_list_users`
semuanya membuka dengan `IF NOT public.has_role(auth.uid(), 'owner') THEN RAISE`.
`admin_set_user_active` juga menolak mengubah status akun sendiri dan menolak
menonaktifkan akun owner mana pun — dua penjagaan yang mencegah bisnis terkunci
dari akunnya sendiri. `admin_delete_user` sudah dipensiunkan menjadi stub yang
selalu `RAISE`, setelah ditemukan bahwa `DELETE FROM auth.users` meng-cascade
sampai menghapus seluruh jejak audit kasir — persis kebalikan dari tujuan
aplikasi ini.

**Penonaktifan akun ditegakkan di dua tempat.** `profiles.is_active` diperiksa
`open_shift_atomic`, dan `auth.users.banned_until` memblokir login di lapis
GoTrue. Penutupan shift sengaja tetap diizinkan agar menonaktifkan seseorang di
tengah shift tidak meninggalkan shift yang menggantung.

**Rumus konsisten di klien dan server.** Empat fungsi menghitung ulang
`modal_awal`/`modal_akhir` — `close_shift_atomic` (`20260910000001`),
`owner_adjust_balance` (`20260909000008`), `owner_adjust_shift_field`
(`20260910000000`), dan `owner_reject_shift_report` (`20260910000000`) — dan
keempatnya memakai bentuk yang identik:

```
modal_awal  = initial_physical_balance + SUM(bank_balances.initial_amount) + additional_capital
modal_akhir = final_physical_balance   + SUM(bank_balances.final_amount)   + settlement_amount + total_expenses
```

Keduanya cocok persis dengan `saldoAwal()` dan `saldoAkhir()` di
`src/lib/ledger.ts`, dan **PPOB dikecualikan di kedua sisi** sebagaimana
dimaksudkan. Satu-satunya penyimpangan adalah M-1 di atas, yang hari ini tidak
berdampak. `owner_withdrawal` sudah dibersihkan dari seluruh rumus oleh
`20260909000007`, dan overload lama `close_shift_atomic` sudah di-`DROP`
(`20260909000003`, `20260909000007`) sehingga PostgREST tidak bisa memanggil
versi usang.

**Kedua sisi rantai saldo memakai pemilih shift yang sama.**
`last_closed_shift_balances()` (yang mengisi form) dan
`assert_opening_continuity()` (yang memvalidasinya) sama-sama memanggil
`previous_closed_shift_id()`. Komentar `20260821000001:48-56` menyatakan ini
disengaja, dengan alasan yang tepat: kalau keduanya memilih dengan cara berbeda,
kasir akan disodori angka yang kemudian ditolak database sendiri.
`assert_opening_continuity` juga beriterasi dari baris shift sebelumnya, bukan
dari payload yang dikirim, sehingga akun yang dihilangkan dari payload tetap
ikut diperiksa — saldo tidak bisa dilenyapkan hanya dengan tidak
menyebutkannya.

**`profit_net` tidak bisa dikarang.** Ia `GENERATED ALWAYS AS (customer_fee -
provider_cost) STORED` (`20260804000000:157`), jadi nilai kiriman klien ditolak
database. Catatan: `customer_fee` dan `provider_cost` memang bisa ditulis kasir
pada shiftnya sendiri yang masih terbuka (lihat M-6), tapi Laba/FBI/FS diturunkan
dari saldo, **bukan** dari tabel transaksi — jadi mengarang transaksi tidak
menggeser angka uang mana pun, hanya tally "Laba bersih" yang tampil ke owner di
panel transaksi dan jumlah transaksi di laporan.

**Indeks yang diasumsikan klien benar-benar ada.** `transactions (shift_id,
client_ref) WHERE client_ref IS NOT NULL` — yang menjadi dasar penanganan
`23505` sebagai "sudah tersimpan, tidak diduplikasi" di
`dashboard.tsx:945` — ada di `20260804000000:162`. Unik
`profiles (lower(username))`, yang menjadi dasar pesan "username sudah dipakai"
di `settings.tsx:73`, ada di `20260821000002:67`, dan `handle_new_user` sudah
diperbarui untuk menangani tabrakannya dengan pesan yang jelas (nama yang
diketik owner) atau akhiran angka (nama turunan email).

**`reset_database.sql` tidak masuk repositori.** Ia ter-`gitignore` dan
`git ls-files` memastikan ia tidak terlacak.

---

## Catatan tambahan, bukan temuan

**`graphql_public` ikut dipaparkan.** `supabase/config.toml:13` memaparkan
`graphql_public` di samping `public`, jadi pg_graphql aktif dan `graphql.resolve`
bisa dipanggil. pg_graphql menghormati RLS dan privilege tabel, jadi ini bukan
permukaan baru — apa pun yang bisa dibaca lewat REST bisa dibaca lewat GraphQL,
tidak lebih. Disebut di sini karena setiap pengujian akses sebaiknya mencakup
kedua endpoint, bukan hanya REST.

**`max_rows = 1000`** di `config.toml:18` membenarkan alasan chunking per 40
shift di `reports.tsx:152` dan `ShiftRecapTable.tsx:129`. Batas itu nyata, dan
komentar di kedua file sudah menghitungnya dengan benar (40 shift × 10 bank =
400 baris).

**Yang tidak saya periksa.** Audit ini membaca kode, bukan database yang hidup.
Jadi saya tidak bisa memastikan: (a) bahwa keadaan produksi memang sama dengan
hasil replay seluruh migrasi — `20260822000000:93` sendiri mencatat kasus di mana
migrasi lama tampaknya pernah dijalankan ulang setelah yang baru, meninggalkan
dua policy SELECT pada `branches`; (b) apakah ada policy, trigger, atau grant
yang pernah dibuat manual lewat dashboard Supabase dan tidak tercatat di
`migrations/`; (c) apakah `supabase_migrations.schema_migrations` benar-benar
berisi seluruh file ini, sebagaimana diwajibkan `AGENTS.md`. Ketiganya hanya bisa
dijawab dengan membaca katalog database produksi.
