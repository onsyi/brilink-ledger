-- Menutup temuan S-3 (audit 19 Oktober 2026, supabase/AUDIT.md).
--
-- assert_opening_continuity() mewajibkan saldo awal shift N+1 sama persis
-- dengan saldo akhir shift N. Pemeriksaan itu hanya berjalan SAAT shift N+1
-- dibuka, dan tidak pernah dijalankan ulang.
--
-- Jadi ketika owner mengoreksi final_amount shift N lewat owner_adjust_balance()
-- padahal shift N+1 sudah dibuka dengan angka lama, rantainya langsung tidak
-- konsisten: bank_balances[N].final_amount <> bank_balances[N+1].initial_amount.
-- Tidak ada galat, tidak ada peringatan, dan tidak ada baris mana pun yang
-- menandai selisih itu. Laba shift N+1 ikut salah, karena Saldo Awal-nya masih
-- memakai angka yang baru saja dinyatakan keliru.
--
-- Ironisnya owner_reject_shift_report() sudah punya penjagaan yang tepat untuk
-- kasus ini, dan pesan galatnya justru mengarahkan owner ke tombol Audit --
-- jalur yang tidak punya penjagaan apa pun.
--
-- ===========================================================================
-- Keputusan desain: RAMBATAN SATU LANGKAH KE DEPAN, bukan penolakan
-- ===========================================================================
--
-- Kalau saldo akhir shift N salah catat, maka saldo awal shift N+1 JUGA salah
-- catat -- keduanya merekam uang yang sama pada momen yang sama. Mengoreksi
-- keduanya itulah yang benar secara akuntansi, dan hasilnya kekal:
--
--   Laba N   = Saldo Akhir N - Saldo Awal N      -> naik sebesar delta
--   Laba N+1 = Saldo Akhir N+1 - Saldo Awal N+1  -> turun sebesar delta
--   ------------------------------------------------------------------
--   Total dua shift                              -> tidak bergeser
--
-- Alternatifnya -- menolak koreksi bila shift penerus sudah ada -- lebih aman
-- untuk ditulis tapi lebih buruk dalam pemakaian: owner harus membongkar rantai
-- dari ujung ke belakang. Dengan 274 shift tertutup dan shift harian, kesalahan
-- yang baru ketahuan seminggu kemudian menjadi praktis tak terkoreksi, dan itu
-- justru mendorong orang kembali ke SQL langsung -- yang dilarang AGENTS.md dan
-- yang menjadi sebab "kasus Eci" di 20260909000006.
--
-- Rambatannya BERHENTI di satu langkah, dan itu bukan kompromi: saldo AKHIR
-- shift N+1 tidak tersentuh, jadi batas N+1 -> N+2 tetap utuh. Yang rusak hanya
-- batas N -> N+1, dan hanya itu yang diperbaiki.
--
-- Untuk koreksi 'initial' arahnya dibalik: DITOLAK bila shift pendahulunya
-- punya saldo akhir yang berbeda, dengan pesan yang menunjuk shift itu.
-- Merambat ke belakang akan menggeser modal_akhir dan Laba shift pendahulu --
-- mengubah masa lalu yang sudah diaudit demi memperbaiki masa kini. Jadi
-- aturannya satu arah dan bisa diajarkan:
--
--   Koreksi dimasukkan di titik TERAWAL yang salah, lalu mengalir ke depan.
--
-- Shift pertama sebuah cabang tidak punya pendahulu, jadi saldo awalnya tetap
-- bebas dikoreksi -- kalau tidak, cabang baru tidak akan pernah bisa dibetulkan.
--
-- Yang sengaja TIDAK dilakukan:
--   * Tidak merambat lebih dari satu langkah (tidak perlu -- lihat di atas).
--   * Tidak merambat ke belakang (lihat di atas).
--   * Tidak mengubah owner_adjust_shift_field(): kolom yang diurusnya
--     (pengeluaran, settlement, kas fisik akhir, modal tambahan, setoran) tidak
--     ada satu pun yang menjadi saldo awal shift berikutnya. Hanya saldo
--     per-akun yang membentuk rantai.
--   * Tidak menyentuh data yang ada. Rantai yang mungkin SUDAH putus sebelum
--     migrasi ini dicari lewat check_balance_chain() di bawah, lalu dikoreksi
--     owner satu per satu -- dengan jejak, bukan lewat UPDATE massal di sini.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Tetangga shift dalam satu rantai
--
--    Diurutkan menurut start_time, bukan end_time seperti
--    previous_closed_shift_id(). Alasannya: start_time adalah satu-satunya
--    kunci yang berlaku seragam untuk shift terbuka maupun tertutup, dan sejak
--    indeks shifts_one_open_per_branch (20261020000000) hanya ada satu shift
--    terbuka per cabang -- sehingga urutan start_time berimpit dengan urutan
--    end_time. Shift penerus sengaja TIDAK difilter status: penerus yang masih
--    terbuka justru kasus yang paling sering (kasir sedang jaga saat owner
--    mengaudit shift semalam).
--
--    Internal saja -- tidak di-grant ke klien supaya tidak muncul sebagai
--    endpoint RPC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.shift_chain_neighbour(_shift_id UUID, _after BOOLEAN)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _branch UUID;
  _user   UUID;
  _start  TIMESTAMPTZ;
  _id     UUID;
