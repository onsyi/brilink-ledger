-- Kunci kontinuitas saldo bank & PPOB antar shift di satu cabang.
--
-- 20260821000000 membuat form buka shift terisi otomatis dari saldo akhir shift
-- terakhir di cabang yang sama. Tapi prefill itu cuma anjuran: kolomnya masih
-- bisa diketik ulang, dan database menerima angka apa pun. Selisih sekecil apa
-- pun antara modal akhir shift N dan modal awal shift N+1 langsung menggeser
-- Laba Fee, karena rumusnya memakai selisih saldo awal-akhir -- dan tidak ada
-- satu pun baris yang menandai bahwa pergeseran itu terjadi.
--
-- Jadi aturannya dipindah ke tempat yang tidak bisa dilewati klien: setiap akun
-- yang punya saldo akhir di shift sebelumnya HARUS dibuka dengan angka yang
-- sama persis. Akun yang belum pernah tercatat di shift sebelumnya -- shift
-- pertama sebuah cabang, atau bank/provider yang baru ditambahkan ke daftar --
-- tetap bebas diisi, kalau tidak cabang baru tidak akan pernah bisa mulai.
--
-- Kas fisik sengaja TIDAK dikunci. Uang laci berpindah lewat setoran ke owner
-- dan tambahan modal yang tidak selalu tercatat pada saat buka, jadi mengunci
-- initial_physical_balance akan memblokir kasir membuka shift karena hal-hal
-- yang memang normal. Kas dihitung ulang di laci; saldo rekening tidak.
--
-- Mismatch ditolak, bukan ditimpa diam-diam: kasir perlu tahu angka mana yang
-- meleset. Kalau yang keliru justru angka penutupan shift sebelumnya, owner
-- membetulkannya lewat owner_adjust_balance (20260816000000) lalu kasir ulangi.
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Rupiah untuk pesan error. Internal saja -- tidak di-grant ke authenticated
--    supaya tidak ikut muncul sebagai endpoint RPC.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.format_rupiah(_v NUMERIC)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  -- to_char memakai pola en-US ("1,500,000.00"); tukar pemisahnya lewat
  -- penanda sementara '#' supaya jadi "1.500.000,00".
  SELECT 'Rp ' || replace(
                    replace(
                      replace(to_char(COALESCE(_v, 0), 'FM999,999,999,999,990.00'), '.', '#'),
                    ',', '.'),
                  '#', ',')
$$;

