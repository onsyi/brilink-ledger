-- Fix three bugs discovered during deep audit:
--
-- Bug 1 (CRITICAL): owner_reject_shift_report() does not recalculate modal_awal
-- after resetting additional_capital to 0. When close_shift_atomic closes a shift
-- with e.g. 2M additional_capital, modal_awal = kas + bank + 2M. Owner rejects →
-- additional_capital = 0 but modal_awal still shows kas + bank + 2M. Shift
-- re-opens with inflated Saldo Awal, causing false losses when re-closed.
--
-- Bug 2 (HIGH): amend_open_shift() calculates _bank_total by summing the JSON
-- payload instead of querying the database. If the payload omits a bank that
-- already exists in bank_balances, the old row stays but its initial_amount is
-- excluded from modal_awal → modal_awal < SUM(bank_balances.initial_amount).
--
-- Bug 3 (HIGH): owner_adjust_shift_field() does not allow correcting
-- deposit_amount. Deposit drives FS (Fee Sharing = deposit × 15%), so
-- typos in deposit require rejecting the entire shift instead of a
-- quick audit correction.

BEGIN;

-- ---------------------------------------------------------------------------
-- Fix 1: owner_reject_shift_report — recalculate modal_awal after clearing
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
      rejected_snapshot      = _snapshot,
      -- FIX Bug 1: Recalculate modal_awal after clearing additional_capital.
      -- additional_capital is now 0, so modal_awal = kas awal + bank awal only.
      modal_awal             = COALESCE(initial_physical_balance, 0)
                               + COALESCE((SELECT SUM(initial_amount)
                                           FROM public.bank_balances
                                           WHERE shift_id = _shift_id), 0)
  WHERE id = _shift_id;

  UPDATE public.bank_balances SET final_amount = 0 WHERE shift_id = _shift_id;
  UPDATE public.ppob_balances SET final_amount = 0, topup_amount = 0 WHERE shift_id = _shift_id;

  PERFORM set_config('brilink.audit_override', 'off', true);

  INSERT INTO public.shift_amendments (shift_id, user_id, action, before_data, after_data)
  VALUES (
    _shift_id, auth.uid(), 'reject',
    _snapshot || jsonb_build_object('modal_awal', _shift.modal_awal, 'reason', _reason_clean),
    NULL
  );
END;
$function$;