BEGIN
  SELECT branch_id, user_id, start_time
    INTO _branch, _user, _start
  FROM public.shifts WHERE id = _shift_id;

  IF _start IS NULL THEN
    RETURN NULL;
  END IF;

  IF _branch IS NOT NULL THEN
    IF _after THEN
      SELECT id INTO _id FROM public.shifts
       WHERE branch_id = _branch AND start_time > _start
       ORDER BY start_time ASC LIMIT 1;
    ELSE
      SELECT id INTO _id FROM public.shifts
       WHERE branch_id = _branch AND start_time < _start AND status = 'closed'
       ORDER BY start_time DESC LIMIT 1;
    END IF;
    RETURN _id;
  END IF;

  -- Shift dari sebelum fitur cabang ada tidak punya branch_id. Hanya shift
  -- milik kasir yang sama yang boleh jadi tetangganya, persis seperti cadangan
  -- di previous_closed_shift_id().
  IF _after THEN
    SELECT id INTO _id FROM public.shifts
     WHERE user_id = _user AND branch_id IS NULL AND start_time > _start
     ORDER BY start_time ASC LIMIT 1;
  ELSE
    SELECT id INTO _id FROM public.shifts
     WHERE user_id = _user AND branch_id IS NULL AND start_time < _start
       AND status = 'closed'
     ORDER BY start_time DESC LIMIT 1;
  END IF;
  RETURN _id;
END;
$$;

