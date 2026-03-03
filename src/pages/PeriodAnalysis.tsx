import { useState, useMemo, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useAppState } from '@/hooks/useAppState';
import { isSupabaseConfigured, fetchAllDailySales } from '@/lib/supabase';
import type { DailySale } from '@/types';
import { t } from '@/i18n';
import { formatSales, formatSalesShort, formatPercent } from '@/utils/formatters';
import { filterByDateRange, groupByMonth, groupByWeek } from '@/utils/calculations';
import { CHART_COLORS, tooltipStyle, staggerContainer, staggerItem } from '@/lib/constants';
import { KPICard } from '@/components/charts/KPICard';
import { Card, CardContent } from '@/components/ui/card';
import { ChartCard } from '@/components/ui/chart-card';
import { DashboardGrid } from '@/components/layout/DashboardGrid';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';

type Granularity = 'daily' | 'weekly' | 'monthly';

/* ------------------------------------------------------------------ */
/*  Skeleton loader                                                    */
/* ------------------------------------------------------------------ */

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-64" />
      <Card variant="glass"><CardContent className="p-6">
        <div className="flex flex-wrap gap-4">
          <Skeleton className="h-10 w-32" /><Skeleton className="h-10 w-32" /><Skeleton className="h-10 w-32" />
          <div className="flex gap-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10 w-20 rounded-full" />)}</div>
        </div>
      </CardContent></Card>
      <DashboardGrid cols={3}>
        {[...Array(3)].map((_, i) => <Card key={i} variant="glass"><CardContent className="p-6 space-y-3">
          <Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-36" /><Skeleton className="h-4 w-20" />
        </CardContent></Card>)}
      </DashboardGrid>
      <Skeleton className="h-10 w-64" />
      <Card variant="glass"><CardContent className="p-6"><Skeleton className="h-5 w-40 mb-4" /><Skeleton className="h-96 w-full rounded-xl" /></CardContent></Card>
      <Card variant="glass"><CardContent className="p-6"><Skeleton className="h-5 w-40 mb-4" /><Skeleton className="h-96 w-full rounded-xl" /></CardContent></Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function PeriodAnalysis() {
  const data = useDataLoader();
  const { language, currency, exchangeRate } = useAppState();

  // Lazy-load dailySales from Supabase (not fetched during initial load for speed)
  const [localDailySales, setLocalDailySales] = useState<DailySale[]>(data.dailySales);
  const [loadingDaily, setLoadingDaily] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    // If uploaded data exists, use it directly
    if (data.isUploaded || data.dailySales.length > 0) {
      setLocalDailySales(data.dailySales);
      fetchedRef.current = true;
      return;
    }
    // Fetch from Supabase once
    if (isSupabaseConfigured && !fetchedRef.current) {
      fetchedRef.current = true;
      setLoadingDaily(true);
      fetchAllDailySales().then(rows => {
        setLocalDailySales(rows);
        setLoadingDaily(false);
      });
    }
  }, [data.isUploaded, data.dailySales]);

  // Show skeleton while loading dailySales
  if (data.loading || loadingDaily) {
    return <LoadingSkeleton />;
  }

  // Compute data boundaries
  const dateBounds = useMemo(() => {
    if (localDailySales.length === 0) return { min: '2025-03-01', max: '2026-02-22' };
    const dates = localDailySales.map(d => d.date).sort();
    return { min: dates[0], max: dates[dates.length - 1] };
  }, [localDailySales]);

  const [startDate, setStartDate] = useState(dateBounds.min);
  const [endDate, setEndDate] = useState(dateBounds.max);
  const [granularity, setGranularity] = useState<Granularity>('daily');

  // Quick date selectors
  const applyQuickRange = (days: number | 'all') => {
    if (days === 'all') {
      setStartDate(dateBounds.min);
      setEndDate(dateBounds.max);
      return;
    }
    const end = new Date(dateBounds.max);
    const start = new Date(end);
    start.setDate(start.getDate() - days + 1);
    setStartDate(start.toISOString().substring(0, 10));
    setEndDate(dateBounds.max);
  };

  // Filtered data for selected period
  const filteredData = useMemo(() => {
    return filterByDateRange(localDailySales, startDate, endDate);
  }, [localDailySales, startDate, endDate]);

  // Previous period data (same duration, immediately before)
  const prevPeriodData = useMemo(() => {
    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    const durationMs = endMs - startMs;
    const prevEnd = new Date(startMs - 86400000);
    const prevStart = new Date(prevEnd.getTime() - durationMs);
    return filterByDateRange(
      localDailySales,
      prevStart.toISOString().substring(0, 10),
      prevEnd.toISOString().substring(0, 10),
    );
  }, [localDailySales, startDate, endDate]);

  // KPI calculations
  const kpis = useMemo(() => {
    const totalSales = filteredData.reduce((s, d) => s + d.sales, 0);
    const prevTotal = prevPeriodData.reduce((s, d) => s + d.sales, 0);
    const dayCount = Math.max(1, Math.round(
      (new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000 + 1,
    ));
    const dailyAvg = totalSales / dayCount;
    const change = prevTotal > 0 ? ((totalSales - prevTotal) / prevTotal) * 100 : 0;

    return { totalSales, dailyAvg, change, prevTotal, dayCount };
  }, [filteredData, prevPeriodData, startDate, endDate]);

  // Chart data by granularity
  const chartData = useMemo(() => {
    if (granularity === 'monthly') {
      const map = groupByMonth(filteredData);
      return Array.from(map.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, sales]) => ({ label, sales }));
    }
    if (granularity === 'weekly') {
      const map = groupByWeek(filteredData);
      return Array.from(map.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, sales]) => ({ label, sales }));
    }
    // daily: aggregate all titles by date
    const map = new Map<string, number>();
    filteredData.forEach(d => {
      map.set(d.date, (map.get(d.date) || 0) + d.sales);
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, sales]) => ({ label, sales }));
  }, [filteredData, granularity]);

  // Comparison chart: current vs previous period (aligned by day index)
  const comparisonData = useMemo(() => {
    const aggregate = (items: typeof filteredData) => {
      const map = new Map<string, number>();
      items.forEach(d => map.set(d.date, (map.get(d.date) || 0) + d.sales));
      return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
    };

    const currentAgg = aggregate(filteredData);
    const prevAgg = aggregate(prevPeriodData);

    const maxLen = Math.max(currentAgg.length, prevAgg.length);
    const result: { day: number; current: number; previous: number }[] = [];
    for (let i = 0; i < maxLen; i++) {
      result.push({
        day: i + 1,
        current: currentAgg[i]?.[1] ?? 0,
        previous: prevAgg[i]?.[1] ?? 0,
      });
    }
    return result;
  }, [filteredData, prevPeriodData]);

  const granularityOptions: { key: Granularity; label: string }[] = [
    { key: 'daily', label: t(language, 'period.daily') },
    { key: 'weekly', label: t(language, 'period.weekly') },
    { key: 'monthly', label: t(language, 'period.monthly') },
  ];

  const quickRanges: { label: string; value: number | 'all' }[] = [
    { label: t(language, 'filter.last7d'), value: 7 },
    { label: t(language, 'filter.last30d'), value: 30 },
    { label: t(language, 'filter.last90d'), value: 90 },
    { label: t(language, 'filter.all'), value: 'all' },
  ];

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={staggerContainer}
    >
      {/* Page title */}
      <motion.h1
        variants={staggerItem}
        className="text-2xl font-bold mb-8 text-primary tracking-tight"
      >
        {t(language, 'nav.period')}
      </motion.h1>

      {/* Date range picker */}
      <motion.div variants={staggerItem} className="mb-6">
        <Card variant="glass">
          <CardContent className="p-6">
            <div className="flex flex-col md:flex-row flex-wrap items-start md:items-center gap-4">
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 w-full sm:w-auto">
                <label className="text-sm font-semibold text-text-secondary">
                  {t(language, 'filter.dateRange')}
                </label>
                <Input
                  type="date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  className="w-auto"
                />
                <span className="text-base font-medium text-text-muted">~</span>
                <Input
                  type="date"
                  value={endDate}
                  onChange={e => setEndDate(e.target.value)}
                  className="w-auto"
                />
              </div>
              <div className="flex items-center gap-2">
                {quickRanges.map(qr => (
                  <Button
                    key={String(qr.value)}
                    variant="outline"
                    size="sm"
                    onClick={() => applyQuickRange(qr.value)}
                    className="rounded-full"
                  >
                    {qr.label}
                  </Button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* KPI Cards */}
      <motion.div variants={staggerContainer} initial="hidden" animate="show">
        <DashboardGrid cols={3} className="mb-6">
          <motion.div variants={staggerItem}>
            <KPICard
              title={t(language, 'kpi.totalSales')}
              value={formatSales(kpis.totalSales, currency, exchangeRate, language)}
              subtitle={`${kpis.dayCount}${language === 'ko' ? '일간' : '日間'}`}
            />
          </motion.div>
          <motion.div variants={staggerItem}>
            <KPICard
              title={language === 'ko' ? '일 평균 매출' : '日平均売上'}
              value={formatSales(Math.round(kpis.dailyAvg), currency, exchangeRate, language)}
            />
          </motion.div>
          <motion.div variants={staggerItem}>
            <KPICard
              title={t(language, 'period.vsPrevious')}
              value={formatPercent(kpis.change)}
              change={kpis.change}
              subtitle={formatSales(kpis.prevTotal, currency, exchangeRate, language)}
            />
          </motion.div>
        </DashboardGrid>
      </motion.div>

      {/* Time granularity toggle */}
      <motion.div variants={staggerItem} className="mb-6">
        <Tabs
          defaultValue="daily"
          value={granularity}
          onValueChange={(v) => setGranularity(v as Granularity)}
        >
          <TabsList variant="glass">
            {granularityOptions.map(opt => (
              <TabsTrigger key={opt.key} value={opt.key}>
                {opt.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </motion.div>

      {/* Sales chart by granularity */}
      <motion.div variants={staggerItem} className="mb-6">
        <ChartCard title={t(language, 'chart.dailySales')} variant="glass">
          <ResponsiveContainer width="100%" height={370}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="salesGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2563EB" stopOpacity={0.20} />
                  <stop offset="100%" stopColor="#2563EB" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis
                dataKey="label"
                stroke="#CBD5E1"
                tick={{ fill: '#64748B', fontSize: 12, fontWeight: 500 }}
                tickFormatter={(v: any) => granularity === 'monthly' ? v : v.substring(5)}
              />
              <YAxis
                stroke="#CBD5E1"
                tick={{ fill: '#64748B', fontSize: 12, fontWeight: 500 }}
                tickFormatter={(v: any) => formatSalesShort(v)}
              />
              <Tooltip
                {...tooltipStyle}
                formatter={(value: any) => [formatSales(value, currency, exchangeRate, language), t(language, 'table.sales')]}
              />
              <Area
                type="monotone"
                dataKey="sales"
                stroke={CHART_COLORS[0]}
                fill="url(#salesGradient)"
                strokeWidth={2.5}
                dot={false}
                activeDot={{ r: 5, fill: CHART_COLORS[0], stroke: '#fff', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </motion.div>

      {/* Period comparison chart */}
      <motion.div variants={staggerItem}>
        <ChartCard title={t(language, 'period.vsPrevious')} variant="glass">
          <ResponsiveContainer width="100%" height={370}>
            <BarChart data={comparisonData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis
                dataKey="day"
                stroke="#CBD5E1"
                tick={{ fill: '#64748B', fontSize: 12, fontWeight: 500 }}
                label={{ value: language === 'ko' ? '일차' : '日目', position: 'insideBottom', offset: -5, fill: '#94A3B8', fontSize: 13 }}
              />
              <YAxis
                stroke="#CBD5E1"
                tick={{ fill: '#64748B', fontSize: 12, fontWeight: 500 }}
                tickFormatter={(v: any) => formatSalesShort(v)}
              />
              <Tooltip
                {...tooltipStyle}
                formatter={(value: any, name: any) => [
                  formatSales(value, currency, exchangeRate, language),
                  name,
                ]}
              />
              <Legend
                wrapperStyle={{ color: '#475569', fontSize: '14px', fontWeight: 500 }}
              />
              <Bar
                dataKey="current"
                name={language === 'ko' ? '선택 기간' : '選択期間'}
                fill={CHART_COLORS[0]}
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="previous"
                name={language === 'ko' ? '이전 기간' : '前期間'}
                fill={CHART_COLORS[1]}
                opacity={0.55}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </motion.div>
    </motion.div>
  );
}
