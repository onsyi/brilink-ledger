import { useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  getAllPending,
  removePending,
  isOnline,
  type PendingRecord,
} from "@/lib/offline-db";

async function syncRecord(record: PendingRecord): Promise<boolean> {
  try {
    const { error } = await supabase.from(record.table as never).insert(record.payload as never);
    if (error) {
      console.error(`[OfflineSync] Failed to sync ${record.table}:`, error.message);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function syncAll(): Promise<{ synced: number; failed: number }> {
  const pending = await getAllPending();
  let synced = 0;
  let failed = 0;

  for (const record of pending) {
    const ok = await syncRecord(record);
    if (ok) {
      await removePending(record.id);
      synced++;
    } else {
      failed++;
    }
  }

  return { synced, failed };
}

export function useOfflineSync() {
  const handleSync = useCallback(async () => {
    if (!isOnline()) return;
    const result = await syncAll();
    if (result.synced > 0) {
      console.log(`[OfflineSync] Synced ${result.synced} records`);
    }
    if (result.failed > 0) {
      console.warn(`[OfflineSync] ${result.failed} records failed to sync`);
    }
  }, []);

  useEffect(() => {
    if (!isOnline()) return;

    handleSync();

    const onlineHandler = () => handleSync();
    window.addEventListener("online", onlineHandler);
    return () => window.removeEventListener("online", onlineHandler);
  }, [handleSync]);

  return { syncNow: handleSync, isOnline };
}