REVOKE ALL ON FUNCTION public.shift_chain_neighbour(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Pemeriksa rantai
--
--    Mencari setiap batas antar-shift yang saldo akhirnya tidak sama dengan
--    saldo awal shift berikutnya. Menangkap rantai putus dari sebab APA PUN --
--    termasuk yang terjadi sebelum migrasi ini, lewat jalur audit lama atau
--    lewat SQL langsung.
--
--    LEFT JOIN dengan COALESCE, bukan INNER JOIN: akun yang hilang sama sekali
--    di shift berikutnya juga rantai yang putus (saldonya lenyap), bukan baris
--    yang pantas diabaikan.
--
--    Hanya membandingkan shift tertutup sebagai sisi "sebelum": shift terbuka
--    punya final_amount = 0 di semua akun sampai ditutup, jadi memasukkannya
--    akan melaporkan selisih palsu.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_balance_chain()
RETURNS TABLE (
  cabang          TEXT,
  jenis           TEXT,
  akun            TEXT,
  shift_sebelum   TIMESTAMPTZ,
  kasir_sebelum   TEXT,
  saldo_akhir     NUMERIC,
  shift_sesudah   TIMESTAMPTZ,
  kasir_sesudah   TEXT,
  saldo_awal      NUMERIC,
  selisih         NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat memeriksa rantai saldo';
  END IF;

  RETURN QUERY
  WITH rantai AS (
    SELECT
      s.id,
      s.branch_id,
      s.user_id,
      s.start_time,
      s.status,
      lead(s.id)         OVER w AS next_id,
      lead(s.start_time) OVER w AS next_start,
      lead(s.user_id)    OVER w AS next_user
    FROM public.shifts s
    WHERE s.branch_id IS NOT NULL
    WINDOW w AS (PARTITION BY s.branch_id ORDER BY s.start_time)
  ),
  pasangan AS (
    SELECT * FROM rantai WHERE next_id IS NOT NULL AND status = 'closed'
  )
  SELECT
    COALESCE(br.name, '—')::TEXT,
    'bank'::TEXT,
    a.bank_name::TEXT,
    p.start_time,
    COALESCE(pr1.username, '—')::TEXT,
    a.final_amount,
    p.next_start,
    COALESCE(pr2.username, '—')::TEXT,
    COALESCE(b.initial_amount, 0),
    COALESCE(b.initial_amount, 0) - a.final_amount
  FROM pasangan p
  JOIN public.bank_balances a ON a.shift_id = p.id
  LEFT JOIN public.bank_balances b
         ON b.shift_id = p.next_id AND b.bank_name = a.bank_name
  LEFT JOIN public.branches br ON br.id = p.branch_id
  LEFT JOIN public.profiles pr1 ON pr1.id = p.user_id
  LEFT JOIN public.profiles pr2 ON pr2.id = p.next_user
  WHERE COALESCE(b.initial_amount, 0) <> a.final_amount

  UNION ALL

  SELECT
    COALESCE(br.name, '—')::TEXT,
    'ppob'::TEXT,
    a.provider_name::TEXT,
    p.start_time,
    COALESCE(pr1.username, '—')::TEXT,
    a.final_amount,
    p.next_start,
    COALESCE(pr2.username, '—')::TEXT,
    COALESCE(b.initial_amount, 0),
    COALESCE(b.initial_amount, 0) - a.final_amount
  FROM pasangan p
  JOIN public.ppob_balances a ON a.shift_id = p.id
  LEFT JOIN public.ppob_balances b
         ON b.shift_id = p.next_id AND b.provider_name = a.provider_name
  LEFT JOIN public.branches br ON br.id = p.branch_id
  LEFT JOIN public.profiles pr1 ON pr1.id = p.user_id
  LEFT JOIN public.profiles pr2 ON pr2.id = p.next_user
  WHERE COALESCE(b.initial_amount, 0) <> a.final_amount

  ORDER BY 4, 2, 3;
END;
$$;

REVOKE ALL ON FUNCTION public.check_balance_chain() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_balance_chain() TO authenticated, service_role;

COMMENT ON FUNCTION public.check_balance_chain() IS
  'Owner saja. Mendaftar setiap batas antar-shift yang saldo akhirnya tidak sama dengan saldo awal shift berikutnya. Kosong = rantai utuh. Lihat supabase/AUDIT.md temuan S-3.';

-- ---------------------------------------------------------------------------
-- 3) owner_adjust_balance: tolak ke belakang, rambatkan ke depan
--
--    Dibanding definisi di 20260909000008, yang berubah tepat empat hal:
--      a. penjagaan 'initial' terhadap shift pendahulu, sebelum apa pun ditulis
--      b. blok rambatan 'final' ke shift penerus, sebelum override dimatikan
--      c. SELECT ... FOR UPDATE pada baris shift-nya, supaya dua audit
--         bersamaan atas shift yang sama tidak saling menimpa -- pola yang
--         sudah dipakai owner_reject_shift_report()
--      d. jejaknya mencatat apakah rambatan terjadi, plus satu baris terpisah
--         untuk shift penerus
--    Sisanya disalin apa adanya supaya diff-nya bisa diperiksa.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.owner_adjust_balance(
  _shift_id  UUID,
  _kind      TEXT,
  _name      TEXT,
  _field     TEXT,
  _new_value NUMERIC,
  _reason    TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _shift        public.shifts%ROWTYPE;
  _old_value    NUMERIC;
  _reason_clean TEXT := btrim(COALESCE(_reason, ''));
  _before       JSONB;
  _prev_id      UUID;
  _next_id      UUID;
  _prev_final   NUMERIC;
  _next_old     NUMERIC;
  _next_shift   public.shifts%ROWTYPE;
  _kasir        TEXT;
  _terambat     BOOLEAN := false;
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat mengaudit saldo';
  END IF;
  IF _kind NOT IN ('bank', 'ppob') THEN
    RAISE EXCEPTION 'Jenis akun harus bank atau ppob';
  END IF;
  IF _field NOT IN ('initial', 'final') THEN
    RAISE EXCEPTION 'Kolom harus initial atau final';
  END IF;
  IF _new_value IS NULL OR _new_value < 0 THEN
    RAISE EXCEPTION 'Nilai saldo baru tidak boleh negatif';
  END IF;
  IF length(_reason_clean) < 3 THEN
    RAISE EXCEPTION 'Alasan koreksi wajib diisi (minimal 3 karakter)';
  END IF;

  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id FOR UPDATE;
  IF _shift.id IS NULL THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;

  IF _kind = 'bank' THEN
    SELECT CASE WHEN _field = 'initial' THEN initial_amount ELSE final_amount END
    INTO _old_value
    FROM public.bank_balances
    WHERE shift_id = _shift_id AND bank_name = _name;
    IF _old_value IS NULL THEN
      RAISE EXCEPTION 'Akun bank % tidak ditemukan di shift ini', _name;
    END IF;
  ELSE
    SELECT CASE WHEN _field = 'initial' THEN initial_amount ELSE final_amount END
    INTO _old_value
    FROM public.ppob_balances
    WHERE shift_id = _shift_id AND provider_name = _name;
    IF _old_value IS NULL THEN
      RAISE EXCEPTION 'Akun PPOB % tidak ditemukan di shift ini', _name;
    END IF;
  END IF;

  IF _old_value = _new_value THEN
    RETURN;
  END IF;

  -- -----------------------------------------------------------------------
  -- Koreksi 'initial': tolak kalau memutus batas dengan shift PENDAHULU.
  -- Koreksi mengalir ke depan, jadi titik masuknya harus yang paling awal.
  -- -----------------------------------------------------------------------
  IF _field = 'initial' THEN
    _prev_id := public.shift_chain_neighbour(_shift_id, false);
    IF _prev_id IS NOT NULL THEN
      IF _kind = 'bank' THEN
        SELECT final_amount INTO _prev_final FROM public.bank_balances
         WHERE shift_id = _prev_id AND bank_name = _name;
      ELSE
        SELECT final_amount INTO _prev_final FROM public.ppob_balances
         WHERE shift_id = _prev_id AND provider_name = _name;
      END IF;

      IF _prev_final IS NOT NULL AND _prev_final <> _new_value THEN
        SELECT username INTO _kasir FROM public.profiles
         WHERE id = (SELECT user_id FROM public.shifts WHERE id = _prev_id);
        RAISE EXCEPTION
          'Saldo awal % harus sama dengan saldo akhir shift sebelumnya di cabang ini (% — shift %, ditutup %). Koreksi saldo AKHIR shift itu lebih dulu; perubahannya akan merambat ke sini sendiri.',
          _name,
          public.format_rupiah(_prev_final),
          COALESCE(_kasir, 'kasir sebelumnya'),
          to_char((SELECT end_time FROM public.shifts WHERE id = _prev_id), 'DD Mon YYYY HH24:MI');
      END IF;
    END IF;
  END IF;

  _before := jsonb_build_object(
    'kind', _kind, 'name', _name, 'field', _field,
    'value', _old_value,
    'modal_awal', _shift.modal_awal,
    'modal_akhir', _shift.modal_akhir,
    'reason', _reason_clean
  );

  -- Override dinyalakan sebelum UPDATE pertama: trigger
  -- prevent_closed_shift_account_edit() memeriksanya di BEFORE UPDATE.
  PERFORM set_config('brilink.audit_override', 'on', true);

  IF _kind = 'bank' THEN
    UPDATE public.bank_balances
    SET initial_amount = CASE WHEN _field = 'initial' THEN _new_value ELSE initial_amount END,
        final_amount   = CASE WHEN _field = 'final'   THEN _new_value ELSE final_amount END
    WHERE shift_id = _shift_id AND bank_name = _name;
  ELSE
    UPDATE public.ppob_balances
    SET initial_amount = CASE WHEN _field = 'initial' THEN _new_value ELSE initial_amount END,
        final_amount   = CASE WHEN _field = 'final'   THEN _new_value ELSE final_amount END
    WHERE shift_id = _shift_id AND provider_name = _name;
  END IF;

  -- Saldo Awal  = Kas Awal + Bank Awal + Modal Tambahan (tanpa PPOB)
  -- Saldo Akhir = Kas Tutup + Bank Tutup + Settlement + Pengeluaran (tanpa PPOB)
  UPDATE public.shifts s
  SET modal_awal = COALESCE(s.initial_physical_balance, 0)
        + COALESCE((SELECT SUM(initial_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
        + COALESCE(s.additional_capital, 0),
      modal_akhir = CASE WHEN s.status = 'closed' THEN
          COALESCE(s.final_physical_balance, 0)
          + COALESCE((SELECT SUM(final_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
          + COALESCE(s.settlement_amount, 0)
          + COALESCE(s.total_expenses, 0)
        ELSE s.modal_akhir END
  WHERE s.id = _shift_id;

  -- -----------------------------------------------------------------------
  -- Koreksi 'final': rambatkan ke saldo AWAL shift penerus, satu langkah.
  -- Saldo akhir penerus tidak disentuh, jadi batas berikutnya tetap utuh.
  -- -----------------------------------------------------------------------
  IF _field = 'final' THEN
    _next_id := public.shift_chain_neighbour(_shift_id, true);

    IF _next_id IS NOT NULL THEN
      IF _kind = 'bank' THEN
        SELECT initial_amount INTO _next_old FROM public.bank_balances
         WHERE shift_id = _next_id AND bank_name = _name;
      ELSE
        SELECT initial_amount INTO _next_old FROM public.ppob_balances
         WHERE shift_id = _next_id AND provider_name = _name;
      END IF;

      -- Baris akunnya mungkin tidak ada bila bank/provider itu baru
      -- ditambahkan ke daftar setelah shift penerus dibuka. Tidak diciptakan
      -- di sini: saldo awal yang tidak pernah tercatat bukan nol, ia tidak
      -- diketahui, dan mengarangnya akan menggeser Laba tanpa dasar.
      IF _next_old IS NOT NULL AND _next_old <> _new_value THEN
        IF _kind = 'bank' THEN
          UPDATE public.bank_balances SET initial_amount = _new_value
           WHERE shift_id = _next_id AND bank_name = _name;
        ELSE
          UPDATE public.ppob_balances SET initial_amount = _new_value
           WHERE shift_id = _next_id AND provider_name = _name;
        END IF;

        -- Hanya modal_awal penerus yang dihitung ulang. Saldo akhirnya tidak
        -- berubah, jadi modal_akhir-nya sengaja tidak disentuh.
        UPDATE public.shifts s
        SET modal_awal = COALESCE(s.initial_physical_balance, 0)
              + COALESCE((SELECT SUM(initial_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
              + COALESCE(s.additional_capital, 0)
        WHERE s.id = _next_id;

        _terambat := true;
      END IF;
    END IF;
  END IF;

  PERFORM set_config('brilink.audit_override', 'off', true);

  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id;

  INSERT INTO public.shift_amendments (shift_id, user_id, action, before_data, after_data)
  VALUES (
    _shift_id, auth.uid(), 'audit', _before,
    jsonb_build_object(
      'kind', _kind, 'name', _name, 'field', _field,
      'value', _new_value,
      'modal_awal', _shift.modal_awal,
      'modal_akhir', _shift.modal_akhir,
      'reason', _reason_clean,
      'dirambatkan_ke_shift_berikutnya', _terambat
    )
  );

  -- Rambatan mendapat barisnya sendiri, ditautkan ke shift penerus, supaya
  -- riwayat shift itu menjelaskan mengapa modal awalnya berubah tanpa ada
  -- seorang pun menyentuhnya.
  IF _terambat THEN
    SELECT * INTO _next_shift FROM public.shifts WHERE id = _next_id;
    INSERT INTO public.shift_amendments (shift_id, user_id, action, before_data, after_data)
    VALUES (
      _next_id, auth.uid(), 'audit',
      jsonb_build_object(
        'kind', _kind, 'name', _name, 'field', 'initial',
        'value', _next_old,
        'modal_awal', _next_shift.modal_awal,
        'modal_akhir', _next_shift.modal_akhir,
        'reason', 'Rambatan otomatis: saldo akhir shift sebelumnya dikoreksi owner — ' || _reason_clean
      ),
      jsonb_build_object(
        'kind', _kind, 'name', _name, 'field', 'initial',
        'value', _new_value,
        'modal_awal', _next_shift.modal_awal,
        'modal_akhir', _next_shift.modal_akhir,
        'reason', 'Rambatan otomatis dari audit shift sebelumnya',
        'dirambatkan_dari_shift', _shift_id
      )
    );
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.owner_adjust_balance(UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_adjust_balance(UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO authenticated, service_role;

COMMENT ON FUNCTION public.owner_adjust_balance(UUID, TEXT, TEXT, TEXT, NUMERIC, TEXT) IS
  'Owner saja. Koreksi saldo akhir merambat ke saldo awal shift penerus (satu langkah, tercatat di shift_amendments); koreksi saldo awal ditolak bila memutus batas dengan shift pendahulu. Lihat supabase/AUDIT.md temuan S-3.';