REVOKE ALL ON FUNCTION public.format_rupiah(NUMERIC) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) Shift tertutup terakhir di satu cabang.
--
--    Dipakai bersama oleh yang mengisi form (last_closed_shift_balances) dan
--    yang memvalidasinya (assert_opening_continuity). Kalau keduanya memilih
--    "shift sebelumnya" dengan cara berbeda, kasir akan disodori angka yang
--    kemudian ditolak sendiri oleh database -- jadi logikanya cuma boleh ada
--    di satu tempat.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.previous_closed_shift_id(_branch_id UUID, _user_id UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _id UUID;
BEGIN
  IF _branch_id IS NOT NULL THEN
    SELECT id INTO _id
    FROM public.shifts
    WHERE branch_id = _branch_id
      AND status = 'closed'
    ORDER BY end_time DESC NULLS LAST, start_time DESC
    LIMIT 1;
  END IF;

  -- Shift dari sebelum fitur cabang ada tidak punya branch_id. Hanya shift
  -- milik pemanggil sendiri yang boleh jadi cadangan -- outlet lain tetap
  -- tidak terlihat.
  IF _id IS NULL AND _user_id IS NOT NULL THEN
    SELECT id INTO _id
    FROM public.shifts
    WHERE user_id = _user_id
      AND branch_id IS NULL
      AND status = 'closed'
    ORDER BY end_time DESC NULLS LAST, start_time DESC
    LIMIT 1;
  END IF;

  RETURN _id;
END;
$$;

REVOKE ALL ON FUNCTION public.previous_closed_shift_id(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3) Penegakan kontinuitas
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_opening_continuity(
  _prev_shift_id UUID,
  _bank_snapshots JSONB,
  _ppob_snapshots JSONB
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _mismatch TEXT;
BEGIN
  IF _prev_shift_id IS NULL THEN
    RETURN;
  END IF;

  -- Iterasi dari baris shift sebelumnya, bukan dari snapshot yang dikirim:
  -- akun yang dihilangkan dari payload pun ikut terperiksa, jadi saldo tidak
  -- bisa dilenyapkan cuma dengan tidak menyebutkannya.
  SELECT string_agg(txt, '; ' ORDER BY txt) INTO _mismatch
  FROM (
    SELECT b.bank_name
             || ' harus ' || public.format_rupiah(b.final_amount)
             || ' (dikirim ' || public.format_rupiah(COALESCE(s.initial_amount, 0)) || ')' AS txt
    FROM public.bank_balances b
    LEFT JOIN jsonb_to_recordset(COALESCE(_bank_snapshots, '[]'::jsonb))
                AS s(bank_name TEXT, initial_amount NUMERIC)
           ON s.bank_name = b.bank_name
    WHERE b.shift_id = _prev_shift_id
      AND COALESCE(s.initial_amount, 0) <> b.final_amount

    UNION ALL

    SELECT p.provider_name
             || ' harus ' || public.format_rupiah(p.final_amount)
             || ' (dikirim ' || public.format_rupiah(COALESCE(s.initial_amount, 0)) || ')' AS txt
    FROM public.ppob_balances p
    LEFT JOIN jsonb_to_recordset(COALESCE(_ppob_snapshots, '[]'::jsonb))
                AS s(provider_name TEXT, initial_amount NUMERIC)
           ON s.provider_name = p.provider_name
    WHERE p.shift_id = _prev_shift_id
      AND COALESCE(s.initial_amount, 0) <> p.final_amount
  ) x;

  IF _mismatch IS NOT NULL THEN
    RAISE EXCEPTION
      'Saldo awal harus sama dengan saldo akhir shift sebelumnya di cabang ini — %. Perbaiki angkanya, atau minta owner mengaudit shift sebelumnya bila angka penutupannya yang keliru.',
      _mismatch;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_opening_continuity(UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4) Prefill kini memakai pemilih shift yang sama dengan validatornya
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.last_closed_shift_balances()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _branch UUID;
  _shift  public.shifts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT branch_id INTO _branch FROM public.profiles WHERE id = auth.uid();

  SELECT * INTO _shift
  FROM public.shifts
  WHERE id = public.previous_closed_shift_id(_branch, auth.uid());

  IF _shift.id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'shift', jsonb_build_object(
      'id', _shift.id,
      'end_time', _shift.end_time,
      'final_physical_balance', _shift.final_physical_balance,
      'closed_by', (SELECT username FROM public.profiles WHERE id = _shift.user_id),
      'is_own', _shift.user_id = auth.uid()
    ),
    'banks', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('bank_name', bank_name, 'final_amount', final_amount)
               ORDER BY bank_name
             )
      FROM public.bank_balances WHERE shift_id = _shift.id
    ), '[]'::jsonb),
    'ppob', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('provider_name', provider_name, 'final_amount', final_amount)
               ORDER BY provider_name
             )
      FROM public.ppob_balances WHERE shift_id = _shift.id
    ), '[]'::jsonb)
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5) Buka shift — sama seperti 20260815000003, ditambah cek kontinuitas
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
BEGIN
  IF _user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Hanya dapat membuka shift untuk akun sendiri';
  END IF;

  IF EXISTS (SELECT 1 FROM public.shifts WHERE user_id = _user_id AND status = 'open') THEN
    RAISE EXCEPTION 'Masih ada shift aktif di akun ini. Tutup dulu shift tersebut.';
  END IF;

  -- Authoritative source: the cashier's own profile, not the request body.
  SELECT branch_id, is_active INTO _resolved_branch, _is_active
  FROM public.profiles WHERE id = _user_id;

  IF NOT COALESCE(_is_active, true) THEN
    RAISE EXCEPTION 'Akun Anda dinonaktifkan. Hubungi owner.';
  END IF;
  IF _resolved_branch IS NULL THEN
    RAISE EXCEPTION 'Akun belum terdaftar di cabang manapun. Hubungi owner.';
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

  _modal_awal := COALESCE(_initial_cash, 0) + _bank_total + _ppob_total;

  INSERT INTO public.shifts (user_id, branch_id, initial_physical_balance, additional_capital, modal_awal, status)
  VALUES (_user_id, _resolved_branch, COALESCE(_initial_cash, 0), 0, _modal_awal, 'open')
  RETURNING id INTO _shift_id;

  FOR _bank IN SELECT * FROM jsonb_to_recordset(_bank_snapshots) AS x(bank_name TEXT, initial_amount NUMERIC)
  LOOP
    INSERT INTO public.bank_balances (shift_id, bank_name, initial_amount)
    VALUES (_shift_id, _bank.bank_name, COALESCE(_bank.initial_amount, 0));
  END LOOP;

  FOR _ppob IN SELECT * FROM jsonb_to_recordset(_ppob_snapshots) AS x(provider_name TEXT, initial_amount NUMERIC)
  LOOP
    INSERT INTO public.ppob_balances (shift_id, provider_name, initial_amount)
    VALUES (_shift_id, _ppob.provider_name, COALESCE(_ppob.initial_amount, 0));
  END LOOP;

  RETURN _shift_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6) Koreksi shift terbuka — sama seperti 20260815000008, ditambah cek yang sama
