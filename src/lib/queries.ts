import { supabase } from "@/integrations/supabase/client";

/**
 * The active-shift row, shared by the Shift and Tutup Shift screens.
 *
 * Both screens cache under the same query key, so they must also request the
 * same columns — otherwise whichever screen loads first decides what the other
 * one sees, and the loser silently reads `undefined` for the fields it selected
 * but the winner did not.
 */
export const OPEN_SHIFT_COLUMNS =
  "id, user_id, start_time, initial_physical_balance, total_expenses, status, modal_awal, " +
  "rejected_at, rejection_reason, rejected_snapshot";

/**
 * Angka penutupan yang ditolak owner, disalin apa adanya oleh
 * owner_reject_shift_report() sebelum kolomnya dikosongkan.
 *
 * Dipakai mengisi ulang form Tutup Shift: kasir diminta mengoreksi laporannya,
 * bukan mengetik ulang lima belas kolom saldo dari nol.
 */
export type RejectedSnapshot = {
  final_physical_balance?: number | string | null;
  additional_capital?: number | string | null;
  total_expenses?: number | string | null;
  expense_notes?: string | null;
  topup_request?: number | string | null;
  deposit_amount?: number | string | null;
  settlement_amount?: number | string | null;
  owner_withdrawal?: number | string | null;
  bank?: Record<string, number | string> | null;
  ppob?: Record<string, number | string> | null;
};

export type OpenShiftRow = {
  id: string;
  user_id: string;
  start_time: string;
  initial_physical_balance: number | string;
  total_expenses: number | string;
  status: string;
  modal_awal: number | string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  rejected_snapshot: RejectedSnapshot | null;
};

export function openShiftQuery(userId: string | undefined, enabled: boolean) {
  return {
    queryKey: ["open-shift", userId] as const,
    enabled: !!userId && enabled,
    queryFn: async (): Promise<OpenShiftRow | null> => {
      const { data, error } = await supabase
        .from("shifts")
        .select(OPEN_SHIFT_COLUMNS)
        .eq("user_id", userId!)
        .eq("status", "open")
        .maybeSingle();
      if (error) throw error;
      return data as OpenShiftRow | null;
    },
  };
}

export type TxnRow = {
  id: string;
  shift_id: string;
  transaction_type: string;
  source_account: string;
  destination_account: string;
  principal_amount: number | string;
  customer_fee: number | string;
  provider_cost: number | string;
  profit_net: number | string | null;
  note: string | null;
  client_ref: string | null;
  created_at: string;
};

export function txnsQuery(shiftId: string | undefined) {
  return {
    queryKey: ["txns", shiftId] as const,
    enabled: !!shiftId,
    queryFn: async (): Promise<TxnRow[]> => {
      const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .eq("shift_id", shiftId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as TxnRow[];
    },
  };
}

export type ReceivableRow = {
  id: string;
  transaction_id: string | null;
  shift_id: string;
  customer_name: string;
  debt_amount: number | string;
  due_date: string | null;
  status: string;
  created_at: string;
  shift_start_time?: string | null;
};

/**
 * Piutang yang belum lunas milik kasir — lintas shift, karena pelunasan bisa
 * terjadi jauh setelah shift dibukanya ditutup (RLS recv_update memakai
 * shift_is_readable, bukan writable, persis untuk alur ini).
 */
export function pendingReceivablesQuery(userId: string | undefined) {
  return {
    queryKey: ["pending-receivables", userId] as const,
    enabled: !!userId,
    queryFn: async (): Promise<ReceivableRow[]> => {
      const { data, error } = await supabase
        .from("receivables")
        .select(
          "id, transaction_id, shift_id, customer_name, debt_amount, due_date, status, created_at, shifts!inner(start_time)",
        )
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data as Array<ReceivableRow & { shifts: { start_time: string } | null }>).map(
        (r) => ({ ...r, shift_start_time: r.shifts?.start_time ?? null }),
      );
    },
  };
}
