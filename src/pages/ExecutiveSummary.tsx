import { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
} from 'recharts';
import { useDataLoader } from '../hooks/useDataLoader';
import { useAppState } from '../hooks/useAppState';
import { t } from '../i18n';
import { formatSales, formatMonth } from '../utils/formatters';
import { calcMoMChange } from '../utils/calculations';
import { KPICard } from '../components/charts/KPICard';
import { DollarSign, CalendarDays, TrendingUp, BookOpen } from 'lucide-react';

// ---------------------------------------------------------------------------
// Design Tokens - Premium White Theme with Navy Accents
// ---------------------------------------------------------------------------

const CHART_COLORS = [
  '#2563EB', '#7C3AED', '#0891B2', '#16A34A', '#D97706',
  '#DC2626', '#DB2777', '#0D9488', '#4F46E5', '#EA580C',
];

const tooltipStyle = {
  contentStyle: {
    backgroundColor: '#ffffff',
    border: '1px solid #E2E8F0',
    borderRadius: '12px',
    boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)',
  },
  labelStyle: { color: '#475569', fontWeight: 600 },
  itemStyle: { color: '#0F172A' },
};

// ---------------------------------------------------------------------------
// Animation Variants
// ---------------------------------------------------------------------------

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1 } },
};

const item = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: 'easeOut' as const } },
};

const chartReveal = {
  hidden: { opacity: 0, y: 30 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: 'easeOut' as const } },
};

// ---------------------------------------------------------------------------
// Custom Tooltip Components (White Theme)
// ---------------------------------------------------------------------------

interface AreaTooltipPayload {
  value: number;
  dataKey: string;
  payload: { month: string; totalSales: number };
}

function AreaChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: AreaTooltipPayload[];
  label?: string;
  formatter: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-xl px-5 py-3"
      style={{
        ...tooltipStyle.contentStyle,
      }}
    >
      <p className="text-sm font-semibold mb-1" style={tooltipStyle.labelStyle}>
        {label}
      </p>
      <p className="text-base font-bold" style={tooltipStyle.itemStyle}>
        {formatter(payload[0].value)}
      </p>
    </div>
  );
}

interface PieTooltipPayload {
  name: string;
  value: number;
  payload: { platform: string; sales: number; percent: number };
}

