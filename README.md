# BRILink Ledger

Aplikasi Pelaporan Keuangan BRILink & PPOB

1. Pendahuluan & Tujuan Proyek

Pembukuan manual berbasis buku tulis atau spreadsheet Excel terbukti gagal memenuhi kebutuhan operasional agen BRILink dan PPOB modern. Masalah mendasar terletak pada ketidakmampuan sistem manual dalam melacak pergerakan "dua kantong uang" (tunai vs digital) yang terjadi secara simultan dalam satu transaksi, serta tingginya risiko kehilangan modal akibat piutang customer yang tidak tercatat. Aplikasi ini hadir sebagai solusi Sistem Arsitektur Akuntansi yang mengutamakan Data Integrity dan State Management untuk menggantikan proses rekapitulasi manual yang rawan human error.

Tujuan Strategis Proyek:

Optimalisasi Pencatatan Dua Akun: Menjamin sinkronisasi otomatis antara saldo fisik (kas di laci) dan saldo digital (EDC/rekening) menggunakan prinsip double-entry sederhana.

Akurasi Perhitungan Profit: Otomatisasi pemisahan Nominal Pokok, Fee Pelanggan, dan Biaya Provider untuk menghasilkan laporan laba bersih yang akurat secara real-time.

Perlindungan Modal & Audit Trail: Menyediakan jejak audit digital dan manajemen piutang untuk memitigasi risiko fraud serta melacak modal kerja yang sering "hilang" di lapangan.

Efisiensi Operasional: Memangkas waktu rekapitulasi harian dari 60 menit menjadi kurang dari 10 menit melalui otomatisasi laporan penutupan.

2. Persona Pengguna (User Personas)

Profil Pengguna

Tanggung Jawab Utama

Kebutuhan Sistem & Arsitektur

Owner (Pemilik)

Strategi bisnis, audit saldo harian, manajemen modal, dan pengawasan multi-user.

Dashboard cloud-synced untuk monitoring jarak jauh, akses laporan mutasi akun, dan kendali administratif penuh.

Cashier (Kasir)

Operasional harian shift, input transaksi real-time, dan serah terima kas.

Antarmuka intuitif dengan kecepatan input <15 detik, fitur Offline-First saat sinyal lemah, dan validasi input otomatis.

3. Kebutuhan Fungsional (Functional Requirements)

3.1 Login, Autentikasi & Role-Based Access (RBAC)

Sistem menggunakan JWT (JSON Web Token) untuk manajemen sesi yang aman.

Kasir dibatasi hanya pada akses endpoint operasional: pembukaan shift, input transaksi, dan penutupan shift aktif.

Owner memiliki akses administratif penuh, termasuk audit riwayat transaksi lintas shift dan manajemen database user.

Implementasi Session Timeout otomatis untuk mencegah akses tidak sah pada perangkat di lokasi toko.

3.2 Manajemen Pembukaan Shift (Opening Shift)

State Check Logic: Sistem harus memvalidasi bahwa tidak ada shift aktif di perangkat yang sama. Pembukaan shift baru hanya diizinkan jika shift sebelumnya telah status "Closed".

Machine Money Balance: Sistem secara otomatis melakukan state-pulling data saldo digital (Bank & PPOB) dari saldo akhir shift sebelumnya untuk menjaga kontinuitas data. Sumbernya shift tertutup terakhir di cabang yang sama — bukan shift terakhir kasir yang bersangkutan — dan kontinuitas itu ditegakkan di database: open_shift_atomic dan amend_open_shift menolak saldo awal yang berbeda dari saldo akhir shift sebelumnya. Akun yang belum pernah tercatat (shift pertama sebuah cabang, atau bank/provider yang baru ditambahkan) tetap bebas diisi.

Input Manual Saldo: Kasir wajib mengisi Saldo Fisik Awal (uang tunai di laci) secara manual sebagai modal awal shift.

3.3 Pencatatan Transaksi & Piutang (Core Transaction)

Setiap input transaksi harus memenuhi kaidah Idempotency untuk mencegah duplikasi data. Kasir wajib menginput:

Jenis Transaksi: (Tarik Tunai, Setor Tunai, Transfer, atau PPOB).

Pergerakan Akun: Menentukan akun sumber dan akun tujuan (Contoh: Tarik Tunai = Saldo Digital (+) dan Saldo Fisik (-)).

Komponen Biaya: Input Nominal Pokok, Fee Admin Pelanggan, dan Biaya Provider.

Manajemen Piutang (Receivables): Jika transaksi bersifat hutang, kasir wajib menginput Nama Customer, Nominal Piutang, dan Tanggal Janji Bayar. Modal tidak dianggap berkurang hingga piutang dilunasi (status mutation tracking).

3.4 Manajemen Penutupan Shift (Closing Shift)

Sistem akan melakukan kalkulasi otomatis terhadap total transaksi untuk menghasilkan nilai Expected Balance. Kasir wajib mengisi formulir validasi fisik:

