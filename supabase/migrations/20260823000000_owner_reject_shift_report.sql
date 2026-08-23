-- Tombol "Tolak Laporan": owner mengembalikan shift yang sudah ditutup kepada
-- kasirnya supaya kasir sendiri yang membetulkan angka penutupan.
--
-- Sampai sekarang laporan yang keliru cuma punya satu pintu: owner_adjust_balance
-- (20260816000000), yang membetulkan SATU saldo bank/PPOB per panggilan. Itu pas
-- untuk rekonsiliasi mutasi rekening, tapi bukan untuk kesalahan yang paling
-- sering terjadi -- saldo tunai akhir salah ketik, pengeluaran lupa dicatat,
-- kolom setoran tertukar dengan settlement. Membetulkannya dari sisi owner
-- berarti owner menebak angka yang benar; yang tahu isi laci justru kasirnya.
--
-- Jadi penolakan mengembalikan shift ke status 'open' beserta alasannya, dan
-- kasir mengisi ulang form Tutup Shift. Empat hal yang harus dijaga:
--
--   1. Angka penutupan lama dibersihkan, bukan ditinggalkan. Shift 'open' yang
--      masih menyimpan modal_akhir akan muncul di laporan owner sebagai shift
--      aktif yang sudah punya Laba Fee -- kontradiksi yang tidak ditandai apa
--      pun. Salinannya disimpan di shifts.rejected_snapshot supaya form kasir
--      bisa terisi otomatis: yang diminta koreksi, bukan ketik ulang lima belas
--      kolom saldo dari nol.
--
--   2. Kontinuitas cabang (20260821000001) tidak boleh bocor. Kalau sudah ada
--      shift lain sesudahnya di cabang yang sama, saldo penutupan shift ini
--      sudah menjadi modal awal shift itu, dan mengubahnya memutus rantainya
--      tanpa satu pun baris yang menandai. Penolakan ditolak, owner diarahkan
--      ke tombol Audit yang memang menghitung ulang modal.
--
--   3. Satu kasir hanya boleh punya satu shift terbuka
--      (shifts_one_open_per_user). Kalau kasirnya sudah membuka shift baru,
--      penolakan akan gagal dengan galat duplicate key yang tidak terbaca --
--      jadi kondisinya diperiksa lebih dulu dan dijelaskan.
--
--   4. Setoran yang sudah dikonfirmasi ikut dibuka lagi (deposit_confirmed
--      kembali false). Nominalnya akan diisi ulang kasir, jadi konfirmasi lama
--      tidak boleh menempel pada angka yang belum tentu sama.
--
-- Alasan wajib diisi dan tersimpan permanen, sama seperti audit saldo: kasir
-- harus tahu apa yang salah, dan owner tidak bisa membatalkan sebuah laporan
-- tanpa meninggalkan jejak.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Jejak penolakan menempel di baris shift, bukan cuma di shift_amendments
--
--    amendments_select hanya membuka baris milik sendiri (atau owner), dan
--    baris penolakan itu milik owner yang menekan tombolnya -- kasir tidak
--    akan pernah bisa membacanya. Alasan penolakan justru harus sampai ke
--    kasir, jadi tempatnya di shifts, yang memang boleh dibaca pemiliknya.
--
--    Tidak ada GRANT baru: authenticated cuma memegang UPDATE (deposit_confirmed)
--    sejak 20260815000006, jadi ketiga kolom ini hanya bisa ditulis fungsi
--    SECURITY DEFINER di bawah.
-- ---------------------------------------------------------------------------
ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS rejected_snapshot JSONB;

COMMENT ON COLUMN public.shifts.rejected_at IS
  'Kapan laporan penutupan terakhir kali ditolak owner. Tetap terisi setelah kasir menutup ulang, sebagai penanda audit.';
COMMENT ON COLUMN public.shifts.rejection_reason IS
  'Alasan penolakan dari owner, ditampilkan ke kasir di halaman Shift dan Tutup Shift.';
COMMENT ON COLUMN public.shifts.rejected_snapshot IS
  'Angka penutupan yang ditolak, dipakai mengisi ulang form Tutup Shift agar kasir mengoreksi, bukan mengetik ulang.';

-- ---------------------------------------------------------------------------
-- 2) Izinkan tindakan baru di jejak amandemen
-- ---------------------------------------------------------------------------
ALTER TABLE public.shift_amendments DROP CONSTRAINT IF EXISTS shift_amendments_action_check;
ALTER TABLE public.shift_amendments
  ADD CONSTRAINT shift_amendments_action_check
  CHECK (action IN ('amend', 'cancel', 'audit', 'reject'));

