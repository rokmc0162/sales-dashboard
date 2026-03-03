import { useMemo } from 'react';
import { motion } from 'framer-motion';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
  BarChart, Bar,
} from 'recharts';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useAppState } from '@/hooks/useAppState';
import { t } from '@/i18n';
import { formatSales, formatMonth } from '@/utils/formatters';
import { calcMoMChange } from '@/utils/calculations';
import { KPICard } from '@/components/charts/KPICard';
import { DollarSign, CalendarDays, TrendingUp, BookOpen } from 'lucide-react';
import { getPlatformColor } from '@/utils/platformConfig';
import { PlatformIcon } from '@/components/PlatformIcon';
import { Card, CardContent } from '@/components/ui/card';
import { ChartCard } from '@/components/ui/chart-card';
import { Skeleton } from '@/components/ui/skeleton';
import { DashboardGrid } from '@/components/layout/DashboardGrid';
import { staggerContainer, staggerItem, chartReveal } from '@/lib/constants';
import { AIPlatformMonitor } from '@/components/AIPlatformMonitor';

// ---------------------------------------------------------------------------
// Custom Tooltip Components
// ---------------------------------------------------------------------------

interface AreaTooltipPayload {
  value: number;
  dataKey: string;
  payload: { month: string; totalSales: number };
}

function AreaChartTooltip({
  active, payload, label, formatter,
}: { active?: boolean; payload?: AreaTooltipPayload[]; label?: string; formatter: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="glass-card-strong rounded-xl px-5 py-3">
      <p className="text-sm font-semibold mb-1 text-text-secondary">{label}</p>
      <p className="text-base font-bold text-text-primary">{formatter(payload[0].value)}</p>
    </div>
  );
}

interface PieTooltipPayload {
  name: string;
  value: number;
  payload: { platform: string; sales: number; percent: number };
}

