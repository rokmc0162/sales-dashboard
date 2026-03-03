import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useAppState } from '@/hooks/useAppState';
import { t } from '@/i18n';
import { formatSales, formatSalesShort } from '@/utils/formatters';
import { calcPlatformMoMChanges } from '@/utils/calculations';
import { KPICard } from '@/components/charts/KPICard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartCard } from '@/components/ui/chart-card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { DashboardGrid } from '@/components/layout/DashboardGrid';
import { PlatformIcon } from '@/components/PlatformIcon';
import { tooltipStyle, staggerContainer, staggerItem } from '@/lib/constants';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area,
} from 'recharts';
import { getPlatformBrand, getPlatformColor } from '@/utils/platformConfig';

/* ------------------------------------------------------------------ */
/*  Loading skeleton                                                    */
/* ------------------------------------------------------------------ */

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-64" />
      {/* Distribution card */}
      <Card variant="glass"><CardContent className="p-6 space-y-4">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-24 w-full rounded-xl" />
      </CardContent></Card>
      {/* MoM table */}
      <Card variant="glass"><CardContent className="p-6">
        <Skeleton className="h-5 w-48 mb-4" /><Skeleton className="h-48 w-full rounded-xl" />
      </CardContent></Card>
      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10 w-28 rounded-full" />)}
      </div>
      <DashboardGrid cols={3}>
        {[...Array(3)].map((_, i) => (
          <Card key={i} variant="glass"><CardContent className="p-6 space-y-3">
            <Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-36" /><Skeleton className="h-4 w-20" />
          </CardContent></Card>
        ))}
      </DashboardGrid>
      {/* Chart */}
      <Card variant="glass"><CardContent className="p-6">
        <Skeleton className="h-5 w-48 mb-4" /><Skeleton className="h-80 w-full rounded-xl" />
      </CardContent></Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Revenue Distribution — replaces HHI gauge                          */
/* ------------------------------------------------------------------ */

