import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Subscribes to Postgres realtime changes on the reporting tables and
 * invalidates the relevant TanStack Query keys so dashboard/reports stay
 * fresh without manual refresh. Tables must be in the supabase_realtime
 * publication (added in the initial schema migration).
 */
export function useRealtimeRefresh(queryClient: QueryClient) {
  useEffect(() => {
    const channel = supabase
      .channel("ledger-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "shifts" }, () => {
        queryClient.invalidateQueries({ queryKey: ["open-shift"] });
        queryClient.invalidateQueries({ queryKey: ["last-closed-shift"] });
        queryClient.invalidateQueries({ queryKey: ["owner-overview"] });
        queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
        queryClient.invalidateQueries({ queryKey: ["deposit-shifts"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "transactions" }, () => {
        queryClient.invalidateQueries({ queryKey: ["txns"] });
        queryClient.invalidateQueries({ queryKey: ["owner-overview"] });
        queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "receivables" }, () => {
        queryClient.invalidateQueries({ queryKey: ["pending-receivables"] });
        queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);
}