function PieChartTooltip({
  active,
  payload,
  formatter,
}: {
  active?: boolean;
  payload?: PieTooltipPayload[];
  formatter: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  return (
    <div
      className="rounded-xl px-5 py-3"
      style={{
        ...tooltipStyle.contentStyle,
      }}
    >
      <p className="text-sm font-semibold mb-1" style={tooltipStyle.labelStyle}>
        {entry.name}
      </p>
      <p className="text-base font-bold" style={tooltipStyle.itemStyle}>
        {formatter(entry.value)}
      </p>
      <p className="text-sm mt-0.5" style={{ color: '#64748B' }}>
        {entry.payload.percent.toFixed(1)}%
      </p>
    </div>
  );
}

interface BarTooltipPayload {
  value: number;
  dataKey: string;
  payload: { name: string; fullName: string; sales: number };
}

function BarChartTooltip({
  active,
  payload,
  formatter,
}: {
  active?: boolean;
  payload?: BarTooltipPayload[];
  formatter: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  return (
    <div
      className="rounded-xl px-5 py-3"
      style={{
        ...tooltipStyle.contentStyle,
        maxWidth: 320,
      }}
    >
      <p className="text-sm font-semibold mb-1 break-words" style={tooltipStyle.labelStyle}>
        {entry.payload.fullName}
      </p>
      <p className="text-base font-bold" style={tooltipStyle.itemStyle}>
        {formatter(entry.value)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart Card Wrapper (White Theme)
// ---------------------------------------------------------------------------

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
      <h3
        className="text-base font-bold mb-5 uppercase tracking-wider"
        style={{ color: '#0F1B4C' }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton Loader (Shimmer Animation)
// ---------------------------------------------------------------------------

function SkeletonPulse({ className }: { className?: string }) {
  return (
    <div
      className={`rounded-xl animate-pulse ${className ?? ''}`}
      style={{ backgroundColor: '#F1F5F9' }}
    />
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      {/* Header skeleton */}
      <div className="space-y-2">
        <SkeletonPulse className="h-10 w-64" />
        <SkeletonPulse className="h-5 w-48" />
      </div>

      {/* KPI card skeletons */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
            <SkeletonPulse className="h-4 w-24 mb-4" />
            <SkeletonPulse className="h-8 w-36 mb-3" />
            <SkeletonPulse className="h-4 w-20 mb-4" />
            <SkeletonPulse className="h-8 w-full" />
          </div>
        ))}
      </div>

      {/* Chart skeletons */}
      <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
        <SkeletonPulse className="h-5 w-40 mb-5" />
        <SkeletonPulse className="h-80 w-full" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
          <SkeletonPulse className="h-5 w-40 mb-5" />
          <SkeletonPulse className="h-72 w-full" />
        </div>
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-slate-100">
          <SkeletonPulse className="h-5 w-40 mb-5" />
          <SkeletonPulse className="h-72 w-full" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom Pie Label (Readable for presbyopia)
// ---------------------------------------------------------------------------

function renderPieLabel({
  cx,
  cy,
  midAngle,
  outerRadius,
  percent,
  name,
}: // eslint-disable-next-line @typescript-eslint/no-explicit-any
any) {
  if (percent < 0.03) return null;
  const RADIAN = Math.PI / 180;
  const radius = outerRadius + 28;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);

  return (
    <text
      x={x}
      y={y}
      fill="#334155"
      textAnchor={x > cx ? 'start' : 'end'}
      dominantBaseline="central"
      fontSize={13}
      fontWeight={500}
    >
      {name} {(percent * 100).toFixed(1)}%
    </text>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function ExecutiveSummary() {
  const data = useDataLoader();
  const { language, currency, exchangeRate } = useAppState();

  const fmt = (value: number) => formatSales(value, currency, exchangeRate, language);

  // Compute derived data
  const {
    totalSales,
    currentMonthSales,
    currentMonthLabel,
    momChange,
    activeTitleCount,
    sparklineData,
    monthlyChartData,
    platformChartData,
    topTitlesData,
  } = useMemo(() => {
    const monthly = [...data.monthlySummary].sort((a, b) => a.month.localeCompare(b.month));

    // Total cumulative sales
    const totalSales = monthly.reduce((sum, m) => sum + m.totalSales, 0);

    // Current month (last entry) and label fix
    const currentMonthSales = monthly.length > 0 ? monthly[monthly.length - 1].totalSales : 0;

    // Build actual month label instead of generic "this month"
    let currentMonthLabel = t(language, 'kpi.currentMonth');
    if (monthly.length > 0) {
      const lastMonth = monthly[monthly.length - 1];
      const monthNum = parseInt(lastMonth.month.split('-')[1]);
      currentMonthLabel = language === 'ko' ? `${monthNum}월 매출` : `${monthNum}月売上`;
    }

    // MoM change
    const momChange = calcMoMChange(monthly);

    // Active titles: count unique titles from titleSummary
    const activeTitleCount = data.titleSummary.length;

    // Sparkline: monthly totalSales values
    const sparklineData = monthly.map((m) => m.totalSales);

    // Monthly chart data for AreaChart
    const monthlyChartData = monthly.map((m) => ({
      month: formatMonth(m.month, language),
      totalSales: m.totalSales,
    }));

    // Platform chart data from platformSummary
    const platformTotal = data.platformSummary.reduce((sum, p) => sum + p.totalSales, 0);
    const platformChartData = data.platformSummary
      .map((p) => ({
        platform: p.platform,
        sales: p.totalSales,
        percent: platformTotal > 0 ? (p.totalSales / platformTotal) * 100 : 0,
      }))
      .sort((a, b) => b.sales - a.sales);

    // Top 5 titles by total revenue
    const topTitlesData = [...data.titleSummary]
      .sort((a, b) => b.totalSales - a.totalSales)
      .slice(0, 5)
      .map((title) => {
        const fullName = language === 'ko' ? title.titleKR : title.titleJP;
        return {
          fullName,
          name: fullName.length > 25 ? fullName.slice(0, 25) + '...' : fullName,
          sales: title.totalSales,
        };
      });

    return {
      totalSales,
      currentMonthSales,
      currentMonthLabel,
      momChange,
      activeTitleCount,
      sparklineData,
      monthlyChartData,
      platformChartData,
      topTitlesData,
    };
  }, [data.monthlySummary, data.platformSummary, data.titleSummary, language]);

  // ---------------------------------------------------------------------------
  // Loading State
  // ---------------------------------------------------------------------------

  if (data.loading) {
    return <LoadingSkeleton />;
  }

  // ---------------------------------------------------------------------------
  // Error State
  // ---------------------------------------------------------------------------

  if (data.error) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: '40vh' }}>
        <div className="bg-white rounded-2xl p-8 shadow-sm border border-red-100 text-center max-w-md">
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ backgroundColor: '#FEF2F2' }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <p className="text-lg font-semibold mb-1" style={{ color: '#0F1B4C' }}>
            {language === 'ko' ? '데이터 로딩 실패' : 'データ読み込みエラー'}
          </p>
          <p className="text-sm" style={{ color: '#64748B' }}>{data.error}</p>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <motion.div
      className="space-y-8"
      variants={container}
      initial="hidden"
      animate="show"
    >
      {/* ----------------------------------------------------------------- */}
      {/* Page Title                                                        */}
      {/* ----------------------------------------------------------------- */}
      <motion.div variants={item}>
        <h1
          className="text-3xl font-extrabold tracking-tight"
          style={{ color: '#0F1B4C' }}
        >
          {t(language, 'nav.summary')}
        </h1>
        <p className="text-base mt-1" style={{ color: '#64748B' }}>
          {language === 'ko'
            ? '매출 핵심 지표와 트렌드를 한눈에 확인하세요'
            : '売上の主要指標とトレンドを一覧で確認'}
        </p>
      </motion.div>

      {/* ----------------------------------------------------------------- */}
      {/* KPI Cards                                                         */}
      {/* ----------------------------------------------------------------- */}
      <motion.div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5"
        variants={container}
        initial="hidden"
        animate="show"
      >
        <motion.div variants={item}>
          <KPICard
            title={t(language, 'kpi.totalSales')}
            value={fmt(totalSales)}
            sparkline={sparklineData}
            icon={<DollarSign size={20} />}
          />
        </motion.div>

        <motion.div variants={item}>
          <KPICard
            title={currentMonthLabel}
            value={fmt(currentMonthSales)}
            change={momChange}
            subtitle={t(language, 'kpi.momChange')}
            sparkline={sparklineData.slice(-6)}
            icon={<CalendarDays size={20} />}
          />
        </motion.div>

        <motion.div variants={item}>
          <KPICard
            title={t(language, 'kpi.momChange')}
            value={`${momChange >= 0 ? '+' : ''}${momChange.toFixed(1)}%`}
            change={momChange}
            icon={<TrendingUp size={20} />}
          />
        </motion.div>

        <motion.div variants={item}>
          <KPICard
            title={t(language, 'kpi.activeTitles')}
            value={activeTitleCount.toString()}
            icon={<BookOpen size={20} />}
          />
        </motion.div>
      </motion.div>

      {/* ----------------------------------------------------------------- */}
      {/* Monthly Sales Trend - AreaChart                                   */}
      {/* ----------------------------------------------------------------- */}
      <motion.div variants={chartReveal}>
        <ChartCard title={t(language, 'chart.monthlySales')}>
          <div style={{ width: '100%', height: 380 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={monthlyChartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="salesGradientWhite" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2563EB" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#2563EB" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ fill: '#64748B', fontSize: 13 }}
                  axisLine={{ stroke: '#E2E8F0' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#64748B', fontSize: 13 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => fmt(v)}
                  width={95}
                />
                <Tooltip content={<AreaChartTooltip formatter={fmt} />} />
                <Area
                  type="monotone"
                  dataKey="totalSales"
                  stroke="#2563EB"
                  strokeWidth={3}
                  fill="url(#salesGradientWhite)"
                  dot={false}
                  activeDot={{
                    r: 6,
                    fill: '#2563EB',
                    stroke: '#ffffff',
                    strokeWidth: 3,
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </motion.div>

      {/* ----------------------------------------------------------------- */}
      {/* Two charts side by side                                           */}
      {/* ----------------------------------------------------------------- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Platform Sales Share - Donut Chart */}
        <motion.div variants={chartReveal}>
          <ChartCard title={t(language, 'chart.platformShare')}>
            <div style={{ width: '100%', height: 360 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={platformChartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={70}
                    outerRadius={110}
                    dataKey="sales"
                    nameKey="platform"
                    paddingAngle={3}
                    label={renderPieLabel}
                    labelLine={{ stroke: '#94A3B8', strokeWidth: 1 }}
                  >
                    {platformChartData.map((_, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={CHART_COLORS[index % CHART_COLORS.length]}
                        stroke="#ffffff"
                        strokeWidth={2}
                      />
                    ))}
                  </Pie>
                  <Tooltip content={<PieChartTooltip formatter={fmt} />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>
        </motion.div>

        {/* Top 5 Titles - Horizontal Bar Chart */}
        <motion.div variants={chartReveal}>
          <ChartCard title={t(language, 'chart.topTitles')}>
            <div style={{ width: '100%', height: 360 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={topTitlesData}
                  layout="vertical"
                  margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
                >
                  <defs>
                    <linearGradient id="barGradient" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#2563EB" />
                      <stop offset="100%" stopColor="#7C3AED" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" horizontal={false} />
                  <XAxis
                    type="number"
                    tick={{ fill: '#64748B', fontSize: 13 }}
                    axisLine={{ stroke: '#E2E8F0' }}
                    tickLine={false}
                    tickFormatter={(v: number) => fmt(v)}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tick={{ fill: '#334155', fontSize: 13, fontWeight: 500 }}
                    axisLine={false}
                    tickLine={false}
                    width={160}
                  />
                  <Tooltip content={<BarChartTooltip formatter={fmt} />} />
                  <Bar
                    dataKey="sales"
                    fill="url(#barGradient)"
                    radius={[0, 8, 8, 0]}
                    barSize={32}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>
        </motion.div>
      </div>
    </motion.div>
  );
}
