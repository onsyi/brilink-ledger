import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

/**
 * Subscribes to Postgres realtime changes on the reporting tables and
 * invalidates the relevant TanStack Query keys so dashboard/reports stay
 * fresh without manual refresh. Tables must be in the supabase_realtime
 * publication (added in the initial schema migration).
 *
 * Session-aware: only subscribes while a session exists, and tears down on
 * sign-out so a channel for one user never leaks into another user's session.
 */
export function useRealtimeRefresh(queryClient: QueryClient) {
  useEffect(() => {
    let channel: RealtimeChannel | null = null;
    let active = true;

    const invalidate = (keys: string[][]) => {
      for (const key of keys) queryClient.invalidateQueries({ queryKey: key });
    };

    const setup = async () => {
      if (!active) return;
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!active || !session || channel) return;

      channel = supabase
        .channel("ledger-realtime")
        .on("postgres_changes", { event: "*", schema: "public", table: "shifts" }, () =>
          invalidate([
            ["open-shift"],
            ["last-closed-shift"],
            ["owner-overview"],
            ["shift-reports"],
            ["deposit-shifts"],
          ]),
        )
        .on("postgres_changes", { event: "*", schema: "public", table: "transactions" }, () =>
          invalidate([["txns"], ["owner-overview"], ["shift-reports"]]),
        )
        .on("postgres_changes", { event: "*", schema: "public", table: "receivables" }, () =>
          invalidate([["pending-receivables"], ["shift-reports"]]),
        )
        .subscribe();
    };

    void setup();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") {
        if (channel) {
          supabase.removeChannel(channel);
          channel = null;
        }
        void setup();
      } else if (event === "SIGNED_OUT") {
        if (channel) {
          supabase.removeChannel(channel);
          channel = null;
        }
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
      if (channel) supabase.removeChannel(channel);
    };
  }, [queryClient]);
}
