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
  "id, user_id, start_time, initial_physical_balance, total_expenses, status, modal_awal";

export type OpenShiftRow = {
  id: string;
  user_id: string;
  start_time: string;
  initial_physical_balance: number | string;
  total_expenses: number | string;
  status: string;
  modal_awal: number | string | null;
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
