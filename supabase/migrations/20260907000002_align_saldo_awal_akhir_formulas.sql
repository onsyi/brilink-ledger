-- Align Saldo Awal and Saldo Akhir formulas with official business rules:
--
-- 1. Rumus Saldo Awal:
--    Saldo semua rekening shift sebelumnya (Bank) + Saldo Awal Buka Kasir (Kas Fisik) + Penambahan Modal
--    * PPOB tidak digabung karena berdiri sendiri.
--
-- 2. Rumus Saldo Akhir:
--    Saldo uang Fisik tutup kasir + Saldo rekening Bank tutup kasir + settlement + Pengeluaran
--    * PPOB tidak digabung karena berdiri sendiri.
--
-- 3. Rumus Laba:
--    Saldo Akhir - Saldo Awal
--
-- 4. Rumus FBI:
--    Laba - Pemakaian PPOB
--
-- 5. Rumus FS:
--    Kasir yang ada Laporan Setoran x 15%

-- ---------------------------------------------------------------------------
-- 1) open_shift_atomic: modal_awal = kas fisik + total bank (tanpa PPOB)
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

-- ---------------------------------------------------------------------------
-- 2) close_shift_atomic:
--    modal_akhir = kas fisik + bank akhir + settlement + pengeluaran (tanpa PPOB)
--    modal_awal  = kas fisik awal + bank awal + penambahan modal
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_shift_atomic(
  _shift_id UUID,
  _final_cash NUMERIC,
  _additional_capital NUMERIC,
  _expenses NUMERIC,
  _expense_notes TEXT,
  _topup NUMERIC,
  _deposit NUMERIC,
  _settlement NUMERIC,
  _bank_snapshots JSONB,
  _ppob_snapshots JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _bank RECORD;
  _ppob RECORD;
  _bank_total_final NUMERIC := 0;
  _bank_total_initial NUMERIC := 0;
  _ppob_total NUMERIC := 0;
  _modal_awal NUMERIC;
  _modal_akhir NUMERIC;
  _shift_status public.shift_status;
  _initial_cash NUMERIC;
BEGIN
  IF NOT (public.shift_is_writable(_shift_id)) THEN
    RAISE EXCEPTION 'Shift tidak dapat ditulis — hanya shift terbuka milik sendiri yang bisa ditutup';
  END IF;

  SELECT status, initial_physical_balance INTO _shift_status, _initial_cash
  FROM public.shifts WHERE id = _shift_id;

  IF _shift_status IS NULL THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;
  IF _shift_status <> 'open' THEN
    RAISE EXCEPTION 'Shift sudah ditutup sebelumnya';
  END IF;

  IF COALESCE(_final_cash, 0) < 0 THEN
    RAISE EXCEPTION 'Saldo fisik akhir tidak boleh negatif';
  END IF;
  IF COALESCE(_additional_capital, 0) < 0 THEN
    RAISE EXCEPTION 'Modal tambahan tidak boleh negatif';
  END IF;
  IF COALESCE(_expenses, 0) < 0 THEN
    RAISE EXCEPTION 'Pengeluaran tidak boleh negatif';
  END IF;
  IF COALESCE(_topup, 0) < 0 THEN
    RAISE EXCEPTION 'Penambahan saldo PPOB tidak boleh negatif';
  END IF;
  IF COALESCE(_deposit, 0) < 0 THEN
    RAISE EXCEPTION 'Setoran tidak boleh negatif';
  END IF;
  IF COALESCE(_settlement, 0) < 0 THEN
    RAISE EXCEPTION 'Settlement tidak boleh negatif';
  END IF;

  FOR _bank IN SELECT * FROM jsonb_to_recordset(_bank_snapshots) AS x(bank_name TEXT, final_amount NUMERIC)
  LOOP
    IF COALESCE(_bank.final_amount, 0) < 0 THEN
      RAISE EXCEPTION 'Saldo akhir % tidak boleh negatif', _bank.bank_name;
    END IF;
    INSERT INTO public.bank_balances (shift_id, bank_name, final_amount)
    VALUES (_shift_id, _bank.bank_name, COALESCE(_bank.final_amount, 0))
    ON CONFLICT (shift_id, bank_name)
    DO UPDATE SET final_amount = EXCLUDED.final_amount;
    _bank_total_final := _bank_total_final + COALESCE(_bank.final_amount, 0);
  END LOOP;

  FOR _ppob IN SELECT * FROM jsonb_to_recordset(_ppob_snapshots) AS x(provider_name TEXT, final_amount NUMERIC, topup_amount NUMERIC)
  LOOP
    IF COALESCE(_ppob.final_amount, 0) < 0 OR COALESCE(_ppob.topup_amount, 0) < 0 THEN
      RAISE EXCEPTION 'Saldo akhir % tidak boleh negatif', _ppob.provider_name;
    END IF;
    INSERT INTO public.ppob_balances (shift_id, provider_name, final_amount, topup_amount)
    VALUES (_shift_id, _ppob.provider_name, COALESCE(_ppob.final_amount, 0), COALESCE(_ppob.topup_amount, 0))
    ON CONFLICT (shift_id, provider_name)
    DO UPDATE SET final_amount = EXCLUDED.final_amount, topup_amount = EXCLUDED.topup_amount;
    _ppob_total := _ppob_total + COALESCE(_ppob.final_amount, 0);
  END LOOP;

  -- Total saldo bank awal shift ini
  SELECT COALESCE(SUM(initial_amount), 0) INTO _bank_total_initial
  FROM public.bank_balances WHERE shift_id = _shift_id;

  -- Rumus Saldo Awal = Saldo Rekening Bank Awal + Saldo Awal Kasir + Penambahan Modal
  _modal_awal := COALESCE(_initial_cash, 0) + _bank_total_initial + COALESCE(_additional_capital, 0);

  -- Rumus Saldo Akhir = Saldo uang Fisik tutup kasir + Saldo rekening Bank tutup kasir + settlement + Pengeluaran
  _modal_akhir := COALESCE(_final_cash, 0) + _bank_total_final + COALESCE(_settlement, 0) + COALESCE(_expenses, 0);

  UPDATE public.shifts
  SET
    final_physical_balance = _final_cash,
    additional_capital     = COALESCE(_additional_capital, 0),
    modal_awal             = _modal_awal,
    modal_akhir            = _modal_akhir,
    total_expenses         = _expenses,
    expense_notes          = _expense_notes,
    topup_request          = _topup,
    deposit_amount         = _deposit,
    settlement_amount      = COALESCE(_settlement, 0),
    end_time               = NOW(),
    status                 = 'closed'
  WHERE id = _shift_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3) owner_adjust_balance: update modal_awal dan modal_akhir sesuai rumus baru
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.owner_adjust_balance(
  _shift_id UUID,
  _kind TEXT,        -- 'bank' | 'ppob'
  _name TEXT,        -- bank_name / provider_name
  _field TEXT,       -- 'initial' | 'final'
  _new_value NUMERIC,
  _reason TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _shift public.shifts%ROWTYPE;
  _old_value NUMERIC;
  _reason_clean TEXT := btrim(COALESCE(_reason, ''));
  _before JSONB;
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

  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id;
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

  _before := jsonb_build_object(
    'kind', _kind, 'name', _name, 'field', _field,
    'value', _old_value,
    'modal_awal', _shift.modal_awal,
    'modal_akhir', _shift.modal_akhir,
    'reason', _reason_clean
  );

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

  PERFORM set_config('brilink.audit_override', 'on', true);

  -- Saldo Awal = Kas Awal + Bank Awal + Modal Tambahan (tanpa PPOB)
  -- Saldo Akhir = Kas Fisik Akhir + Bank Akhir + Settlement + Pengeluaran (tanpa PPOB)
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
      'reason', _reason_clean
    )
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4) Backfill historical shift records to match the new formula
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM set_config('brilink.audit_override', 'on', true);

  UPDATE public.shifts s
  SET
    modal_awal = COALESCE(s.initial_physical_balance, 0)
                 + COALESCE(b_init.bank_initial_total, 0)
                 + COALESCE(s.additional_capital, 0),
    modal_akhir = CASE
      WHEN s.status = 'closed' OR s.modal_akhir IS NOT NULL THEN
        COALESCE(s.final_physical_balance, 0)
        + COALESCE(b_fin.bank_final_total, 0)
        + COALESCE(s.settlement_amount, 0)
        + COALESCE(s.total_expenses, 0)
      ELSE s.modal_akhir
    END
  FROM (
    SELECT shift_id, SUM(COALESCE(initial_amount, 0)) as bank_initial_total
    FROM public.bank_balances
    GROUP BY shift_id
  ) b_init,
  (
    SELECT shift_id, SUM(COALESCE(final_amount, 0)) as bank_final_total
    FROM public.bank_balances
    GROUP BY shift_id
  ) b_fin
  WHERE s.id = b_init.shift_id AND s.id = b_fin.shift_id;

  PERFORM set_config('brilink.audit_override', 'off', true);
END;
$$;
