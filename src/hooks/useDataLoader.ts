import { useState, useEffect } from 'react';
import type { DailySale, MonthlySummary, TitleSummary, PlatformSummary, TitleMaster } from '../types';

interface DashboardData {
  dailySales: DailySale[];
  monthlySummary: MonthlySummary[];
  titleSummary: TitleSummary[];
  platformSummary: PlatformSummary[];
  titleMaster: TitleMaster[];
  loading: boolean;
  error: string | null;
}

export function useDataLoader(): DashboardData {
  const [data, setData] = useState<DashboardData>({
    dailySales: [],
    monthlySummary: [],
    titleSummary: [],
    platformSummary: [],
    titleMaster: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    async function load() {
      try {
        const [daily, monthly, titles, platforms, master] = await Promise.all([
          fetch('/data/daily_sales.json').then(r => r.json()),
          fetch('/data/monthly_summary.json').then(r => r.json()),
          fetch('/data/title_summary.json').then(r => r.json()),
          fetch('/data/platform_summary.json').then(r => r.json()),
          fetch('/data/title_master.json').then(r => r.json()),
        ]);
        setData({
          dailySales: daily,
          monthlySummary: monthly,
          titleSummary: titles,
          platformSummary: platforms,
          titleMaster: master,
          loading: false,
          error: null,
        });
      } catch (e) {
        setData(prev => ({ ...prev, loading: false, error: String(e) }));
      }
    }
    load();
  }, []);

  return data;
}
