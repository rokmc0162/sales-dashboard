import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
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

const CHART_COLORS = ['#2563EB', '#7C3AED', '#0891B2', '#16A34A', '#D97706', '#DC2626', '#DB2777', '#0D9488', '#4F46E5', '#EA580C'];

type Granularity = 'daily' | 'weekly' | 'monthly';

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

const stagger = {
  visible: {
    transition: { staggerChildren: 0.08 },
  },
};

const tooltipStyle = {
  contentStyle: { backgroundColor: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' },
  labelStyle: { color: '#475569', fontWeight: 600 },
  itemStyle: { color: '#0F172A' },
};

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
        <div className="animate-spin rounded-full h-10 w-10 border-b-2" style={{ borderColor: '#2563EB' }} />
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

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={stagger}
    >
      {/* Page title */}
      <motion.h1
        variants={fadeIn}
        className="font-bold mb-8"
        style={{ color: '#0F1B4C', fontSize: '28px', letterSpacing: '-0.025em' }}
      >
        {t(language, 'nav.period')}
      </motion.h1>

      {/* Date range picker */}
      <motion.div
        variants={fadeIn}
        className="rounded-2xl p-6 mb-6"
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E2E8F0',
          boxShadow: '0 1px 3px 0 rgba(0,0,0,0.05)',
        }}
      >
        <div className="flex flex-col md:flex-row flex-wrap items-start md:items-center gap-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 w-full sm:w-auto">
            <label className="font-semibold" style={{ color: '#475569', fontSize: '14px' }}>
              {t(language, 'filter.dateRange')}
            </label>
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"
              style={{
                backgroundColor: '#ffffff',
                border: '1px solid #CBD5E1',
                color: '#0F172A',
                fontSize: '15px',
                fontWeight: 500,
              }}
            />
            <span style={{ color: '#94A3B8', fontSize: '16px', fontWeight: 500 }}>~</span>
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"
              style={{
                backgroundColor: '#ffffff',
                border: '1px solid #CBD5E1',
                color: '#0F172A',
                fontSize: '15px',
                fontWeight: 500,
              }}
            />
          </div>
          <div className="flex items-center gap-2">
            {quickRanges.map(qr => (
              <button
                key={String(qr.value)}
                onClick={() => applyQuickRange(qr.value)}
                className="px-4 py-2 rounded-full font-semibold transition-all duration-200 hover:shadow-md"
                style={{
                  backgroundColor: '#F1F5F9',
                  color: '#475569',
                  fontSize: '13px',
                  border: '1px solid #E2E8F0',
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.backgroundColor = '#E2E8F0';
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.backgroundColor = '#F1F5F9';
                }}
              >
                {qr.label}
              </button>
            ))}
          </div>
        </div>
      </motion.div>

      {/* KPI Cards */}
      <motion.div variants={stagger} className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-6">
        <motion.div variants={fadeIn}>
          <KPICard
            title={t(language, 'kpi.totalSales')}
            value={formatSales(kpis.totalSales, currency, exchangeRate, language)}
            subtitle={`${kpis.dayCount}${language === 'ko' ? '일간' : '日間'}`}
          />
        </motion.div>
        <motion.div variants={fadeIn}>
          <KPICard
            title={language === 'ko' ? '일 평균 매출' : '日平均売上'}
            value={formatSales(Math.round(kpis.dailyAvg), currency, exchangeRate, language)}
          />
        </motion.div>
        <motion.div variants={fadeIn}>
          <KPICard
            title={t(language, 'period.vsPrevious')}
            value={formatPercent(kpis.change)}
            change={kpis.change}
            subtitle={formatSales(kpis.prevTotal, currency, exchangeRate, language)}
          />
        </motion.div>
      </motion.div>

      {/* Time granularity toggle */}
      <motion.div variants={fadeIn} className="flex items-center gap-1.5 mb-6">
        <div
          className="inline-flex rounded-xl p-1"
          style={{ backgroundColor: '#F1F5F9', border: '1px solid #E2E8F0' }}
        >
          {granularityOptions.map(opt => (
            <button
              key={opt.key}
              onClick={() => setGranularity(opt.key)}
              className="px-5 py-2.5 rounded-lg font-semibold transition-all duration-200"
              style={{
                backgroundColor: granularity === opt.key ? '#2563EB' : 'transparent',
                color: granularity === opt.key ? '#ffffff' : '#64748B',
                fontSize: '14px',
                boxShadow: granularity === opt.key ? '0 2px 8px rgba(37,99,235,0.3)' : 'none',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </motion.div>

      {/* Sales chart by granularity */}
      <motion.div
        variants={fadeIn}
        className="rounded-2xl p-6 mb-6"
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E2E8F0',
          boxShadow: '0 1px 3px 0 rgba(0,0,0,0.05)',
        }}
      >
        <h3 className="font-bold mb-5" style={{ color: '#0F1B4C', fontSize: '18px' }}>
          {t(language, 'chart.dailySales')}
        </h3>
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
      </motion.div>

      {/* Period comparison chart */}
      <motion.div
        variants={fadeIn}
        className="rounded-2xl p-6"
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E2E8F0',
          boxShadow: '0 1px 3px 0 rgba(0,0,0,0.05)',
        }}
      >
        <h3 className="font-bold mb-5" style={{ color: '#0F1B4C', fontSize: '18px' }}>
          {t(language, 'period.vsPrevious')}
        </h3>
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
      </motion.div>
    </motion.div>
  );
}