Saldo Fisik Akhir: Sisa uang tunai fisik di laci kasir.

Permintaan Top-up Saldo: Dokumentasi kebutuhan dana digital untuk shift berikutnya.

Pengeluaran (Expenses): Catatan biaya operasional yang diambil dari kas (misal: listrik, parkir, bensin).

Detail Saldo Mesin (Bank): Kasir menginput sisa saldo aplikasi/rekening pada bank berikut:

Bank

Field Input (Manual)

BRI D

Jumlah Saldo Akhir BRI D

BRI Y

Jumlah Saldo Akhir BRI Y

Mandiri

Jumlah Saldo Akhir Mandiri

BCA

Jumlah Saldo Akhir BCA

PAPUA

Jumlah Saldo Akhir PAPUA

BNI46

Jumlah Saldo Akhir BNI46

SEABANK

Jumlah Saldo Akhir SEABANK

SUPERBANK

Jumlah Saldo Akhir SUPERBANK

FLIP

Jumlah Saldo Akhir FLIP

Detail Saldo PPOB: Kasir menginput sisa saldo pada distributor berikut:

Distributor PPOB

Field Input (Manual)

Digipost

Jumlah Saldo Akhir Digipost

Anggichanger

Jumlah Saldo Akhir Anggichanger

Radar

Jumlah Saldo Akhir Radar

Saveplus

Jumlah Saldo Akhir Saveplus

I-Simpel

Jumlah Saldo Akhir I-Simpel

Penolakan Laporan (Report Rejection): Owner dapat menolak laporan penutupan sebuah shift dari halaman Laporan & Audit dengan alasan wajib. Shift kembali berstatus "Open" pada kasir yang bersangkutan, angka penutupannya (saldo tunai akhir, saldo bank/PPOB akhir, pengeluaran, setoran, settlement, dan konfirmasi setoran) dikosongkan, sedangkan modal awal tidak berubah. Form Tutup Shift terisi kembali dengan angka lama sebagai bahan koreksi, dan alasan penolakan ditampilkan ke kasir. Penolakan hanya diizinkan pada shift terakhir di cabang tersebut — jika saldo penutupannya sudah dipakai sebagai modal awal shift berikutnya, owner memakai fitur Audit Saldo agar rantai saldo antar shift tidak putus. Setiap penolakan tercatat permanen di riwayat beserta angka yang dibatalkan.

3.5 Setoran Kasir (Cashier Deposit)

Fitur dokumentasi serah terima uang fisik dari kasir kepada pemilik.

Field Deposit_Amount harus divalidasi terhadap Saldo Fisik Akhir untuk memastikan akurasi dana yang berpindah tangan.

4. Kebutuhan Non-Fungsional (Non-Functional Requirements)

Security & Data Integrity: Enkripsi password menggunakan Bcrypt dan proteksi data mutasi agar tidak dapat diubah (immutable) setelah shift ditutup tanpa override dari Owner.

Offline-First Capability: Menggunakan local storage (SQLite) untuk menyimpan transaksi saat sinyal lemah, dengan mekanisme Asynchronous Sync ke server utama saat koneksi pulih.

Usability: Antarmuka berbasis preset (favorit) agar input transaksi rutin tidak memakan waktu lebih dari 15 detik.

Accuracy & Variance Warning: Sistem wajib menampilkan peringatan jika terdapat selisih (variance) antara System Balance dan Saldo Fisik Akhir yang diinput manual.

5. Skema Database Tingkat Tinggi (High-Level Database Schema)

Arsitektur database dirancang untuk mendukung laporan arus kas per akun (Ledger):

Table: Users

(ID, Username, Password_Hash, Role [Owner/Cashier], Created_At)

Table: Shifts

(ID, User_ID, Start_Time, End_Time, Initial_Physical_Balance, Final_Physical_Balance, Total_Expenses, Deposit_Amount, Status [Open/Closed])

Table: Transactions (Ledger Utama)

(ID, Shift_ID, Transaction_Type, Source_Account, Destination_Account, Principal_Amount, Customer_Fee, Provider_Cost, Profit_Net, Created_At)

Table: Bank_Balances

(ID, Shift_ID, Bank_Name, Final_Amount)

Table: PPOB_Balances

(ID, Shift_ID, Provider_Name, Final_Amount)

Table: Receivables (Piutang)

(ID, Transaction_ID, Customer_Name, Debt_Amount, Due_Date, Status [Pending/Paid])

Relationship Logic: Shift_ID berfungsi sebagai Foreign Key sentral. Tabel Transactions mencatat setiap mutasi saldo secara atomik, sementara Bank_Balances dan PPOB_Balances menyimpan snapshot posisi keuangan di akhir shift. Kaitan antara Transactions dan Receivables memastikan modal kerja yang tertahan di pelanggan tetap terpantau dalam audit harian Owner.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
