// ---------------------------------------------------------------------------
// Hook for managing 초동매출 (Initial Sales) data
// Uses same module-level store pattern as useDataLoader
// ---------------------------------------------------------------------------
import { useState, useEffect, useSyncExternalStore } from 'react';
import type { InitialSalesData } from '@/types/initialSales';

/* ------------------------------------------------------------------ */
/*  Module-level store                                                  */
/* ------------------------------------------------------------------ */

const SESSION_KEY = 'rvjp_initial_sales';

let snapshot: InitialSalesData | null = null;
const listeners = new Set<() => void>();

function emitChange() {
  for (const fn of listeners) fn();
}

// Restore from sessionStorage on module load
try {
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (stored) {
    snapshot = JSON.parse(stored);
  }
} catch {
  // ignore parse errors
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): InitialSalesData | null {
  return snapshot;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/** Save initial sales data (called from DataUploader or parser) */
export function setInitialSalesData(data: InitialSalesData | null) {
  snapshot = data;
  if (data) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
    } catch {
      // sessionStorage full — still works in-memory
    }
  } else {
    sessionStorage.removeItem(SESSION_KEY);
  }
  emitChange();
}

/** Check if initial sales data is available */
export function hasInitialSalesData(): boolean {
  return snapshot !== null;
}

/** Clear initial sales data */
export function clearInitialSalesData() {
  setInitialSalesData(null);
}

/* ------------------------------------------------------------------ */
/*  Hook                                                                */
/* ------------------------------------------------------------------ */

export function useInitialSales(): {
  data: InitialSalesData | null;
  loading: boolean;
} {
  const uploaded = useSyncExternalStore(subscribe, getSnapshot);
  const [fallback, setFallback] = useState<InitialSalesData | null>(null);
  const [loading, setLoading] = useState(!uploaded);

  useEffect(() => {
    if (uploaded) {
      setLoading(false);
      return;
    }

    // Fallback: load from static JSON
    let cancelled = false;
    setLoading(true);

    fetch('/data/initial_sales.json')
      .then(r => {
        if (!r.ok) throw new Error('not found');
        return r.json();
      })
      .then((data: InitialSalesData) => {
        if (!cancelled) {
          setFallback(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [uploaded]);

  return {
    data: uploaded ?? fallback,
    loading,
  };
}
