-- Menutup temuan S-2 (audit 19 Oktober 2026, supabase/AUDIT.md).
--
-- open_shift_atomic() menjaga "satu shift terbuka per cabang" dengan:
--
--   IF EXISTS (SELECT 1 FROM public.shifts
--              WHERE branch_id = _resolved_branch AND status = 'open') THEN
--     RAISE EXCEPTION 'Masih ada shift aktif di cabang ini...';
--   END IF;
--
-- Itu check-then-act tanpa penguncian. Dua transaksi bersamaan membaca
-- snapshot-nya masing-masing, keduanya tidak melihat shift terbuka, keduanya
-- lolos, keduanya INSERT.
--
-- Aturan per-AKUN tidak punya celah ini karena ditegakkan di tempat yang tidak
-- bisa dibalap -- indeks unik parsial di 20260804000000:
--
--   CREATE UNIQUE INDEX shifts_one_open_per_user
--     ON public.shifts (user_id) WHERE status = 'open';
--
-- Aturan per-CABANG tidak punya padanannya. Migrasi yang memperkenalkan
-- pemeriksaan itu bernama guard_shift_concurrency_and_cancellation
-- (20260907000001), tapi yang ditambahkan hanya EXISTS-nya.
--
-- Akibatnya kalau balapan itu terjadi: dua kasir di outlet yang sama membuka
-- shift dalam detik yang sama -- pergantian pagi, dua orang menekan "Mulai
-- shift" hampir serentak. Keduanya berhasil. Keduanya diisi otomatis dengan
-- saldo akhir shift sebelumnya yang SAMA, karena last_closed_shift_balances()
-- mengembalikan baris yang sama untuk keduanya dan assert_opening_continuity()
-- meloloskan keduanya. Rantai saldo bercabang: uang yang sama menjadi modal
-- awal dua shift, dan saat keduanya ditutup, selisih saldo yang sama dihitung
-- sebagai laba dua kali. Tidak ada layar yang menampilkan kejanggalan itu --
-- kedua shift tampak sah, laporan hanya menjumlahkan Laba keduanya.
--
-- Dua lapis dipakai, dan keduanya perlu:
--
--   1. INDEKS UNIK PARSIAL -- jaminannya. Berlaku untuk jalur apa pun, bukan
--      hanya RPC ini, dan tidak bisa dibalap karena ditegakkan storage engine.
--
--   2. ADVISORY LOCK di dalam RPC -- demi pesannya. Tanpa ini, pemenang kedua
--      balapan menerima galat 23505 mentah yang menyebut nama indeks; klien
--      memetakan 23505 ke "Masih ada shift aktif di akun ini", yang keliru
--      untuk tabrakan cabang. Dengan lock, transaksi kedua menunggu lalu
--      melihat shift pertama di pemeriksaan EXISTS dan menerima pesan cabang
--      yang benar. Indeksnya tinggal menjadi jaring terakhir.
--
-- Diterapkan saat produksi tidak punya satu pun shift terbuka dan nol cabang
-- yang melanggar, jadi pembuatan indeksnya tidak mungkin gagal karena data lama
-- dan tidak ada kasir yang terganggu.
--
-- CREATE INDEX biasa, bukan CONCURRENTLY: `supabase db push` membungkus tiap
-- migrasi dalam transaksi, dan CONCURRENTLY tidak boleh berada di dalamnya.
-- Dengan 274 baris, lock-nya seketika.
--
-- Catatan soal owner_reject_shift_report(): ia mengubah shift tertutup menjadi
-- 'open' lagi, jadi secara teori bisa menabrak indeks ini. Tidak terjadi,
-- karena ia sudah menolak lebih dulu bila ada shift lain yang dibuka setelah
-- shift tersebut di cabang yang sama -- dengan pesan yang jelas, bukan 23505.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 0) Pemeriksaan data lebih dulu, supaya kegagalannya bisa dibaca
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  _pelanggar TEXT;
BEGIN
  SELECT string_agg(branch_id::text || ' (' || n || ' shift)', '; ')
    INTO _pelanggar
  FROM (
    SELECT branch_id, count(*) AS n
    FROM public.shifts
    WHERE status = 'open' AND branch_id IS NOT NULL
    GROUP BY branch_id
    HAVING count(*) > 1
  ) x;

  IF _pelanggar IS NOT NULL THEN
    RAISE EXCEPTION
      'Tidak bisa memasang indeks: masih ada cabang dengan lebih dari satu shift terbuka — %. Tutup atau batalkan shift berlebih itu lebih dulu, lalu jalankan ulang migrasi ini.',
      _pelanggar;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) Jaminan: satu shift terbuka per cabang
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_branch
  ON public.shifts (branch_id)
  WHERE status = 'open' AND branch_id IS NOT NULL;

COMMENT ON INDEX public.shifts_one_open_per_branch IS
  'Satu shift terbuka per cabang, ditegakkan storage engine supaya tidak bisa dibalap. Pasangan dari shifts_one_open_per_user. Lihat supabase/AUDIT.md temuan S-2.';