function PieChartTooltip({
  active, payload, formatter,
}: { active?: boolean; payload?: PieTooltipPayload[]; formatter: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  return (
    <div className="glass-card-strong rounded-xl px-5 py-3">
      <p className="text-sm font-semibold mb-1 text-text-secondary">{entry.name}</p>
      <p className="text-base font-bold text-text-primary">{formatter(entry.value)}</p>
      <p className="text-sm mt-0.5 text-muted-foreground">{entry.payload.percent.toFixed(1)}%</p>
    </div>
  );
}

interface BarTooltipPayload {
  value: number;
  dataKey: string;
  payload: { name: string; fullName: string; sales: number };
}

function BarChartTooltip({
  active, payload, formatter,
}: { active?: boolean; payload?: BarTooltipPayload[]; formatter: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  return (
    <div className="glass-card-strong rounded-xl px-5 py-3 max-w-80">
      <p className="text-sm font-semibold mb-1 break-words text-text-secondary">{entry.payload.fullName}</p>
      <p className="text-base font-bold text-text-primary">{formatter(entry.value)}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton Loader
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-5 w-48" />
      </div>
      <DashboardGrid cols={4}>
        {[...Array(4)].map((_, i) => (
          <Card key={i} variant="glass">
            <CardContent className="p-6 space-y-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-36" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-8 w-full" />
            </CardContent>
          </Card>
        ))}
      </DashboardGrid>
      <Card variant="glass">
        <CardContent className="p-6">
          <Skeleton className="h-5 w-40 mb-5" />
          <Skeleton className="h-80 w-full rounded-xl" />
        </CardContent>
      </Card>
      <DashboardGrid cols={2}>
        {[...Array(2)].map((_, i) => (
          <Card key={i} variant="glass">
            <CardContent className="p-6">
              <Skeleton className="h-5 w-40 mb-5" />
              <Skeleton className="h-72 w-full rounded-xl" />
            </CardContent>
          </Card>
        ))}
      </DashboardGrid>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function ExecutiveSummary() {
  const data = useDataLoader();
  const { language, currency, exchangeRate } = useAppState();
  const fmt = (value: number) => formatSales(value, currency, exchangeRate, language);

  const {
    totalSales, currentMonthSales, currentMonthLabel, momChange,
    activeTitleCount, sparklineData, monthlyChartData, platformChartData, topTitlesData,
  } = useMemo(() => {
    const monthly = [...data.monthlySummary].sort((a, b) => a.month.localeCompare(b.month));
    const totalSales = monthly.reduce((sum, m) => sum + m.totalSales, 0);
    const currentMonthSales = monthly.length > 0 ? monthly[monthly.length - 1].totalSales : 0;

    let currentMonthLabel = t(language, 'kpi.currentMonth');
    if (monthly.length > 0) {
      const monthNum = parseInt(monthly[monthly.length - 1].month.split('-')[1]);
      currentMonthLabel = language === 'ko' ? `${monthNum}월 매출` : `${monthNum}月売上`;
    }

    const momChange = calcMoMChange(monthly);
    const activeTitleCount = data.titleSummary.length;
    const sparklineData = monthly.map((m) => m.totalSales);

    const monthlyChartData = monthly.map((m) => ({
      month: formatMonth(m.month, language),
      totalSales: m.totalSales,
    }));

    const platformTotal = data.platformSummary.reduce((sum, p) => sum + p.totalSales, 0);
    const platformChartData = data.platformSummary
      .map((p) => ({
        platform: p.platform,
        sales: p.totalSales,
        percent: platformTotal > 0 ? (p.totalSales / platformTotal) * 100 : 0,
      }))
      .sort((a, b) => b.sales - a.sales);

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
      totalSales, currentMonthSales, currentMonthLabel, momChange,
      activeTitleCount, sparklineData, monthlyChartData, platformChartData, topTitlesData,
    };
  }, [data.monthlySummary, data.platformSummary, data.titleSummary, language]);

  // Loading
  if (data.loading) return <LoadingSkeleton />;

  // Error
  if (data.error) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <Card variant="default" className="p-8 text-center max-w-md border-danger-light">
          <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 bg-danger-light">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <p className="text-lg font-semibold mb-1 text-primary">
            {language === 'ko' ? '데이터 로딩 실패' : 'データ読み込みエラー'}
          </p>
          <p className="text-sm text-muted-foreground">{data.error}</p>
        </Card>
      </div>
    );
  }

  // Render
  return (
    <motion.div className="space-y-8" variants={staggerContainer} initial="hidden" animate="show">
      {/* Page Title */}
      <motion.div variants={staggerItem}>
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-primary">
          {t(language, 'nav.summary')}
        </h1>
        <p className="text-base mt-1 text-muted-foreground">
          {language === 'ko'
            ? '매출 핵심 지표와 트렌드를 한눈에 확인하세요'
            : '売上の主要指標とトレンドを一覧で確認'}
        </p>
      </motion.div>

      {/* AI Platform Monitor */}
      <motion.div variants={staggerItem}>
        <AIPlatformMonitor
          platformSummary={data.platformSummary}
          titleSummary={data.titleSummary}
          language={language}
        />
      </motion.div>

      {/* KPI Cards */}
      <motion.div variants={staggerContainer} initial="hidden" animate="show">
        <DashboardGrid cols={4}>
          <motion.div variants={staggerItem}>
            <KPICard
              title={t(language, 'kpi.totalSales')}
              value={fmt(totalSales)}
              sparkline={sparklineData}
              icon={<DollarSign size={20} />}
            />
          </motion.div>
          <motion.div variants={staggerItem}>
            <KPICard
              title={currentMonthLabel}
              value={fmt(currentMonthSales)}
              change={momChange}
              subtitle={t(language, 'kpi.momChange')}
              sparkline={sparklineData.slice(-6)}
              icon={<CalendarDays size={20} />}
            />
          </motion.div>
          <motion.div variants={staggerItem}>
            <KPICard
              title={t(language, 'kpi.momChange')}
              value={`${momChange >= 0 ? '+' : ''}${momChange.toFixed(1)}%`}
              change={momChange}
              icon={<TrendingUp size={20} />}
            />
          </motion.div>
          <motion.div variants={staggerItem}>
            <KPICard
              title={t(language, 'kpi.activeTitles')}
              value={activeTitleCount.toString()}
              icon={<BookOpen size={20} />}
            />
          </motion.div>
        </DashboardGrid>
      </motion.div>

      {/* Monthly Sales Trend */}
      <motion.div variants={chartReveal} initial="hidden" animate="visible">
        <ChartCard title={t(language, 'chart.monthlySales')} variant="glass">
          <div className="h-[280px] md:h-[380px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={monthlyChartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="salesGradientWhite" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2563EB" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="#2563EB" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: '#64748B', fontSize: 13 }} axisLine={{ stroke: '#E2E8F0' }} tickLine={false} />
                <YAxis tick={{ fill: '#64748B', fontSize: 13 }} axisLine={false} tickLine={false} tickFormatter={(v: number) => fmt(v)} width={95} />
                <Tooltip content={<AreaChartTooltip formatter={fmt} />} />
                <Area type="monotone" dataKey="totalSales" stroke="#2563EB" strokeWidth={3} fill="url(#salesGradientWhite)" dot={false}
                  activeDot={{ r: 6, fill: '#2563EB', stroke: '#ffffff', strokeWidth: 3 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </ChartCard>
      </motion.div>

      {/* Two charts side by side */}
      <DashboardGrid cols={2}>
        {/* Platform Sales Share */}
        <motion.div variants={chartReveal} initial="hidden" animate="visible">
          <ChartCard title={t(language, 'chart.platformShare')} variant="glass">
            <div className="w-full" style={{ height: 360 }}>
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie data={platformChartData} cx="50%" cy="50%" innerRadius={70} outerRadius={110}
                    dataKey="sales" nameKey="platform" paddingAngle={3}>
                    {platformChartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={getPlatformColor(entry.platform)} stroke="#ffffff" strokeWidth={2} />
                    ))}
                  </Pie>
                  <Tooltip content={<PieChartTooltip formatter={fmt} />} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 mt-3 px-2">
                {platformChartData.map((entry) => (
                  <div key={entry.platform} className="flex items-center gap-1.5">
                    <PlatformIcon name={entry.platform} size={18} />
                    <span className="text-text-secondary text-xs font-medium">{entry.platform}</span>
                    <span className="text-text-muted text-xs">{entry.percent.toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>
          </ChartCard>
        </motion.div>

        {/* Top 5 Titles */}
        <motion.div variants={chartReveal} initial="hidden" animate="visible">
          <ChartCard title={t(language, 'chart.topTitles')} variant="glass">
            <div className="w-full" style={{ height: 360 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={topTitlesData} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                  <defs>
                    <linearGradient id="barGradient" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#2563EB" />
                      <stop offset="100%" stopColor="#7C3AED" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" horizontal={false} />
                  <XAxis type="number" tick={{ fill: '#64748B', fontSize: 13 }} axisLine={{ stroke: '#E2E8F0' }}
                    tickLine={false} tickFormatter={(v: number) => fmt(v)} />
                  <YAxis type="category" dataKey="name" tick={{ fill: '#334155', fontSize: 13, fontWeight: 500 }}
                    axisLine={false} tickLine={false} width={160} />
                  <Tooltip content={<BarChartTooltip formatter={fmt} />} cursor={false} />
                  <Bar dataKey="sales" fill="url(#barGradient)" radius={[0, 8, 8, 0]} barSize={32}
                    activeBar={{ fillOpacity: 0.85, stroke: '#6366F1', strokeWidth: 1.5 }} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </ChartCard>
        </motion.div>
      </DashboardGrid>
    </motion.div>
  );
}
