import { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import type { DailySale, MonthlySummary, TitleSummary, PlatformSummary, TitleMaster } from '../types';
import type { ConvertedData } from '@/utils/excelConverter';
import {
  isSupabaseConfigured,
  fetchActiveDataset,
  fetchAllDailySales,
  getCachedDailySales,
  clearSupabaseCache,
} from '@/lib/supabase';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface DashboardData {
  dailySales: DailySale[];
  monthlySummary: MonthlySummary[];
  titleSummary: TitleSummary[];
  platformSummary: PlatformSummary[];
  titleMaster: TitleMaster[];
  loading: boolean;
  error: string | null;
  isUploaded: boolean;
}

/* ------------------------------------------------------------------ */
/*  Module-level store for uploaded data                               */
/*  Shared across all useDataLoader() instances.                       */
/* ------------------------------------------------------------------ */

const SESSION_KEY = 'rvjp_uploaded_data';

let uploadedSnapshot: ConvertedData | null = null;
const listeners = new Set<() => void>();

function emitChange() {
  for (const fn of listeners) fn();
}

// Restore from sessionStorage on module load
try {
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (stored) {
    uploadedSnapshot = JSON.parse(stored);
  }
} catch {
  // ignore parse errors
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ConvertedData | null {
  return uploadedSnapshot;
}

/** Set uploaded data (call from DataUploader). Persists to sessionStorage. */
export function setUploadedData(data: ConvertedData | null) {
  uploadedSnapshot = data;
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

/** Check if uploaded data exists */
export function hasUploadedData(): boolean {
  return uploadedSnapshot !== null;
}

/** Clear uploaded data and revert to static files */
export function clearUploadedData() {
  clearSupabaseCache();
  setUploadedData(null);
}

/* ------------------------------------------------------------------ */
/*  Module-level Supabase data cache                                   */
/*  Prevents re-fetching on every page navigation.                     */
/* ------------------------------------------------------------------ */

type SummaryData = Omit<DashboardData, 'loading' | 'error' | 'isUploaded'>;
let _supabaseCache: SummaryData | null = null;

/* ------------------------------------------------------------------ */
/*  useDataLoader — main hook                                          */
/* ------------------------------------------------------------------ */

export function useDataLoader(): DashboardData {
  const uploaded = useSyncExternalStore(subscribe, getSnapshot);

  // Initialize from cache — prevents loading flicker on page navigation
  const [staticData, setStaticData] = useState<{
    data: SummaryData | null;
    loading: boolean;
    error: string | null;
  }>(() => ({
    data: _supabaseCache,
    loading: !uploaded && _supabaseCache === null,
    error: null,
  }));

  // Fetch data: Supabase first → static JSON fallback
  useEffect(() => {
    // Skip fetching if we already have uploaded data
    if (uploaded) {
      setStaticData(prev => ({ ...prev, loading: false }));
      return;
    }

    // Cache hit — no network needed
    if (_supabaseCache) {
      setStaticData({ data: _supabaseCache, loading: false, error: null });
      return;
    }

    let cancelled = false;
    async function load() {
      try {
        // Try Supabase first
        if (isSupabaseConfigured) {
          const supaData = await fetchActiveDataset();
          // dailySales is loaded on-demand (lazy); check summaries instead
          if (!cancelled && supaData && supaData.titleSummary.length > 0) {
            _supabaseCache = supaData;
            setStaticData({ data: supaData, loading: false, error: null });
            return;
          }
        }

        // Fallback to static JSON files
        const [daily, monthly, titles, platforms, master] = await Promise.all([
          fetch('/data/daily_sales.json').then(r => r.json()),
          fetch('/data/monthly_summary.json').then(r => r.json()),
          fetch('/data/title_summary.json').then(r => r.json()),
          fetch('/data/platform_summary.json').then(r => r.json()),
          fetch('/data/title_master.json').then(r => r.json()),
        ]);
        if (!cancelled) {
          setStaticData({
            data: {
              dailySales: daily,
              monthlySummary: monthly,
              titleSummary: titles,
              platformSummary: platforms,
              titleMaster: master,
            },
            loading: false,
            error: null,
          });
        }
      } catch (e) {
        if (!cancelled) {
          setStaticData(prev => ({ ...prev, loading: false, error: String(e) }));
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [uploaded]);

  // If uploaded data exists, use it; otherwise fall back to static
  if (uploaded) {
    return {
      dailySales: uploaded.dailySales,
      monthlySummary: uploaded.monthlySummary,
      titleSummary: uploaded.titleSummary,
      platformSummary: uploaded.platformSummary,
      titleMaster: uploaded.titleMaster,
      loading: false,
      error: null,
      isUploaded: true,
    };
  }

  return {
    dailySales: staticData.data?.dailySales ?? [],
    monthlySummary: staticData.data?.monthlySummary ?? [],
    titleSummary: staticData.data?.titleSummary ?? [],
    platformSummary: staticData.data?.platformSummary ?? [],
    titleMaster: staticData.data?.titleMaster ?? [],
    loading: staticData.loading,
    error: staticData.error,
    isUploaded: false,
  };
}

/* ------------------------------------------------------------------ */
/*  useDailySales — lazy-load hook for pages needing daily_sales       */
/*  Uses parallel fetch + module cache + promise dedup.                */
/* ------------------------------------------------------------------ */

export function useDailySales(data: DashboardData): {
  dailySales: DailySale[];
  loading: boolean;
} {
  const hasClientData = data.isUploaded || data.dailySales.length > 0;

  // Initialize from best available source (no loading flicker if cached)
  const [state, setState] = useState<{ rows: DailySale[]; fetching: boolean }>(() => {
    if (hasClientData) return { rows: data.dailySales, fetching: false };
    const cached = getCachedDailySales();
    if (cached) return { rows: cached, fetching: false };
    return { rows: [], fetching: !data.loading };
  });

  const fetchedRef = useRef(false);

  useEffect(() => {
    // Wait for main data to finish loading
    if (data.loading) return;

    // Client data (uploaded or static JSON) — use directly
    if (hasClientData) {
      setState({ rows: data.dailySales, fetching: false });
      fetchedRef.current = true;
      return;
    }

    // Already cached in memory
    const cached = getCachedDailySales();
    if (cached) {
      setState({ rows: cached, fetching: false });
      fetchedRef.current = true;
      return;
    }

    // Fetch from Supabase (parallel, with dedup + cache in supabase.ts)
    if (isSupabaseConfigured && !fetchedRef.current) {
      fetchedRef.current = true;
      setState(prev => ({ ...prev, fetching: true }));
      fetchAllDailySales().then(rows => {
        setState({ rows, fetching: false });
      });
    }
  }, [data.loading, data.isUploaded, data.dailySales.length]);

  return {
    dailySales: state.rows,
    loading: data.loading || state.fetching,
  };
}
