-- Keamanan: tutup shift hanya boleh lewat close_shift_atomic (aplikasi).
--
-- Kasus Eci menunjukkan shift bisa "ditutup" lewat SQL langsung — kasir atau
-- developer mengupdate status='closed' + modal_akhir secara manual tanpa
-- mengisi baris bank_balances/ppob_balances, sehingga saldo akhir di laporan
-- berbeda jauh dari angka sebenarnya. Untuk mencegah terulang:
--   1) close_shift_atomic mengaktifkan brilink.audit_override sebelum UPDATE
--   2) Trigger baru menolak transisi open → closed tanpa override.
--
-- Bug diperbaiki: prevent_closed_shift_account_edit() sebelumnya
-- return OLD pada UPDATE — mengabaikan perubahan secara diam-diam.

-- =========================================================================
-- 1) Fix: prevent_closed_shift_account_edit() — return OLD mengabaikan UPDATE
--    secara diam-diam. Perlu return NEW untuk UPDATE, return OLD untuk DELETE.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.prevent_closed_shift_account_edit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.assert_shift_row_editable(OLD.shift_id);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$function$;

-- =========================================================================
-- 2) Rekonstruksi saldo akhir bank & PPOB shift Eci (Hari Hari 2, 8-9 Sep).
-- =========================================================================
DO $$
DECLARE
  _shift_id uuid := '7c2ca5ee-8aa1-4bfc-bc42-aac6cdd1f5aa';
  _owner    uuid := '2895ff49-1a77-43b3-8af5-6a49bd9bd416';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.shifts WHERE id = _shift_id)
     OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = _owner) THEN
    RETURN;
  END IF;

  PERFORM set_config('brilink.audit_override', 'on', true);

  UPDATE public.bank_balances SET final_amount = v.a
  FROM (VALUES
      ('BNI46',     15968758),
      ('BRI D',     18227860),
      ('BRI Y',      5297500),
      ('SEABANK',    2085816),
      ('SUPERBANK',   739027)
  ) AS v(bank_name, a)
  WHERE shift_id = _shift_id AND bank_balances.bank_name = v.bank_name;

  UPDATE public.ppob_balances SET final_amount = v.a, topup_amount = 0
  FROM (VALUES
      ('Anggichanger',  619828),
      ('I-Simpel',      525250),
      ('Digipost',     1703971),
      ('Saveplus',       13734),
      ('Radar',           5938)
  ) AS v(provider_name, a)
  WHERE shift_id = _shift_id AND ppob_balances.provider_name = v.provider_name;

  UPDATE public.shifts s
  SET modal_awal = COALESCE(s.initial_physical_balance, 0)
        + COALESCE((SELECT SUM(initial_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
        + COALESCE(s.additional_capital, 0),
      modal_akhir = COALESCE(s.final_physical_balance, 0)
        + COALESCE((SELECT SUM(final_amount) FROM public.bank_balances WHERE shift_id = s.id), 0)
        + COALESCE(s.settlement_amount, 0)
        + COALESCE(s.total_expenses, 0)
        + COALESCE(s.owner_withdrawal, 0)
  WHERE s.id = _shift_id;

  PERFORM set_config('brilink.audit_override', 'off', true);

  INSERT INTO public.shift_amendments (shift_id, user_id, action, before_data, after_data)
  VALUES
    (_shift_id, _owner, 'audit',
     jsonb_build_object('kind','shift','name','Saldo akhir bank (rekonstruksi)','field','final','value',0,
                        'reason','Pemulihan: penutupan ulang di luar aplikasi mengosongkan baris saldo akhir bank. Angka dipulihkan dari snapshot penolakan (total 42.318.961 sesuai laporan kasir).'),
     jsonb_build_object('kind','shift','name','Saldo akhir bank (rekonstruksi)','field','final','value',42318961,
                        'reason','Pemulihan: penutupan ulang di luar aplikasi mengosongkan baris saldo akhir bank. Angka dipulihkan dari snapshot penolakan (total 42.318.961 sesuai laporan kasir).')),
    (_shift_id, _owner, 'audit',
     jsonb_build_object('kind','shift','name','Saldo akhir PPOB (rekonstruksi)','field','final','value',0,
                        'reason','Pemulihan: angka sesuai catatan owner (total 2.868.721, PPOB terpakai 501.852).'),
     jsonb_build_object('kind','shift','name','Saldo akhir PPOB (rekonstruksi)','field','final','value',2868721,
                        'reason','Pemulihan: angka sesuai catatan owner (total 2.868.721, PPOB terpakai 501.852).'));
END $$;

-- =========================================================================
-- 3) close_shift_atomic — tambahkan audit_override di sekitar UPDATE
-- =========================================================================
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

  SELECT COALESCE(SUM(initial_amount), 0) INTO _bank_total_initial
  FROM public.bank_balances WHERE shift_id = _shift_id;

  _modal_awal := COALESCE(_initial_cash, 0) + _bank_total_initial + COALESCE(_additional_capital, 0);
  _modal_akhir := COALESCE(_final_cash, 0)
    + _bank_total_final
    + COALESCE(_settlement, 0)
    + COALESCE(_expenses, 0)
    + COALESCE(_owner_withdrawal, 0);

  PERFORM set_config('brilink.audit_override', 'on', true);

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

  PERFORM set_config('brilink.audit_override', 'off', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.close_shift_atomic(
  uuid, numeric, numeric, numeric, text, numeric, numeric, numeric, jsonb, jsonb, numeric
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_shift_atomic(
  uuid, numeric, numeric, numeric, text, numeric, numeric, numeric, jsonb, jsonb, numeric
) TO authenticated, service_role;

-- =========================================================================
-- 4) Trigger — tolak open → closed tanpa override
-- =========================================================================
CREATE OR REPLACE FUNCTION public.prevent_direct_shift_close()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'closed'
     AND OLD.status IS DISTINCT FROM 'closed'
     AND COALESCE(current_setting('brilink.audit_override', true), '') <> 'on'
  THEN
    RAISE EXCEPTION 'Penutupan shift hanya lewat Tutup Shift di aplikasi';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS prevent_direct_shift_close ON public.shifts;
CREATE TRIGGER prevent_direct_shift_close
BEFORE UPDATE ON public.shifts
FOR EACH ROW EXECUTE FUNCTION public.prevent_direct_shift_close();
