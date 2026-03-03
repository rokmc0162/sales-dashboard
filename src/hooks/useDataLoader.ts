import { useState, useEffect, useSyncExternalStore } from 'react';
import type { DailySale, MonthlySummary, TitleSummary, PlatformSummary, TitleMaster } from '../types';
import type { ConvertedData } from '@/utils/excelConverter';
import { isSupabaseConfigured, fetchActiveDataset } from '@/lib/supabase';

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
  setUploadedData(null);
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export function useDataLoader(): DashboardData {
  const uploaded = useSyncExternalStore(subscribe, getSnapshot);

  const [staticData, setStaticData] = useState<{
    data: Omit<DashboardData, 'loading' | 'error' | 'isUploaded'> | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });

  // Fetch data: Supabase first → static JSON fallback
  useEffect(() => {
    // Skip fetching if we already have uploaded data
    if (uploaded) {
      setStaticData(prev => ({ ...prev, loading: false }));
      return;
    }

    let cancelled = false;
    async function load() {
      try {
        // Try Supabase first
        if (isSupabaseConfigured) {
          const supaData = await fetchActiveDataset();
          // dailySales is now loaded on-demand (lazy); check summaries instead
          if (!cancelled && supaData && supaData.titleSummary.length > 0) {
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
