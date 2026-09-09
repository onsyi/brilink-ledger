-- Migration 00008: Fix audit_override ordering in owner_adjust_balance
--
-- BUG: owner_adjust_balance() set brilink.audit_override AFTER updating
-- bank_balances/ppob_balances. The BEFORE UPDATE trigger
-- prevent_closed_shift_account_edit() checked the override and blocked
-- the update because it wasn't set yet.
--
-- FIX: Move set_config('brilink.audit_override','on',true) BEFORE the
-- bank_balances/ppob_balances UPDATE statements.

BEGIN;

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
  _shift      public.shifts%ROWTYPE;
  _old_value  NUMERIC;
  _reason_clean TEXT := btrim(COALESCE(_reason, ''));
  _before     JSONB;
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

  -- Set override BEFORE updating bank/ppob_balances so the BEFORE UPDATE
  -- trigger prevent_closed_shift_account_edit() allows the change.
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

  -- Saldo Awal  = Kas Awal + Bank Awal + Modal Tambahan (no PPOB)
  -- Saldo Akhir = Kas Tutup + Bank Tutup + Settlement + Pengeluaran (no owner_withdrawal)
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
$function$;

COMMIT;