-- ---------------------------------------------------------------------------
-- 2) Pesan yang benar: serialkan pembukaan per cabang
--
--    Identik dengan definisi di 20260907000002, kecuali satu baris
--    pg_advisory_xact_lock yang ditambahkan sebelum pemeriksaan EXISTS cabang.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.open_shift_atomic(
  _user_id UUID,
  _branch_id UUID,
  _initial_cash NUMERIC,
  _bank_snapshots JSONB,
  _ppob_snapshots JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _bank RECORD;
  _ppob RECORD;
  _bank_total NUMERIC := 0;
  _ppob_total NUMERIC := 0;
  _modal_awal NUMERIC;
  _shift_id UUID;
  _resolved_branch UUID;
  _is_active BOOLEAN;
  _branch_active BOOLEAN;
BEGIN
  IF _user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Hanya dapat membuka shift untuk akun sendiri';
  END IF;

  IF EXISTS (SELECT 1 FROM public.shifts WHERE user_id = _user_id AND status = 'open') THEN
    RAISE EXCEPTION 'Masih ada shift aktif di akun ini. Tutup dulu shift tersebut.';
  END IF;

  SELECT branch_id, is_active INTO _resolved_branch, _is_active
  FROM public.profiles WHERE id = _user_id;

  IF NOT COALESCE(_is_active, true) THEN
    RAISE EXCEPTION 'Akun Anda dinonaktifkan. Hubungi owner.';
  END IF;
  IF _resolved_branch IS NULL THEN
    RAISE EXCEPTION 'Akun belum terdaftar di cabang manapun. Hubungi owner.';
  END IF;

  SELECT is_active INTO _branch_active
  FROM public.branches WHERE id = _resolved_branch;

  IF NOT COALESCE(_branch_active, true) THEN
    RAISE EXCEPTION 'Cabang ini dinonaktifkan. Hubungi owner.';
  END IF;

  -- Serialkan pembukaan shift per cabang. Dilepas otomatis saat transaksi
  -- selesai; pemeriksaan EXISTS di bawah barulah yang menolak, sehingga kasir
  -- kedua menerima pesan cabang yang benar alih-alih galat indeks mentah.
  PERFORM pg_advisory_xact_lock(hashtext('brilink_branch_open:' || _resolved_branch::text));

  IF EXISTS (SELECT 1 FROM public.shifts WHERE branch_id = _resolved_branch AND status = 'open') THEN
    RAISE EXCEPTION 'Masih ada shift aktif di cabang ini. Tunggu kasir sebelumnya menutup shift.';
  END IF;

  IF COALESCE(_initial_cash, 0) < 0 THEN
    RAISE EXCEPTION 'Modal awal tidak boleh negatif';
  END IF;

  FOR _bank IN SELECT * FROM jsonb_to_recordset(_bank_snapshots) AS x(bank_name TEXT, initial_amount NUMERIC)
  LOOP
    IF COALESCE(_bank.initial_amount, 0) < 0 THEN
      RAISE EXCEPTION 'Saldo awal % tidak boleh negatif', _bank.bank_name;
    END IF;
    _bank_total := _bank_total + COALESCE(_bank.initial_amount, 0);
  END LOOP;

  FOR _ppob IN SELECT * FROM jsonb_to_recordset(_ppob_snapshots) AS x(provider_name TEXT, initial_amount NUMERIC)
  LOOP
    IF COALESCE(_ppob.initial_amount, 0) < 0 THEN
      RAISE EXCEPTION 'Saldo awal % tidak boleh negatif', _ppob.provider_name;
    END IF;
    _ppob_total := _ppob_total + COALESCE(_ppob.initial_amount, 0);
  END LOOP;

  PERFORM public.assert_opening_continuity(
    public.previous_closed_shift_id(_resolved_branch, _user_id),
    _bank_snapshots,
    _ppob_snapshots
  );

  -- Saldo Awal = Saldo Awal Buka Kasir + Saldo Rekening Bank (tanpa PPOB)
  _modal_awal := COALESCE(_initial_cash, 0) + _bank_total;

  INSERT INTO public.shifts (
    user_id,
    branch_id,
    initial_physical_balance,
    additional_capital,
    modal_awal,
    status
  )
  VALUES (
    _user_id,
    _resolved_branch,
    COALESCE(_initial_cash, 0),
    0,
    _modal_awal,
    'open'
  )
  RETURNING id INTO _shift_id;

  FOR _bank IN SELECT * FROM jsonb_to_recordset(_bank_snapshots) AS x(bank_name TEXT, initial_amount NUMERIC)
  LOOP
    INSERT INTO public.bank_balances (shift_id, bank_name, initial_amount, final_amount)
    VALUES (_shift_id, _bank.bank_name, COALESCE(_bank.initial_amount, 0), 0);
  END LOOP;

  FOR _ppob IN SELECT * FROM jsonb_to_recordset(_ppob_snapshots) AS x(provider_name TEXT, initial_amount NUMERIC)
  LOOP
    INSERT INTO public.ppob_balances (shift_id, provider_name, initial_amount, final_amount, topup_amount)
    VALUES (_shift_id, _ppob.provider_name, COALESCE(_ppob.initial_amount, 0), 0, 0);
  END LOOP;

  RETURN _shift_id;
END;
$$;

REVOKE ALL ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, JSONB, JSONB) TO authenticated, service_role;
