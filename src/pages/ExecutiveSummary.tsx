import { useMemo } from 'react';
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

const CHART_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];

// ---------------------------------------------------------------------------
// Custom Tooltip Components
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
      className="rounded-lg px-4 py-3 shadow-xl"
      style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
    >
      <p className="text-xs font-medium mb-1" style={{ color: '#94a3b8' }}>
        {label}
      </p>
      <p className="text-sm font-bold" style={{ color: '#f8fafc' }}>
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
      className="rounded-lg px-4 py-3 shadow-xl"
      style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
    >
      <p className="text-xs font-medium mb-1" style={{ color: '#94a3b8' }}>
        {entry.name}
      </p>
      <p className="text-sm font-bold" style={{ color: '#f8fafc' }}>
        {formatter(entry.value)}
      </p>
      <p className="text-xs mt-0.5" style={{ color: '#64748b' }}>
        {entry.payload.percent.toFixed(1)}%
      </p>
    </div>
  );
}

interface BarTooltipPayload {
  value: number;
  dataKey: string;
  payload: { name: string; sales: number };
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
      className="rounded-lg px-4 py-3 shadow-xl"
      style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
    >
      <p className="text-xs font-medium mb-1" style={{ color: '#94a3b8' }}>
        {entry.payload.name}
      </p>
      <p className="text-sm font-bold" style={{ color: '#f8fafc' }}>
        {formatter(entry.value)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart Card Wrapper
// ---------------------------------------------------------------------------

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl p-6"
      style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
    >
      <h3 className="text-sm font-semibold mb-4 uppercase tracking-wider" style={{ color: '#94a3b8' }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading Spinner
// ---------------------------------------------------------------------------

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center" style={{ minHeight: '60vh' }}>
      <div className="flex flex-col items-center gap-4">
        <div
          className="w-10 h-10 rounded-full animate-spin"
          style={{
            border: '3px solid #334155',
            borderTopColor: '#3b82f6',
          }}
        />
        <span className="text-sm" style={{ color: '#94a3b8' }}>Loading...</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom Pie Label
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
  const radius = outerRadius + 24;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);

  return (
    <text
      x={x}
      y={y}
      fill="#94a3b8"
      textAnchor={x > cx ? 'start' : 'end'}
      dominantBaseline="central"
      fontSize={11}
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

    // Current month (last entry)
    const currentMonthSales = monthly.length > 0 ? monthly[monthly.length - 1].totalSales : 0;

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
      .map((title) => ({
        name: language === 'ko' ? title.titleKR : title.titleJP,
        sales: title.totalSales,
      }));

    return {
      totalSales,
      currentMonthSales,
      momChange,
      activeTitleCount,
      sparklineData,
      monthlyChartData,
      platformChartData,
      topTitlesData,
    };
  }, [data.monthlySummary, data.platformSummary, data.titleSummary, language]);

  if (data.loading) {
    return <LoadingSpinner />;
  }

  if (data.error) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: '40vh' }}>
        <p className="text-sm" style={{ color: '#ef4444' }}>Error: {data.error}</p>
      </div>
    );
  }

  // Truncate long title names for the bar chart
  const truncate = (str: string, max: number) =>
    str.length > max ? str.slice(0, max) + '...' : str;

  return (
    <div className="space-y-6">
      {/* Page Title */}
      <h1 className="text-2xl font-bold" style={{ color: '#f8fafc' }}>
        {t(language, 'nav.summary')}
      </h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          title={t(language, 'kpi.totalSales')}
          value={fmt(totalSales)}
          sparkline={sparklineData}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          }
        />
        <KPICard
          title={t(language, 'kpi.currentMonth')}
          value={fmt(currentMonthSales)}
          change={momChange}
          subtitle={t(language, 'kpi.momChange')}
          sparkline={sparklineData.slice(-6)}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
              <line x1="16" y1="2" x2="16" y2="6" />
              <line x1="8" y1="2" x2="8" y2="6" />
              <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
          }
        />
        <KPICard
          title={t(language, 'kpi.momChange')}
          value={`${momChange >= 0 ? '+' : ''}${momChange.toFixed(1)}%`}
          change={momChange}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
              <polyline points="16 7 22 7 22 13" />
            </svg>
          }
        />
        <KPICard
          title={t(language, 'kpi.activeTitles')}
          value={activeTitleCount.toString()}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
          }
        />
      </div>

      {/* Monthly Sales Trend - AreaChart */}
      <ChartCard title={t(language, 'chart.monthlySales')}>
        <div style={{ width: '100%', height: 350 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={monthlyChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="salesGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
              <XAxis
                dataKey="month"
                tick={{ fill: '#94a3b8', fontSize: 11 }}
                axisLine={{ stroke: '#334155' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fill: '#94a3b8', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => fmt(v)}
                width={90}
              />
              <Tooltip content={<AreaChartTooltip formatter={fmt} />} />
              <Area
                type="monotone"
                dataKey="totalSales"
                stroke="#3b82f6"
                strokeWidth={2.5}
                fill="url(#salesGradient)"
                dot={false}
                activeDot={{ r: 5, fill: '#3b82f6', stroke: '#0f172a', strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      {/* Two charts side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Platform Sales Share - Donut Chart */}
        <ChartCard title={t(language, 'chart.platformShare')}>
          <div style={{ width: '100%', height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={platformChartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={65}
                  outerRadius={105}
                  dataKey="sales"
                  nameKey="platform"
                  paddingAngle={2}
                  label={renderPieLabel}
                  labelLine={{ stroke: '#475569', strokeWidth: 1 }}
                >
                  {platformChartData.map((_, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={CHART_COLORS[index % CHART_COLORS.length]}
                      stroke="transparent"
                    />
                  ))}
                </Pie>
                <Tooltip content={<PieChartTooltip formatter={fmt} />} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>

        {/* Top 5 Titles - Horizontal Bar Chart */}
        <ChartCard title={t(language, 'chart.topTitles')}>
          <div style={{ width: '100%', height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={topTitlesData.map((d) => ({ ...d, name: truncate(d.name, 18) }))}
                layout="vertical"
                margin={{ top: 5, right: 20, left: 10, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                  axisLine={{ stroke: '#334155' }}
                  tickLine={false}
                  tickFormatter={(v: number) => fmt(v)}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={140}
                />
                <Tooltip content={<BarChartTooltip formatter={fmt} />} />
                <Bar
                  dataKey="sales"
                  fill="#3b82f6"
                  radius={[0, 6, 6, 0]}
                  barSize={28}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </div>
    </div>
  );
}