--
--    Tanpa ini penguncian bocor lewat pintu belakang: kasir membuka shift
--    dengan angka yang benar, lalu langsung meng-amend-nya ke angka lain.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.amend_open_shift(
  _shift_id UUID,
  _initial_cash NUMERIC,
  _bank_snapshots JSONB,
  _ppob_snapshots JSONB
)
RETURNS void
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
  _shift public.shifts%ROWTYPE;
  _before JSONB;
BEGIN
  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id;
  IF _shift.id IS NULL THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;
  IF _shift.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Hanya dapat mengubah shift milik sendiri';
  END IF;
  IF _shift.status <> 'open' THEN
    RAISE EXCEPTION 'Shift sudah ditutup — tidak dapat diubah lagi';
  END IF;
  IF COALESCE(_initial_cash, 0) < 0 THEN
    RAISE EXCEPTION 'Saldo Tunai Awal Buka Kasir tidak boleh negatif';
  END IF;

  -- Shift yang sedang dikoreksi statusnya 'open', jadi tidak mungkin terpilih
  -- sebagai pembandingnya sendiri.
  PERFORM public.assert_opening_continuity(
    public.previous_closed_shift_id(_shift.branch_id, _shift.user_id),
    _bank_snapshots,
    _ppob_snapshots
  );

  _before := jsonb_build_object(
    'initial_physical_balance', _shift.initial_physical_balance,
    'modal_awal', _shift.modal_awal,
    'bank', (SELECT COALESCE(jsonb_object_agg(bank_name, initial_amount), '{}'::jsonb)
             FROM public.bank_balances WHERE shift_id = _shift_id),
    'ppob', (SELECT COALESCE(jsonb_object_agg(provider_name, initial_amount), '{}'::jsonb)
             FROM public.ppob_balances WHERE shift_id = _shift_id)
  );

  FOR _bank IN SELECT * FROM jsonb_to_recordset(_bank_snapshots) AS x(bank_name TEXT, initial_amount NUMERIC)
  LOOP
    IF COALESCE(_bank.initial_amount, 0) < 0 THEN
      RAISE EXCEPTION 'Saldo awal % tidak boleh negatif', _bank.bank_name;
    END IF;
    INSERT INTO public.bank_balances (shift_id, bank_name, initial_amount)
    VALUES (_shift_id, _bank.bank_name, COALESCE(_bank.initial_amount, 0))
    ON CONFLICT (shift_id, bank_name) DO UPDATE SET initial_amount = EXCLUDED.initial_amount;
    _bank_total := _bank_total + COALESCE(_bank.initial_amount, 0);
  END LOOP;

  FOR _ppob IN SELECT * FROM jsonb_to_recordset(_ppob_snapshots) AS x(provider_name TEXT, initial_amount NUMERIC)
  LOOP
    IF COALESCE(_ppob.initial_amount, 0) < 0 THEN
      RAISE EXCEPTION 'Saldo awal % tidak boleh negatif', _ppob.provider_name;
    END IF;
    INSERT INTO public.ppob_balances (shift_id, provider_name, initial_amount)
    VALUES (_shift_id, _ppob.provider_name, COALESCE(_ppob.initial_amount, 0))
    ON CONFLICT (shift_id, provider_name) DO UPDATE SET initial_amount = EXCLUDED.initial_amount;
    _ppob_total := _ppob_total + COALESCE(_ppob.initial_amount, 0);
  END LOOP;

  _modal_awal := COALESCE(_initial_cash, 0) + _bank_total + _ppob_total;

  UPDATE public.shifts
  SET initial_physical_balance = COALESCE(_initial_cash, 0),
      modal_awal = _modal_awal
  WHERE id = _shift_id;

  INSERT INTO public.shift_amendments (shift_id, user_id, action, before_data, after_data)
  VALUES (
    _shift_id, auth.uid(), 'amend', _before,
    jsonb_build_object(
      'initial_physical_balance', COALESCE(_initial_cash, 0),
      'modal_awal', _modal_awal,
      'bank', (SELECT COALESCE(jsonb_object_agg(bank_name, initial_amount), '{}'::jsonb)
               FROM public.bank_balances WHERE shift_id = _shift_id),
      'ppob', (SELECT COALESCE(jsonb_object_agg(provider_name, initial_amount), '{}'::jsonb)
               FROM public.ppob_balances WHERE shift_id = _shift_id)
    )
  );
END;
$$;

-- Grants tidak berubah, tapi CREATE OR REPLACE tidak mengubahnya juga --
-- ditegaskan ulang supaya file ini tetap benar bila dijalankan di database
-- yang fungsinya belum pernah ada.
REVOKE ALL ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_shift_atomic(UUID, UUID, NUMERIC, JSONB, JSONB) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.amend_open_shift(UUID, NUMERIC, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.amend_open_shift(UUID, NUMERIC, JSONB, JSONB) TO authenticated, service_role;
