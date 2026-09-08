-- Hardening proteksi shift tertutup (ditemukan saat audit cabang Hari Hari 1):
--
-- 1. Trigger immutability shifts diperluas: deposit_confirmed, rejected_at,
--    rejection_reason, rejected_snapshot kini juga terlindungi. Pengecualian:
--    perubahan deposit_confirmed SAJA pada shift closed diizinkan — itu jalur
--    konfirmasi setoran owner (RLS shifts_update sudah owner-only).
--    owner_reject_shift_report() tetap lolos lewat brilink.audit_override.
--
-- 2. Trigger baru pada bank_balances / ppob_balances / transactions /
--    receivables: baris milik shift yang sudah closed tidak boleh diedit atau
--    dihapus lewat jalur bebas. owner_adjust_balance() dan
--    owner_reject_shift_report() tetap bisa lewat override; pelunasan piutang
--    (status/paid_at/due_date) pada shift lama tetap diizinkan karena memang
--    bagian dari alur piutang lintas shift.
--
-- 3. shift_is_writable diperketat: owner tidak lagi dianggap "bisa menulis"
--    shift closed. Semua RLS insert/update/delete baris akun otomatis menolak
--    shift closed; jalur sah kini hanya RPC audit (yang punya trail + recompute).

-- ---------------------------------------------------------------------------
-- 1) Perluas trigger shifts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_closed_shift_financial_edit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Set only inside owner_adjust_balance()/owner_reject_shift_report(), and
  -- only for the duration of that transaction. Everything else hits the wall.
  IF current_setting('brilink.audit_override', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'closed' THEN
    -- Konfirmasi setoran (deposits.tsx) mengubah deposit_confirmed saja dan
    -- hanya bisa dilakukan owner (RLS shifts_update). Izinkan persis kasus itu.
    IF NEW.deposit_confirmed IS DISTINCT FROM OLD.deposit_confirmed
       AND NEW.initial_physical_balance IS NOT DISTINCT FROM OLD.initial_physical_balance
       AND NEW.final_physical_balance IS NOT DISTINCT FROM OLD.final_physical_balance
       AND NEW.additional_capital IS NOT DISTINCT FROM OLD.additional_capital
       AND NEW.modal_awal IS NOT DISTINCT FROM OLD.modal_awal
       AND NEW.modal_akhir IS NOT DISTINCT FROM OLD.modal_akhir
       AND NEW.total_expenses IS NOT DISTINCT FROM OLD.total_expenses
       AND NEW.topup_request IS NOT DISTINCT FROM OLD.topup_request
       AND NEW.deposit_amount IS NOT DISTINCT FROM OLD.deposit_amount
       AND NEW.settlement_amount IS NOT DISTINCT FROM OLD.settlement_amount
       AND NEW.expense_notes IS NOT DISTINCT FROM OLD.expense_notes
       AND NEW.owner_withdrawal IS NOT DISTINCT FROM OLD.owner_withdrawal
       AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
       AND NEW.branch_id IS NOT DISTINCT FROM OLD.branch_id
       AND NEW.start_time IS NOT DISTINCT FROM OLD.start_time
       AND NEW.end_time IS NOT DISTINCT FROM OLD.end_time
       AND NEW.status IS NOT DISTINCT FROM OLD.status
       AND NEW.rejected_at IS NOT DISTINCT FROM OLD.rejected_at
       AND NEW.rejection_reason IS NOT DISTINCT FROM OLD.rejection_reason
       AND NEW.rejected_snapshot IS NOT DISTINCT FROM OLD.rejected_snapshot
    THEN
      RETURN NEW;
    END IF;

    IF NEW.initial_physical_balance IS DISTINCT FROM OLD.initial_physical_balance
       OR NEW.final_physical_balance IS DISTINCT FROM OLD.final_physical_balance
       OR NEW.additional_capital     IS DISTINCT FROM OLD.additional_capital
       OR NEW.modal_awal             IS DISTINCT FROM OLD.modal_awal
       OR NEW.modal_akhir            IS DISTINCT FROM OLD.modal_akhir
       OR NEW.total_expenses         IS DISTINCT FROM OLD.total_expenses
       OR NEW.topup_request          IS DISTINCT FROM OLD.topup_request
       OR NEW.deposit_amount         IS DISTINCT FROM OLD.deposit_amount
       OR NEW.settlement_amount      IS DISTINCT FROM OLD.settlement_amount
       OR NEW.expense_notes          IS DISTINCT FROM OLD.expense_notes
       OR NEW.owner_withdrawal       IS DISTINCT FROM OLD.owner_withdrawal
       OR NEW.user_id                IS DISTINCT FROM OLD.user_id
       OR NEW.branch_id              IS DISTINCT FROM OLD.branch_id
       OR NEW.start_time             IS DISTINCT FROM OLD.start_time
       OR NEW.end_time               IS DISTINCT FROM OLD.end_time
       OR NEW.status                 IS DISTINCT FROM OLD.status
       OR NEW.rejected_at            IS DISTINCT FROM OLD.rejected_at
       OR NEW.rejection_reason       IS DISTINCT FROM OLD.rejection_reason
       OR NEW.rejected_snapshot      IS DISTINCT FROM OLD.rejected_snapshot
    THEN
      RAISE EXCEPTION 'Tidak boleh mengubah data keuangan shift yang sudah ditutup';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 2) Trigger baris akun untuk shift closed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_shift_row_editable(_shift_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _status public.shift_status;
BEGIN
  IF current_setting('brilink.audit_override', true) = 'on' THEN
    RETURN;
  END IF;
  SELECT status INTO _status FROM public.shifts WHERE id = _shift_id;
  IF _status = 'closed' THEN
    RAISE EXCEPTION 'Shift sudah ditutup — baris saldo/transaksinya terkunci. Gunakan jalur audit owner.';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_closed_shift_account_edit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.assert_shift_row_editable(OLD.shift_id);
  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_closed_shift_txn_edit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  _shift_id uuid;
BEGIN
  -- INSERT hanya punya NEW; DELETE hanya OLD (referensi NEW di situ error).
  IF TG_OP = 'INSERT' THEN
    _shift_id := NEW.shift_id;
  ELSIF TG_OP = 'DELETE' THEN
    _shift_id := OLD.shift_id;
  ELSE
    _shift_id := COALESCE(NEW.shift_id, OLD.shift_id);
  END IF;
  PERFORM public.assert_shift_row_editable(_shift_id);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.prevent_closed_shift_receivable_edit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.assert_shift_row_editable(NEW.shift_id);
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM public.assert_shift_row_editable(OLD.shift_id);
    RETURN OLD;
  END IF;

  -- UPDATE: pelunasan piutang di shift lama sah (status/paid_at/due_date),
  -- tapi identitas & nominalnya terkunci setelah shift ditutup.
  IF OLD.shift_id IS DISTINCT FROM NEW.shift_id
     OR OLD.transaction_id IS DISTINCT FROM NEW.transaction_id
     OR OLD.customer_name IS DISTINCT FROM NEW.customer_name
     OR OLD.debt_amount IS DISTINCT FROM NEW.debt_amount
  THEN
    PERFORM public.assert_shift_row_editable(OLD.shift_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_prevent_closed_bank_edit ON public.bank_balances;
CREATE TRIGGER trg_prevent_closed_bank_edit
  BEFORE UPDATE OR DELETE ON public.bank_balances
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_closed_shift_account_edit();

DROP TRIGGER IF EXISTS trg_prevent_closed_ppob_edit ON public.ppob_balances;
CREATE TRIGGER trg_prevent_closed_ppob_edit
  BEFORE UPDATE OR DELETE ON public.ppob_balances
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_closed_shift_account_edit();

DROP TRIGGER IF EXISTS trg_prevent_closed_txn_edit ON public.transactions;
CREATE TRIGGER trg_prevent_closed_txn_edit
  BEFORE INSERT OR UPDATE OR DELETE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_closed_shift_txn_edit();

DROP TRIGGER IF EXISTS trg_prevent_closed_receivable_edit ON public.receivables;
CREATE TRIGGER trg_prevent_closed_receivable_edit
  BEFORE INSERT OR UPDATE OR DELETE ON public.receivables
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_closed_shift_receivable_edit();

-- ---------------------------------------------------------------------------
-- 3) shift_is_writable: owner tidak lagi bisa menulis shift closed lewat jalur
--    bebas; jalur sah = RPC audit (SECURITY DEFINER, tidak melewati fungsi ini).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.shift_is_writable(_shift_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.shifts s
    WHERE s.id = _shift_id
      AND s.status = 'open'
      AND (s.user_id = auth.uid() OR public.has_role(auth.uid(), 'owner'))
  )
$function$;

-- ---------------------------------------------------------------------------
-- 4) Shift closed tidak boleh dihapus (RLS shifts_delete_owner membuka DELETE
--    untuk owner; cascade-nya ikut membawa sejarah bank/ppob/transaksi).
--    cancel_open_shift hanya menghapus shift open — tetap lolos.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_closed_shift_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF current_setting('brilink.audit_override', true) = 'on' THEN
    RETURN OLD;
  END IF;
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'Shift yang sudah ditutup tidak boleh dihapus — sejarah ledger harus utuh';
  END IF;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS trg_prevent_closed_shift_delete ON public.shifts;
CREATE TRIGGER trg_prevent_closed_shift_delete
  BEFORE DELETE ON public.shifts
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_closed_shift_delete();