function RevenueDistribution({
  platforms,
  language,
  currency,
  exchangeRate,
}: {
  platforms: { platform: string; totalSales: number }[];
  language: 'ko' | 'ja';
  currency: 'JPY' | 'KRW';
  exchangeRate: number;
}) {
  const total = platforms.reduce((s, p) => s + p.totalSales, 0);
  const sorted = [...platforms].sort((a, b) => b.totalSales - a.totalSales);
  const topPlatform = sorted[0];
  const topShare = total > 0 ? (topPlatform.totalSales / total) * 100 : 0;

  // Traffic light: green < 40%, yellow 40-60%, red > 60%
  const status: 'good' | 'caution' | 'warning' =
    topShare < 40 ? 'good' : topShare <= 60 ? 'caution' : 'warning';

  const statusConfig = {
    good:    { color: '#22c55e', bg: '#dcfce7', icon: '✅' },
    caution: { color: '#eab308', bg: '#fef9c3', icon: '⚠️' },
    warning: { color: '#ef4444', bg: '#fee2e2', icon: '🚨' },
  };
  const cfg = statusConfig[status];

  const statusKey = `platform.status${status.charAt(0).toUpperCase() + status.slice(1)}` as
    'platform.statusGood' | 'platform.statusCaution' | 'platform.statusWarning';
  const msgKey = `platform.msg${status.charAt(0).toUpperCase() + status.slice(1)}` as
    'platform.msgGood' | 'platform.msgCaution' | 'platform.msgWarning';

  const statusLabel = t(language, statusKey);
  const message = t(language, msgKey)
    .replace('{share}', topShare.toFixed(1))
    .replace('{platform}', topPlatform?.platform ?? '');

  return (
    <Card variant="glass">
      <CardHeader>
        <CardTitle>{t(language, 'platform.distribution')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Status banner */}
        <div className="flex items-start gap-4">
          <div
            className="flex items-center justify-center w-14 h-14 rounded-2xl text-2xl shrink-0"
            style={{ backgroundColor: cfg.bg }}
          >
            {cfg.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div
              className="text-lg font-bold mb-1"
              style={{ color: cfg.color }}
            >
              {statusLabel}
            </div>
            <p className="text-sm text-text-secondary leading-relaxed">
              {message}
            </p>
          </div>
        </div>

        {/* Horizontal stacked bar */}
        <div className="space-y-2">
          <div className="flex w-full h-10 rounded-xl overflow-hidden">
            {sorted.map((p) => {
              const share = total > 0 ? (p.totalSales / total) * 100 : 0;
              if (share < 1) return null; // skip tiny slices
              return (
                <motion.div
                  key={p.platform}
                  className="h-full flex items-center justify-center text-white text-xs font-semibold overflow-hidden"
                  style={{ backgroundColor: getPlatformColor(p.platform) }}
                  initial={{ width: 0 }}
                  animate={{ width: `${share}%` }}
                  transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
                  title={`${p.platform}: ${share.toFixed(1)}%`}
                >
                  {share >= 8 && `${share.toFixed(0)}%`}
                </motion.div>
              );
            })}
          </div>
          {/* Legend with sales */}
          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            {sorted.map((p) => {
              const share = total > 0 ? (p.totalSales / total) * 100 : 0;
              return (
                <div key={p.platform} className="flex items-center gap-1.5 text-xs">
                  <span
                    className="w-3 h-3 rounded-full shrink-0"
                    style={{ backgroundColor: getPlatformColor(p.platform) }}
                  />
                  <PlatformIcon name={p.platform} size={14} />
                  <span className="font-medium text-foreground">{p.platform}</span>
                  <span className="text-text-muted">
                    {share.toFixed(1)}% · {formatSales(p.totalSales, currency, exchangeRate, language)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  PlatformAnalysis page (unified)                                     */
/* ------------------------------------------------------------------ */

export function PlatformAnalysis() {
  const { language, currency, exchangeRate } = useAppState();
  const data = useDataLoader();

  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);

  const platforms = data.platformSummary;
  const activePlatform = selectedPlatform ?? (platforms.length > 0 ? platforms[0].platform : null);

  // ---- Selected platform data ----
  const selectedPlatformData = useMemo(() => {
    if (!activePlatform) return null;
    return platforms.find((p) => p.platform === activePlatform) ?? null;
  }, [platforms, activePlatform]);

  // Grand total
  const grandTotal = useMemo(() => {
    return platforms.reduce((sum, p) => sum + p.totalSales, 0);
  }, [platforms]);

  // Monthly bar chart data for selected platform
  const selectedMonthlyData = useMemo(() => {
    if (!selectedPlatformData) return [];
    return [...selectedPlatformData.monthlyTrend].sort((a, b) =>
      a.month.localeCompare(b.month),
    );
  }, [selectedPlatformData]);

  // Top 10 titles for selected platform
  const selectedTopTitles = useMemo(() => {
    if (!selectedPlatformData) return [];
    return selectedPlatformData.topTitles.slice(0, 10);
  }, [selectedPlatformData]);

  // ---- MoM changes (from Dynamics) ----
  const momChanges = useMemo(() => {
    return calcPlatformMoMChanges(platforms);
  }, [platforms]);

  // ---- Monthly platform share trend % (from Dynamics) ----
  const monthlyShareData = useMemo(() => {
    if (data.monthlySummary.length === 0) return [];
    const sorted = [...data.monthlySummary].sort((a, b) => a.month.localeCompare(b.month));
    return sorted.map(ms => {
      const row: Record<string, string | number> = { month: ms.month };
      const tot = ms.totalSales;
      for (const pName of Object.keys(ms.platforms)) {
        row[pName] = tot > 0 ? Number(((ms.platforms[pName] / tot) * 100).toFixed(1)) : 0;
      }
      return row;
    });
  }, [data.monthlySummary]);

  const allPlatformNames = useMemo(() => {
    const nameSet = new Set<string>();
    data.monthlySummary.forEach(ms => {
      Object.keys(ms.platforms).forEach(n => nameSet.add(n));
    });
    return Array.from(nameSet);
  }, [data.monthlySummary]);

  // ---- Loading ----
  if (data.loading) {
    return (
      <div>
        <h1 className="text-2xl md:text-3xl font-bold mb-6 text-primary">
          {t(language, 'nav.platforms')}
        </h1>
        <LoadingSkeleton />
      </div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={staggerContainer}
    >
      {/* Page Title */}
      <motion.h1
        variants={staggerItem}
        className="text-2xl md:text-3xl font-bold mb-6 text-primary tracking-tight"
      >
        {t(language, 'nav.platforms')}
      </motion.h1>

      {/* ============================================================ */}
      {/*  Section 1: Revenue Distribution (replaces HHI)               */}
      {/* ============================================================ */}
      <motion.div variants={staggerItem} className="mb-6">
        <RevenueDistribution
          platforms={platforms.map(p => ({ platform: p.platform, totalSales: p.totalSales }))}
          language={language}
          currency={currency}
          exchangeRate={exchangeRate}
        />
      </motion.div>

      {/* ============================================================ */}
      {/*  Section 2: MoM Changes Table                                 */}
      {/* ============================================================ */}
      <motion.div variants={staggerItem} className="mb-6">
        <Card variant="glass">
          <CardHeader>
            <CardTitle>{t(language, 'platform.momChanges')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted hover:bg-muted">
                  <TableHead className="font-semibold">
                    {t(language, 'table.platform')}
                  </TableHead>
                  <TableHead className="text-right font-semibold">
                    {t(language, 'dynamics.currentMonth')}
                  </TableHead>
                  <TableHead className="text-right font-semibold">
                    {t(language, 'dynamics.previousMonth')}
                  </TableHead>
                  <TableHead className="text-right font-semibold">
                    {t(language, 'dynamics.changePercent')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {momChanges.map((row, idx) => {
                  const isUp = row.changePercent > 0;
                  const isDown = row.changePercent < 0;
                  const badgeVariant = isUp ? 'success' as const : isDown ? 'destructive' as const : 'secondary' as const;

                  return (
                    <TableRow
                      key={row.platform}
                      className={idx % 2 === 1 ? 'bg-background' : 'bg-card'}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <PlatformIcon name={row.platform} size={22} />
                          <span className="font-semibold text-[15px] text-foreground">{row.platform}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold text-foreground">
                        {formatSales(row.currentSales, currency, exchangeRate, language)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-text-secondary">
                        {formatSales(row.previousSales, currency, exchangeRate, language)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Badge variant={badgeVariant}>
                          {isUp ? '+' : ''}{row.changePercent.toFixed(1)}%
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {momChanges.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="p-8 text-center text-[15px] text-text-muted">
                      {language === 'ko' ? '데이터가 없습니다.' : 'データがありません。'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </motion.div>

      {/* ============================================================ */}
      {/*  Section 3: Platform Detail (tabs)                            */}
      {/* ============================================================ */}
      <motion.div variants={staggerItem} className="mb-2">
        <h2 className="text-lg font-semibold text-foreground mb-4">
          {t(language, 'platform.detail')}
        </h2>
      </motion.div>

      {/* Platform Tabs */}
      <motion.div variants={staggerItem} className="flex flex-wrap gap-2 mb-6">
        {platforms.map((p) => {
          const isActive = p.platform === activePlatform;
          return (
            <motion.button
              key={p.platform}
              onClick={() => setSelectedPlatform(p.platform)}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.97 }}
              className="flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium transition-all duration-200 cursor-pointer"
              style={{
                backgroundColor: isActive ? getPlatformBrand(p.platform).color : '#F1F5F9',
                color: isActive ? '#ffffff' : '#475569',
                border: isActive ? 'none' : `1px solid ${getPlatformBrand(p.platform).borderColor}`,
                boxShadow: isActive ? `0 2px 8px ${getPlatformBrand(p.platform).color}40` : 'none',
              }}
            >
              {!isActive && <PlatformIcon name={p.platform} size={20} />}
              {p.platform}
            </motion.button>
          );
        })}
      </motion.div>

      {/* Selected Platform View */}
      {selectedPlatformData && (
        <motion.div
          key={selectedPlatformData.platform}
          initial="hidden"
          animate="show"
          variants={staggerContainer}
          className="space-y-6"
        >
          {/* KPI Cards */}
          <motion.div variants={staggerItem}>
            <DashboardGrid cols={3}>
              <KPICard
                title={t(language, 'kpi.totalSales')}
                value={formatSales(selectedPlatformData.totalSales, currency, exchangeRate, language)}
                subtitle={selectedPlatformData.platform}
              />
              <KPICard
                title={language === 'ko' ? '작품 수' : '作品数'}
                value={String(selectedPlatformData.titleCount)}
                subtitle={language === 'ko' ? '등록된 작품' : '登録作品'}
              />
              <KPICard
                title={language === 'ko' ? '매출 비중' : '売上シェア'}
                value={grandTotal > 0
                  ? `${((selectedPlatformData.totalSales / grandTotal) * 100).toFixed(1)}%`
                  : '0%'
                }
                subtitle={language === 'ko' ? '전체 대비' : '全体比'}
              />
            </DashboardGrid>
          </motion.div>

          {/* Monthly Sales Bar Chart */}
          <motion.div variants={staggerItem}>
            <ChartCard
              title={`${t(language, 'chart.monthlySales')} - ${selectedPlatformData.platform}`}
              variant="glass"
            >
              <ResponsiveContainer width="100%" height={320}>
                <BarChart data={selectedMonthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                  <XAxis
                    dataKey="month"
                    stroke="#CBD5E1"
                    tick={{ fill: '#64748B', fontSize: 12 }}
                    tickFormatter={(val: string) => val.substring(2).replace('-', '/')}
                  />
                  <YAxis
                    stroke="#CBD5E1"
                    tick={{ fill: '#64748B', fontSize: 12 }}
                    tickFormatter={(val: number) => formatSalesShort(val)}
                  />
                  <Tooltip
                    {...tooltipStyle}
                    formatter={((value: number) => [
                      formatSales(value, currency, exchangeRate, language),
                      t(language, 'table.sales'),
                    ]) as never}
                  />
                  <Bar
                    dataKey="sales"
                    fill={getPlatformColor(activePlatform || '')}
                    radius={[6, 6, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </motion.div>

          {/* Top 10 Titles Table */}
          <motion.div variants={staggerItem}>
            <Card variant="glass">
              <CardContent className="p-6">
                <h3 className="text-base font-semibold mb-4 text-primary">
                  {t(language, 'chart.topTitles')} - {selectedPlatformData.platform}
                </h3>
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted hover:bg-muted">
                      <TableHead className="font-semibold">
                        {t(language, 'table.rank')}
                      </TableHead>
                      <TableHead className="font-semibold">
                        {t(language, 'table.title')}
                      </TableHead>
                      <TableHead className="text-right font-semibold">
                        {t(language, 'table.sales')}
                      </TableHead>
                      <TableHead className="text-right font-semibold">
                        {language === 'ko' ? '비중' : 'シェア'}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedTopTitles.map((title, idx) => (
                      <TableRow
                        key={`${title.titleKR}-${idx}`}
                        className={idx % 2 === 1 ? 'bg-background' : 'bg-card'}
                      >
                        <TableCell className="font-mono text-sm text-text-muted">
                          {idx + 1}
                        </TableCell>
                        <TableCell className="font-semibold text-[15px] text-foreground">
                          {language === 'ko' ? title.titleKR : title.titleJP}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm font-semibold text-foreground">
                          {formatSales(title.sales, currency, exchangeRate, language)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm text-text-secondary">
                          {selectedPlatformData.totalSales > 0
                            ? `${((title.sales / selectedPlatformData.totalSales) * 100).toFixed(1)}%`
                            : '0%'
                          }
                        </TableCell>
                      </TableRow>
                    ))}
                    {selectedTopTitles.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="p-8 text-center text-[15px] text-text-muted">
                          {language === 'ko' ? '데이터가 없습니다.' : 'データがありません。'}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </motion.div>
        </motion.div>
      )}

      {/* ============================================================ */}
      {/*  Section 4: Platform Share Trend (% stacked area)             */}
      {/* ============================================================ */}
      <motion.div variants={staggerItem} className="mt-6">
        <ChartCard
          title={t(language, 'platform.shareTrend')}
          subtitle={t(language, 'platform.shareTrendDesc')}
          variant="glass"
        >
          <ResponsiveContainer width="100%" height={400}>
            <AreaChart data={monthlyShareData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis
                dataKey="month"
                stroke="#CBD5E1"
                tick={{ fill: '#64748B', fontSize: 12 }}
                tickFormatter={(val: string) => val.substring(2).replace('-', '/')}
              />
              <YAxis
                stroke="#CBD5E1"
                tick={{ fill: '#64748B', fontSize: 12 }}
                tickFormatter={(val: number) => `${val}%`}
                domain={[0, 100]}
              />
              <Tooltip
                {...tooltipStyle}
                formatter={((value: number) => [
                  `${Number(value).toFixed(1)}%`,
                  '',
                ]) as never}
              />
              {allPlatformNames.map((pName) => (
                <Area
                  key={pName}
                  type="monotone"
                  dataKey={pName}
                  stackId="share"
                  stroke={getPlatformColor(pName)}
                  fill={getPlatformColor(pName)}
                  fillOpacity={0.6}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
          {/* Legend */}
          <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 mt-2 px-2">
            {allPlatformNames.map((pName) => (
              <div key={pName} className="flex items-center gap-1.5">
                <PlatformIcon name={pName} size={16} />
                <span className="text-xs font-medium text-text-secondary">{pName}</span>
              </div>
            ))}
          </div>
        </ChartCard>
      </motion.div>
    </motion.div>
  );
}
