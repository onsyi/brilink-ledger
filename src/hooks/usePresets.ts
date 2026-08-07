import { useState, useEffect, useCallback } from "react";

export type TransactionPreset = {
  id: string;
  name: string;
  transactionType: string;
  source: string;
  destination: string;
  defaultFee: string;
  defaultCost: string;
  channel: string;
};

const STORAGE_KEY = "brilink-txn-presets";

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function usePresets() {
  const [presets, setPresets] = useState<TransactionPreset[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setPresets(JSON.parse(stored));
    } catch {
      // ignore
    }
  }, []);

  const save = useCallback((list: TransactionPreset[]) => {
    setPresets(list);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
      // ignore
    }
  }, []);

  const addPreset = useCallback((p: Omit<TransactionPreset, "id">) => {
    const entry = { ...p, id: generateId() };
    setPresets((prev) => {
      const next = [...prev, entry];
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // quota exceeded
      }
      return next;
    });
  }, []);

  const removePreset = useCallback((id: string) => {
    setPresets((prev) => {
      const next = prev.filter((p) => p.id !== id);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const updatePreset = useCallback((id: string, updates: Partial<TransactionPreset>) => {
    setPresets((prev) => {
      const next = prev.map((p) => (p.id === id ? { ...p, ...updates } : p));
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  return { presets, addPreset, removePreset, updatePreset };
}
