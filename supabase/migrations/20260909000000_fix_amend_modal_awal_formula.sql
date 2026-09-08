-- Fix amend_open_shift: modal_awal harus kas fisik + bank saja (tanpa PPOB),
-- selaras rumus resmi yang ditegakkan open_shift_atomic, close_shift_atomic,
-- owner_adjust_balance, dan frontend (lib/ledger.ts saldoAwal()).
--
-- Versi lama menjumlahkan _ppob_total ke modal_awal, jadi setiap kali kasir
-- memakai "Perbaiki modal awal", angka modal awal shift membengkak sebesar
-- total saldo PPOB sampai shift ditutup (close_shift_atomic menulis ulang
-- dengan rumus benar). Ditemukan saat audit cabang Hari Hari 1.

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

-- Backfill: shift yang masih terbuka bisa saja membawa modal_awal hasil
-- amend_open_shift lama (kas + bank + PPOB). Hitung ulang dengan rumus benar.
-- Shift closed sudah ditulis ulang oleh close_shift_atomic / owner_adjust_balance
-- (atau backfill 20260907000002), jadi tidak disentuh.
DO $$
BEGIN
  PERFORM set_config('brilink.audit_override', 'on', true);

  UPDATE public.shifts s
  SET modal_awal = COALESCE(s.initial_physical_balance, 0)
        + COALESCE((SELECT SUM(initial_amount) FROM public.bank_balances b WHERE b.shift_id = s.id), 0)
        + COALESCE(s.additional_capital, 0)
  WHERE s.status = 'open'
    AND s.modal_awal IS DISTINCT FROM (
      COALESCE(s.initial_physical_balance, 0)
      + COALESCE((SELECT SUM(initial_amount) FROM public.bank_balances b WHERE b.shift_id = s.id), 0)
      + COALESCE(s.additional_capital, 0)
    );

  PERFORM set_config('brilink.audit_override', 'off', true);
END;
$$;
