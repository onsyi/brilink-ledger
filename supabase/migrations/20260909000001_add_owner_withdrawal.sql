-- Konsep Penarikan Owner (owner_withdrawal).
--
-- Audit cabang Hari Hari 1 menunjukkan uang yang diambil owner dari outlet
-- tidak punya rumah: dipaksakan masuk "Pengeluaran" (Rp30 juta dengan rincian
-- kosong, Rp50 juta dengan rincian "keripik singkong Rp80.000") sehingga laba
-- shift seolah rugi besar, atau sama sekali tidak dicatat sehingga bank drop
-- puluhan juta tanpa jejak.
--
-- Penarikan owner adalah perpindahan aset ke pemilik, bukan biaya:
--   Rumus Saldo Akhir = Kas Fisik Akhir + Bank Akhir + Settlement
--                       + Pengeluaran + Penarikan Owner
-- Laba tetap Akhir - Awal, kini tidak lagi tercemar penarikan.

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS owner_withdrawal NUMERIC(16,2) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- close_shift_atomic: param baru _owner_withdrawal (DEFAULT 0 supaya pemanggil
-- lama yang belum mengirim field ini tetap valid).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.close_shift_atomic(
  _shift_id uuid,
  _final_cash numeric,
  _additional_capital numeric,
  _expenses numeric,
  _expense_notes text,
  _topup numeric,
  _deposit numeric,
  _settlement numeric,
  _bank_snapshots jsonb,
  _ppob_snapshots jsonb,
  _owner_withdrawal numeric DEFAULT 0
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _bank RECORD;
  _ppob RECORD;
  _bank_total_final NUMERIC := 0;
  _bank_total_initial NUMERIC := 0;
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
  IF COALESCE(_owner_withdrawal, 0) < 0 THEN
    RAISE EXCEPTION 'Penarikan owner tidak boleh negatif';
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
  END LOOP;

  -- Total saldo bank awal shift ini
  SELECT COALESCE(SUM(initial_amount), 0) INTO _bank_total_initial
  FROM public.bank_balances WHERE shift_id = _shift_id;

  -- Rumus Saldo Awal = Saldo Rekening Bank Awal + Saldo Awal Kasir + Penambahan Modal
  _modal_awal := COALESCE(_initial_cash, 0) + _bank_total_initial + COALESCE(_additional_capital, 0);

  -- Rumus Saldo Akhir = Kas Fisik Akhir + Bank Akhir + Settlement + Pengeluaran + Penarikan Owner
  _modal_akhir := COALESCE(_final_cash, 0)
    + _bank_total_final
    + COALESCE(_settlement, 0)
    + COALESCE(_expenses, 0)
    + COALESCE(_owner_withdrawal, 0);

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
    owner_withdrawal       = COALESCE(_owner_withdrawal, 0),
    end_time               = NOW(),
    status                 = 'closed'
  WHERE id = _shift_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- owner_adjust_balance: recompute modal_akhir ikut memperhitungkan penarikan.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.owner_adjust_balance(_shift_id uuid, _kind text, _name text, _field text, _new_value numeric, _reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- Saldo Akhir = Kas Fisik Akhir + Bank Akhir + Settlement + Pengeluaran + Penarikan Owner (tanpa PPOB)
  UPDATE public.shifts s
  SET modal_awal = COALESCE(s.initial_physical_balance, 0)
        + COALESCE((SELECT SUM(initial_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
        + COALESCE(s.additional_capital, 0),
      modal_akhir = CASE WHEN s.status = 'closed' THEN
          COALESCE(s.final_physical_balance, 0)
          + COALESCE((SELECT SUM(final_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
          + COALESCE(s.settlement_amount, 0)
          + COALESCE(s.total_expenses, 0)
          + COALESCE(s.owner_withdrawal, 0)
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
$function$;

-- ---------------------------------------------------------------------------
-- owner_reject_shift_report: snapshot menyimpan penarikan; reject mengembalikan
-- nilainya ke 0 (dikoreksi kasir di form Tutup Shift berikutnya).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.owner_reject_shift_report(_shift_id uuid, _reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id FOR UPDATE;
  IF _shift.id IS NULL THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;
  IF _shift.status <> 'closed' THEN
    RAISE EXCEPTION 'Shift ini belum ditutup — belum ada laporan yang bisa ditolak';
  END IF;

  IF public.previous_closed_shift_id(_shift.branch_id, _shift.user_id)
       IS DISTINCT FROM _shift.id THEN
    RAISE EXCEPTION 'Sudah ada shift lain yang ditutup setelah shift ini di cabang yang sama. Saldo penutupannya sudah jadi modal awal shift berikutnya — koreksi lewat tombol Audit, atau tolak shift yang terbaru lebih dulu.';
  END IF;

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
    'owner_withdrawal', _shift.owner_withdrawal,
    'modal_akhir', _shift.modal_akhir,
    'bank', (SELECT COALESCE(jsonb_object_agg(bank_name, final_amount), '{}'::jsonb)
             FROM public.bank_balances WHERE shift_id = _shift_id),
    'ppob', (SELECT COALESCE(jsonb_object_agg(provider_name, final_amount), '{}'::jsonb)
             FROM public.ppob_balances WHERE shift_id = _shift_id)
  );

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
      owner_withdrawal       = 0,
      deposit_confirmed      = false,
      rejected_at            = now(),
      rejection_reason       = _reason_clean,
      rejected_snapshot      = _snapshot
  WHERE id = _shift_id;

  PERFORM set_config('brilink.audit_override', 'off', true);

  UPDATE public.bank_balances SET final_amount = 0 WHERE shift_id = _shift_id;
  UPDATE public.ppob_balances SET final_amount = 0, topup_amount = 0 WHERE shift_id = _shift_id;

  INSERT INTO public.shift_amendments (shift_id, user_id, action, before_data, after_data)
  VALUES (
    _shift_id, auth.uid(), 'reject',
    _snapshot || jsonb_build_object('modal_awal', _shift.modal_awal, 'reason', _reason_clean),
    NULL
  );
END;
$function$;

-- Backfill: shift lama tidak punya penarikan tercatat; nilai default 0 sudah
-- benar — tidak ada yang bisa direkonstruksi secara akun.
