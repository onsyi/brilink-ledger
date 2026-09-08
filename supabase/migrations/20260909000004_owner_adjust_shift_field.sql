-- Jalur koreksi angka penutupan shift tertutup oleh owner.
--
-- Latar (kasus shift Nindi, Hari Hari 1, 8 Sep): pengeluaran 2.000.000
-- dihapus lewat akses DB langsung sehingga modal_akhir dan laba meleset 2 jt.
-- Shift yang sudah ditutup tidak bisa di-reject (bukan lagi shift terakhir
-- cabang) dan owner_adjust_balance hanya menyentuh baris bank/PPOB — tidak
-- ada jalur sah untuk mengoreksi angka penutupan. Fungsi ini menutup celah
-- itu: owner, wajib alasan, tercatat di shift_amendments, dan modal_awal /
-- modal_akhir dihitung ulang otomatis.

CREATE OR REPLACE FUNCTION public.owner_adjust_shift_field(
  _shift_id uuid,
  _field text,
  _new_value numeric,
  _reason text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _shift public.shifts%ROWTYPE;
  _old_value NUMERIC;
  _reason_clean TEXT := btrim(COALESCE(_reason, ''));
  _label TEXT;
  _before JSONB;
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN
    RAISE EXCEPTION 'Hanya owner yang dapat mengaudit angka penutupan';
  END IF;

  IF _field NOT IN ('total_expenses', 'settlement_amount', 'owner_withdrawal',
                    'final_physical_balance', 'additional_capital') THEN
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
    WHEN 'owner_withdrawal' THEN _shift.owner_withdrawal
    WHEN 'final_physical_balance' THEN _shift.final_physical_balance
    WHEN 'additional_capital' THEN _shift.additional_capital
  END;

  _label := CASE _field
    WHEN 'total_expenses' THEN 'Pengeluaran'
    WHEN 'settlement_amount' THEN 'Settlement'
    WHEN 'owner_withdrawal' THEN 'Penarikan Owner'
    WHEN 'final_physical_balance' THEN 'Kas Fisik Akhir'
    WHEN 'additional_capital' THEN 'Modal Tambahan'
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
  SET total_expenses        = CASE WHEN _field = 'total_expenses' THEN _new_value ELSE total_expenses END,
      settlement_amount     = CASE WHEN _field = 'settlement_amount' THEN _new_value ELSE settlement_amount END,
      owner_withdrawal      = CASE WHEN _field = 'owner_withdrawal' THEN _new_value ELSE owner_withdrawal END,
      final_physical_balance = CASE WHEN _field = 'final_physical_balance' THEN _new_value ELSE final_physical_balance END,
      additional_capital    = CASE WHEN _field = 'additional_capital' THEN _new_value ELSE additional_capital END
  WHERE id = _shift_id;

  -- Saldo Awal = Kas Awal + Bank Awal + Modal Tambahan (tanpa PPOB)
  -- Saldo Akhir = Kas Fisik Akhir + Bank Akhir + Settlement + Pengeluaran + Penarikan Owner (tanpa PPOB)
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

REVOKE ALL ON FUNCTION public.owner_adjust_shift_field(uuid, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.owner_adjust_shift_field(uuid, text, numeric, text) TO authenticated, service_role;
