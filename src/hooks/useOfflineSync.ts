import { useEffect, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  getAllPending,
  removePending,
  clearPending,
  isOnline,
  type PendingRecord,
} from "@/lib/offline-db";

const MAX_RETRIES = 5;

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

async function syncAll(): Promise<{ synced: number; failed: number; cleaned: number }> {
  const pending = await getAllPending();
  let synced = 0;
  let failed = 0;
  let cleaned = 0;

  for (const record of pending) {
    const retries = (record as unknown as { retries?: number }).retries ?? 0;
    const ok = await syncRecord(record);
    if (ok) {
      await removePending(record.id);
      synced++;
    } else if (retries >= MAX_RETRIES) {
      // Permanently failed — remove to prevent accumulation
      await removePending(record.id);
      cleaned++;
    } else {
      failed++;
    }
  }

  return { synced, failed, cleaned };
}

export function useOfflineSync() {
  const syncingRef = useRef(false);

  const handleSync = useCallback(async () => {
    if (!isOnline() || syncingRef.current) return;
    syncingRef.current = true;
    try {
      const result = await syncAll();
      if (result.synced > 0) {
        console.log(`[OfflineSync] Synced ${result.synced} records`);
      }
      if (result.cleaned > 0) {
        console.warn(`[OfflineSync] Removed ${result.cleaned} permanently failed records`);
      }
      if (result.failed > 0) {
        console.warn(`[OfflineSync] ${result.failed} records failed, will retry`);
      }
    } finally {
      syncingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!isOnline()) return;

    handleSync();

    const onlineHandler = () => handleSync();
    window.addEventListener("online", onlineHandler);
    return () => window.removeEventListener("online", onlineHandler);
  }, [handleSync]);

  return { syncNow: handleSync, isOnline, clearAll: clearPending };
}