-- ---------------------------------------------------------------------------
-- 3) Penolakan
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.owner_reject_shift_report(
  _shift_id UUID,
  _reason TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _shift public.shifts%ROWTYPE;
  _reason_clean TEXT := btrim(COALESCE(_reason, ''));
  _snapshot JSONB;
  _cashier TEXT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat menolak laporan shift';
  END IF;
  IF length(_reason_clean) < 5 THEN
    RAISE EXCEPTION 'Alasan penolakan wajib diisi (minimal 5 karakter)';
  END IF;

  -- Dikunci: dua penolakan bersamaan atas shift yang sama akan membuat yang
  -- kedua menyimpan snapshot kosong hasil pembersihan yang pertama.
  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id FOR UPDATE;
  IF _shift.id IS NULL THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;
  IF _shift.status <> 'closed' THEN
    RAISE EXCEPTION 'Shift ini belum ditutup — belum ada laporan yang bisa ditolak';
  END IF;

  -- (2) Shift ini harus yang paling akhir di cabangnya. previous_closed_shift_id
  -- adalah pemilih yang sama dengan yang dipakai buka shift, jadi "paling akhir"
  -- di sini berarti persis "yang saldonya akan dipakai shift berikutnya".
  IF public.previous_closed_shift_id(_shift.branch_id, _shift.user_id)
       IS DISTINCT FROM _shift.id THEN
    RAISE EXCEPTION 'Sudah ada shift lain yang ditutup setelah shift ini di cabang yang sama. Saldo penutupannya sudah jadi modal awal shift berikutnya — koreksi lewat tombol Audit, atau tolak shift yang terbaru lebih dulu.';
  END IF;

  -- Shift penerus yang masih terbuka tidak terlihat oleh pemilih di atas, tapi
  -- modal awalnya sudah terkunci ke saldo penutupan shift ini.
  IF EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.id <> _shift.id
      AND s.start_time > _shift.start_time
      AND CASE WHEN _shift.branch_id IS NOT NULL
                 THEN s.branch_id = _shift.branch_id
                 ELSE s.branch_id IS NULL AND s.user_id = _shift.user_id
          END
  ) THEN
    RAISE EXCEPTION 'Sudah ada shift yang dibuka setelah shift ini di cabang yang sama, memakai saldo penutupannya sebagai modal awal. Tutup atau batalkan shift tersebut lebih dulu.';
  END IF;

  -- (3) Satu shift terbuka per kasir.
  IF EXISTS (
    SELECT 1 FROM public.shifts WHERE user_id = _shift.user_id AND status = 'open'
  ) THEN
    SELECT username INTO _cashier FROM public.profiles WHERE id = _shift.user_id;
    RAISE EXCEPTION 'Kasir % sedang menjalankan shift lain. Laporan ini baru bisa dikembalikan setelah shift tersebut ditutup atau dibatalkan.',
      COALESCE(_cashier, 'yang bersangkutan');
  END IF;

  _snapshot := jsonb_build_object(
    'end_time', _shift.end_time,
    'final_physical_balance', _shift.final_physical_balance,
    'additional_capital', _shift.additional_capital,
    'total_expenses', _shift.total_expenses,
    'expense_notes', _shift.expense_notes,
    'topup_request', _shift.topup_request,
    'deposit_amount', _shift.deposit_amount,
    'deposit_confirmed', _shift.deposit_confirmed,
    'settlement_amount', _shift.settlement_amount,
    'modal_akhir', _shift.modal_akhir,
    'bank', (SELECT COALESCE(jsonb_object_agg(bank_name, final_amount), '{}'::jsonb)
             FROM public.bank_balances WHERE shift_id = _shift_id),
    'ppob', (SELECT COALESCE(jsonb_object_agg(provider_name, final_amount), '{}'::jsonb)
             FROM public.ppob_balances WHERE shift_id = _shift_id)
  );

  -- prevent_closed_shift_financial_edit() menolak persis perubahan ini selama
  -- OLD.status = 'closed'. Override transaksi-lokal yang sama dengan
  -- owner_adjust_balance dipakai: set_config tidak bisa dipanggil lewat
  -- PostgREST, dan UPDATE atas shifts memang sudah dicabut dari klien.
  PERFORM set_config('brilink.audit_override', 'on', true);

  UPDATE public.shifts
  SET status                 = 'open',
      end_time               = NULL,
      final_physical_balance = NULL,
      modal_akhir            = NULL,
      additional_capital     = 0,
      total_expenses         = 0,
      expense_notes          = NULL,
      topup_request          = 0,
      deposit_amount         = 0,
      settlement_amount      = 0,
      deposit_confirmed      = false,
      rejected_at            = now(),
      rejection_reason       = _reason_clean,
      rejected_snapshot      = _snapshot
  WHERE id = _shift_id;

  PERFORM set_config('brilink.audit_override', 'off', true);

  -- Saldo awal tidak disentuh: yang ditolak laporan penutupannya, modal awal
  -- shift ini tetap terkunci ke penutupan shift sebelumnya.
  UPDATE public.bank_balances SET final_amount = 0 WHERE shift_id = _shift_id;
  UPDATE public.ppob_balances SET final_amount = 0, topup_amount = 0 WHERE shift_id = _shift_id;

  INSERT INTO public.shift_amendments (shift_id, user_id, action, before_data, after_data)
  VALUES (
    _shift_id, auth.uid(), 'reject',
    _snapshot || jsonb_build_object('modal_awal', _shift.modal_awal, 'reason', _reason_clean),
    NULL
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) Hak akses — owner diperiksa di dalam fungsi, sama seperti owner_adjust_balance
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.owner_reject_shift_report(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_reject_shift_report(UUID, TEXT) TO authenticated, service_role;
