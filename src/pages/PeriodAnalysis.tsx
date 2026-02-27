import { useState, useMemo } from 'react';
import { useDataLoader } from '../hooks/useDataLoader';
import { useAppState } from '../hooks/useAppState';
import { t } from '../i18n';
import { formatSales, formatSalesShort, formatPercent } from '../utils/formatters';
import { filterByDateRange, groupByMonth, groupByWeek } from '../utils/calculations';
import { KPICard } from '../components/charts/KPICard';
import {
  BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';

const CHART_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];

type Granularity = 'daily' | 'weekly' | 'monthly';

export function PeriodAnalysis() {
  const data = useDataLoader();
  const { language, currency, exchangeRate } = useAppState();

  // Compute data boundaries
  const dateBounds = useMemo(() => {
    if (data.dailySales.length === 0) return { min: '2025-03-01', max: '2026-02-22' };
    const dates = data.dailySales.map(d => d.date).sort();
    return { min: dates[0], max: dates[dates.length - 1] };
  }, [data.dailySales]);

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
    return filterByDateRange(data.dailySales, startDate, endDate);
  }, [data.dailySales, startDate, endDate]);

  // Previous period data (same duration, immediately before)
  const prevPeriodData = useMemo(() => {
    const startMs = new Date(startDate).getTime();
    const endMs = new Date(endDate).getTime();
    const durationMs = endMs - startMs;
    const prevEnd = new Date(startMs - 86400000);
    const prevStart = new Date(prevEnd.getTime() - durationMs);
    return filterByDateRange(
      data.dailySales,
      prevStart.toISOString().substring(0, 10),
      prevEnd.toISOString().substring(0, 10),
    );
  }, [data.dailySales, startDate, endDate]);

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

  if (data.loading) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: '400px' }}>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: '#3b82f6' }} />
      </div>
    );
  }

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

  const tooltipStyle = {
    contentStyle: { backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' },
    labelStyle: { color: '#94a3b8' },
    itemStyle: { color: '#f8fafc' },
  };

  return (
    <div>
      {/* Page title */}
      <h1 className="text-2xl font-bold mb-6" style={{ color: '#f8fafc' }}>
        {t(language, 'nav.period')}
      </h1>

      {/* Date range picker */}
      <div
        className="rounded-xl p-6 mb-6"
        style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
      >
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium" style={{ color: '#94a3b8' }}>
              {t(language, 'filter.dateRange')}
            </label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              style={{ backgroundColor: '#0f172a', border: '1px solid #334155', color: '#f8fafc' }}
            />
            <span style={{ color: '#94a3b8' }}>~</span>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              style={{ backgroundColor: '#0f172a', border: '1px solid #334155', color: '#f8fafc' }}
            />
          </div>
          <div className="flex items-center gap-2">
            {quickRanges.map(qr => (
              <button
                key={String(qr.value)}
                onClick={() => applyQuickRange(qr.value)}
                className="px-3 py-1.5 rounded-full text-xs font-medium transition-colors hover:opacity-80"
                style={{ backgroundColor: '#334155', color: '#f8fafc' }}
              >
                {qr.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <KPICard
          title={t(language, 'kpi.totalSales')}
          value={formatSales(kpis.totalSales, currency, exchangeRate, language)}
          subtitle={`${kpis.dayCount}${language === 'ko' ? '일간' : '日間'}`}
        />
        <KPICard
          title={language === 'ko' ? '일 평균 매출' : '日平均売上'}
          value={formatSales(Math.round(kpis.dailyAvg), currency, exchangeRate, language)}
        />
        <KPICard
          title={t(language, 'period.vsPrevious')}
          value={formatPercent(kpis.change)}
          change={kpis.change}
          subtitle={formatSales(kpis.prevTotal, currency, exchangeRate, language)}
        />
      </div>

      {/* Time granularity toggle */}
      <div className="flex items-center gap-2 mb-6">
        {granularityOptions.map(opt => (
          <button
            key={opt.key}
            onClick={() => setGranularity(opt.key)}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{
              backgroundColor: granularity === opt.key ? '#3b82f6' : '#334155',
              color: '#f8fafc',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Sales chart by granularity */}
      <div
        className="rounded-xl p-6 mb-6"
        style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
      >
        <h3 className="text-lg font-semibold mb-4" style={{ color: '#f8fafc' }}>
          {t(language, 'chart.dailySales')}
        </h3>
        <ResponsiveContainer width="100%" height={350}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis
              dataKey="label"
              stroke="#94a3b8"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              tickFormatter={v => granularity === 'monthly' ? v : v.substring(5)}
            />
            <YAxis
              stroke="#94a3b8"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              tickFormatter={v => formatSalesShort(v)}
            />
            <Tooltip
              {...tooltipStyle}
              formatter={(value: any) => [formatSales(value, currency, exchangeRate, language), t(language, 'table.sales')]}
            />
            <Area
              type="monotone"
              dataKey="sales"
              stroke={CHART_COLORS[0]}
              fill={CHART_COLORS[0]}
              fillOpacity={0.15}
              strokeWidth={2}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Period comparison chart */}
      <div
        className="rounded-xl p-6"
        style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
      >
        <h3 className="text-lg font-semibold mb-4" style={{ color: '#f8fafc' }}>
          {t(language, 'period.vsPrevious')}
        </h3>
        <ResponsiveContainer width="100%" height={350}>
          <BarChart data={comparisonData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis
              dataKey="day"
              stroke="#94a3b8"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              label={{ value: language === 'ko' ? '일차' : '日目', position: 'insideBottom', offset: -5, fill: '#94a3b8' }}
            />
            <YAxis
              stroke="#94a3b8"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              tickFormatter={v => formatSalesShort(v)}
            />
            <Tooltip
              {...tooltipStyle}
              formatter={(value: any, name: any) => [
                formatSales(value, currency, exchangeRate, language),
                name,
              ]}
            />
            <Legend wrapperStyle={{ color: '#94a3b8' }} />
            <Bar
              dataKey="current"
              name={language === 'ko' ? '선택 기간' : '選択期間'}
              fill={CHART_COLORS[0]}
              radius={[2, 2, 0, 0]}
            />
            <Bar
              dataKey="previous"
              name={language === 'ko' ? '이전 기간' : '前期間'}
              fill={CHART_COLORS[1]}
              opacity={0.6}
              radius={[2, 2, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