-- ---------------------------------------------------------------------------
-- Fix 2: amend_open_shift — calculate bank total from DB after upsert
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.amend_open_shift(_shift_id uuid, _initial_cash numeric, _bank_snapshots jsonb, _ppob_snapshots jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _bank RECORD;
  _ppob RECORD;
  _bank_total NUMERIC := 0;
  _shift public.shifts%ROWTYPE;
  _before JSONB;
  _modal_awal NUMERIC;
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
  END LOOP;

  -- PPOB tetap disimpan ke ppob_balances, tapi TIDAK dijumlahkan ke modal_awal:
  -- PPOB berdiri sendiri dan tidak masuk rumus Saldo Awal.
  FOR _ppob IN SELECT * FROM jsonb_to_recordset(_ppob_snapshots) AS x(provider_name TEXT, initial_amount NUMERIC)
  LOOP
    IF COALESCE(_ppob.initial_amount, 0) < 0 THEN
      RAISE EXCEPTION 'Saldo awal % tidak boleh negatif', _ppob.provider_name;
    END IF;
    INSERT INTO public.ppob_balances (shift_id, provider_name, initial_amount)
    VALUES (_shift_id, _ppob.provider_name, COALESCE(_ppob.initial_amount, 0))
    ON CONFLICT (shift_id, provider_name) DO UPDATE SET initial_amount = EXCLUDED.initial_amount;
  END LOOP;

  -- FIX Bug 2: Query the actual bank_balances table AFTER upsert instead of
  -- summing the JSON payload. This ensures modal_awal matches the true total
  -- even if the payload omitted banks that already exist in bank_balances.
  SELECT COALESCE(SUM(initial_amount), 0) INTO _bank_total
  FROM public.bank_balances WHERE shift_id = _shift_id;

  -- Rumus Saldo Awal = Kas Fisik Awal + Saldo Rekening Bank (tanpa PPOB)
  _modal_awal := COALESCE(_initial_cash, 0) + _bank_total;

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
$function$;


-- ---------------------------------------------------------------------------
-- Fix 3: owner_adjust_shift_field — add deposit_amount to whitelist
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.owner_adjust_shift_field(
  _shift_id  UUID,
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
  _shift       public.shifts%ROWTYPE;
  _old_value   NUMERIC;
  _reason_clean TEXT := btrim(COALESCE(_reason, ''));
  _label       TEXT;
  _before      JSONB;
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat mengaudit angka penutupan';
  END IF;

  IF _field NOT IN ('total_expenses', 'settlement_amount',
                    'final_physical_balance', 'additional_capital',
                    'deposit_amount') THEN
    RAISE EXCEPTION 'Kolom tidak dikenal: %', COALESCE(_field, 'NULL');
  END IF;

  IF _new_value IS NULL OR _new_value < 0 THEN
    RAISE EXCEPTION 'Nilai baru tidak boleh negatif';
  END IF;
  IF length(_reason_clean) < 3 THEN
    RAISE EXCEPTION 'Alasan koreksi wajib diisi (minimal 3 karakter)';
  END IF;

  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id;
  IF _shift.id IS NULL THEN
    RAISE EXCEPTION 'Shift tidak ditemukan';
  END IF;
  IF _shift.status <> 'closed' THEN
    RAISE EXCEPTION 'Shift masih terbuka — kasir dapat mengoreksinya sendiri lewat Tutup Shift / Perbaiki modal awal';
  END IF;

  _old_value := CASE _field
    WHEN 'total_expenses' THEN _shift.total_expenses
    WHEN 'settlement_amount' THEN _shift.settlement_amount
    WHEN 'final_physical_balance' THEN _shift.final_physical_balance
    WHEN 'additional_capital' THEN _shift.additional_capital
    WHEN 'deposit_amount' THEN _shift.deposit_amount
  END;

  _label := CASE _field
    WHEN 'total_expenses' THEN 'Pengeluaran'
    WHEN 'settlement_amount' THEN 'Settlement'
    WHEN 'final_physical_balance' THEN 'Kas Fisik Akhir'
    WHEN 'additional_capital' THEN 'Modal Tambahan'
    WHEN 'deposit_amount' THEN 'Setoran'
  END;

  IF _old_value IS NOT DISTINCT FROM _new_value THEN
    RETURN;
  END IF;

  _before := jsonb_build_object(
    'kind', 'shift', 'name', _label, 'field', _field,
    'value', _old_value,
    'modal_awal', _shift.modal_awal,
    'modal_akhir', _shift.modal_akhir,
    'reason', _reason_clean
  );

  PERFORM set_config('brilink.audit_override', 'on', true);

  UPDATE public.shifts
  SET total_expenses         = CASE WHEN _field = 'total_expenses' THEN _new_value ELSE total_expenses END,
      settlement_amount      = CASE WHEN _field = 'settlement_amount' THEN _new_value ELSE settlement_amount END,
      final_physical_balance = CASE WHEN _field = 'final_physical_balance' THEN _new_value ELSE final_physical_balance END,
      additional_capital     = CASE WHEN _field = 'additional_capital' THEN _new_value ELSE additional_capital END,
      deposit_amount         = CASE WHEN _field = 'deposit_amount' THEN _new_value ELSE deposit_amount END
  WHERE id = _shift_id;

  -- Saldo Awal  = Kas Awal + Bank Awal + Modal Tambahan (no PPOB)
  -- Saldo Akhir = Kas Tutup + Bank Tutup + Settlement + Pengeluaran (no PPOB)
  -- deposit_amount does not affect modal_awal or modal_akhir, but the other
  -- fields do, so we still recalculate both for consistency.
  UPDATE public.shifts s
  SET modal_awal = COALESCE(s.initial_physical_balance, 0)
        + COALESCE((SELECT SUM(initial_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
        + COALESCE(s.additional_capital, 0),
      modal_akhir = COALESCE(s.final_physical_balance, 0)
        + COALESCE((SELECT SUM(final_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
        + COALESCE(s.settlement_amount, 0)
        + COALESCE(s.total_expenses, 0)
  WHERE s.id = _shift_id;

  PERFORM set_config('brilink.audit_override', 'off', true);

  SELECT * INTO _shift FROM public.shifts WHERE id = _shift_id;

  INSERT INTO public.shift_amendments (shift_id, user_id, action, before_data, after_data)
  VALUES (
    _shift_id, auth.uid(), 'audit', _before,
    jsonb_build_object(
      'kind', 'shift', 'name', _label, 'field', _field,
      'value', _new_value,
      'modal_awal', _shift.modal_awal,
      'modal_akhir', _shift.modal_akhir,
      'reason', _reason_clean
    )
  );
END;
$function$;

COMMIT;
