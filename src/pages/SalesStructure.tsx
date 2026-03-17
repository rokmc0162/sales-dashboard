import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useAppState } from '@/hooks/useAppState';
import { t } from '@/i18n';
import { formatSales, formatSalesShort } from '@/utils/formatters';
import {
  calcTitleConcentration,
  calcPlatformDiversification,
  calcRevenueStability,
} from '@/utils/calculations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartCard } from '@/components/ui/chart-card';
import { Skeleton, SkeletonCard, SkeletonChart } from '@/components/ui/skeleton';
import { DashboardGrid } from '@/components/layout/DashboardGrid';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { CHART_COLORS, tooltipStyle, staggerContainer, staggerItem } from '@/lib/constants';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, ZAxis,
} from 'recharts';

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-72" />
      <DashboardGrid cols={2}>
        <SkeletonChart />
        <SkeletonChart />
      </DashboardGrid>
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map stability level to badge variant and emoji */
function stabilityBadge(stability: 'stable' | 'moderate' | 'volatile', lang: string) {
  const config = {
    stable: {
      variant: 'success' as const,
      icon: '\uD83D\uDFE2',
      label: lang === 'ko' ? '\uC548\uC815' : '\u5B89\u5B9A',
    },
    moderate: {
      variant: 'warning' as const,
      icon: '\uD83D\uDFE1',
      label: lang === 'ko' ? '\uBCF4\uD1B5' : '\u666E\u901A',
    },
    volatile: {
      variant: 'destructive' as const,
      icon: '\uD83D\uDD34',
      label: lang === 'ko' ? '\uBCC0\uB3D9' : '\u5909\u52D5',
    },
  };
  return config[stability];
}

/** Calculate min/max sales across all title monthly trends for heatmap normalization */
function getHeatmapRange(
  titles: { titleKR: string; monthlyTrend: { month: string; sales: number }[] }[],
) {
  let min = Infinity;
  let max = -Infinity;
  titles.forEach(t => {
    t.monthlyTrend.forEach(m => {
      if (m.sales < min) min = m.sales;
      if (m.sales > max) max = m.sales;
    });
  });
  if (min === Infinity) min = 0;
  if (max === -Infinity) max = 0;
  return { min, max };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SalesStructure() {
  const { language, currency, exchangeRate } = useAppState();
  const data = useDataLoader();

  const titleName = (item: { titleKR: string; titleJP: string }) =>
    language === 'ko' ? item.titleKR : item.titleJP;
  const secondaryName = (item: { titleKR: string; titleJP: string }) =>
    language === 'ko' ? item.titleJP : item.titleKR;

  // -----------------------------------------------------------------------
  // 1. Title Concentration (Top 10 donut)
  // -----------------------------------------------------------------------
  const concentration = useMemo(
    () => calcTitleConcentration(data.titleSummary, 10),
    [data.titleSummary],
  );

  const donutData = useMemo(() => {
    const items = concentration.topTitles.map(t => ({
      name: language === 'ko' ? t.titleKR : t.titleJP,
      titleKR: t.titleKR,
      titleJP: t.titleJP,
      value: t.totalSales,
      share: t.share,
      cumShare: t.cumShare,
    }));
    if (concentration.restShare > 0) {
      const restSales = concentration.total - concentration.topTitles.reduce((s, t) => s + t.totalSales, 0);
      items.push({
        name: language === 'ko' ? '\uAE30\uD0C0' : '\u305D\u306E\u4ED6',
        titleKR: '\uAE30\uD0C0',
        titleJP: '\u305D\u306E\u4ED6',
        value: restSales,
        share: concentration.restShare,
        cumShare: 100,
      });
    }
    return items;
  }, [concentration, language]);

  // -----------------------------------------------------------------------
  // 2. Platform Diversification (Scatter)
  // -----------------------------------------------------------------------
  const diversification = useMemo(
    () => calcPlatformDiversification(data.titleSummary),
    [data.titleSummary],
  );

  const scatterData = useMemo(() => {
    return diversification.map(d => ({
      name: language === 'ko' ? d.titleKR : d.titleJP,
      titleKR: d.titleKR,
      titleJP: d.titleJP,
      x: d.platformCount,
      y: d.totalSales,
      z: d.totalSales,
    }));
  }, [diversification, language]);

  // -----------------------------------------------------------------------
  // 3. Revenue Stability
  // -----------------------------------------------------------------------
  const stability = useMemo(
    () => calcRevenueStability(data.titleSummary),
    [data.titleSummary],
  );

  // -----------------------------------------------------------------------
  // 4. Revenue Heatmap (top 20 titles x months)
  // -----------------------------------------------------------------------
  const heatmapData = useMemo(() => {
    const sorted = [...data.titleSummary]
      .sort((a, b) => b.totalSales - a.totalSales)
      .slice(0, 20);

    // Collect all unique months
    const monthSet = new Set<string>();
    sorted.forEach(t => t.monthlyTrend.forEach(m => monthSet.add(m.month)));
    const months = Array.from(monthSet).sort();

    // Build lookup: titleKR -> month -> sales
    const lookup = new Map<string, Map<string, number>>();
    sorted.forEach(t => {
      const mmap = new Map<string, number>();
      t.monthlyTrend.forEach(m => mmap.set(m.month, m.sales));
      lookup.set(t.titleKR, mmap);
    });

    const { min, max } = getHeatmapRange(sorted);

    return { titles: sorted, months, lookup, min, max };
  }, [data.titleSummary]);

  // -----------------------------------------------------------------------
  // Loading
  // -----------------------------------------------------------------------
  if (data.loading) {
    return (
      <div>
        <h1 className="text-2xl md:text-3xl font-bold mb-6 text-primary">
          {language === 'ko' ? '\uB9E4\uCD9C \uAD6C\uC870 \uBD84\uC11D' : '\u58F2\u4E0A\u69CB\u9020\u5206\u6790'}
        </h1>
        <LoadingSkeleton />
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <motion.div initial="hidden" animate="show" variants={staggerContainer}>
      {/* Page Title */}
      <motion.h1
        variants={staggerItem}
        className="text-2xl md:text-3xl font-bold mb-6 text-primary tracking-tight"
      >
        {language === 'ko' ? '\uB9E4\uCD9C \uAD6C\uC870 \uBD84\uC11D' : '\u58F2\u4E0A\u69CB\u9020\u5206\u6790'}
      </motion.h1>

      {/* ================================================================ */}
      {/* Row 1: Donut + Scatter side-by-side                              */}
      {/* ================================================================ */}
      <motion.div variants={staggerItem}>
        <DashboardGrid cols={2}>
          {/* ----- 1. Title Concentration Donut ----- */}
          <ChartCard
            title={language === 'ko' ? '\uC791\uD488 \uC9D1\uC911\uB3C4' : '\u4F5C\u54C1\u96C6\u4E2D\u5EA6'}
            subtitle={
              language === 'ko'
                ? `TOP 10 \uC791\uD488\uC774 \uC804\uCCB4 \uB9E4\uCD9C\uC758 ${concentration.topTitles.length > 0 ? concentration.topTitles[concentration.topTitles.length - 1].cumShare.toFixed(1) : 0}%`
                : `TOP 10\u4F5C\u54C1\u304C\u5168\u4F53\u58F2\u4E0A\u306E${concentration.topTitles.length > 0 ? concentration.topTitles[concentration.topTitles.length - 1].cumShare.toFixed(1) : 0}%`
            }
            variant="glass"
          >
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={donutData}
                  cx="50%"
                  cy="50%"
                  innerRadius={65}
                  outerRadius={110}
                  dataKey="value"
                  nameKey="name"
                  paddingAngle={2}
                  label={((props: { name?: string; share?: number }) => {
                    const n = String(props.name ?? '');
                    const s = Number(props.share ?? 0);
                    return `${n.length > 8 ? n.slice(0, 8) + '..' : n} ${s.toFixed(1)}%`;
                  }) as never}
                  labelLine={{ stroke: '#94A3B8', strokeWidth: 1 }}
                >
                  {donutData.map((_, idx) => (
                    <Cell
                      key={idx}
                      fill={CHART_COLORS[idx % CHART_COLORS.length]}
                      stroke="#ffffff"
                      strokeWidth={2}
                    />
                  ))}
                </Pie>
                <Tooltip
                  {...tooltipStyle}
                  formatter={((value: number, _name: string, item: { payload?: { share?: number; cumShare?: number } }) => {
                    const share = item.payload?.share ?? 0;
                    const cumShare = item.payload?.cumShare ?? 0;
                    return [
                      `${formatSales(Number(value), currency, exchangeRate, language)} (${share.toFixed(1)}% / ${language === 'ko' ? '\uB204\uC801' : '\u7D2F\u8A08'} ${cumShare.toFixed(1)}%)`,
                      '',
                    ];
                  }) as never}
                />
              </PieChart>
            </ResponsiveContainer>

            {/* Cumulative share summary */}
            <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 mt-2 text-xs text-muted-foreground">
              {concentration.topTitles.filter((_, i) => i < 3 || i === 4 || i === 9).map((t, i) => (
                <span key={i}>
                  TOP{concentration.topTitles.indexOf(t) + 1}: {t.cumShare.toFixed(1)}%
                </span>
              ))}
            </div>
          </ChartCard>

          {/* ----- 2. Platform Diversification Scatter ----- */}
          <ChartCard
            title={language === 'ko' ? '\uD50C\uB7AB\uD3FC \uB2E4\uBCC0\uD654' : 'PF\u591A\u69D8\u5316'}
            subtitle={
              language === 'ko'
                ? '\uD50C\uB7AB\uD3FC \uC218 vs \uCD1D \uB9E4\uCD9C (\uBC84\uBE14 \uD06C\uAE30 = \uB9E4\uCD9C)'
                : 'PF\u6570 vs \u7DCF\u58F2\u4E0A (\u30D0\u30D6\u30EB\u30B5\u30A4\u30BA = \u58F2\u4E0A)'
            }
            variant="glass"
          >
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={language === 'ko' ? '\uD50C\uB7AB\uD3FC \uC218' : 'PF\u6570'}
                  stroke="#CBD5E1"
                  tick={{ fill: '#64748B', fontSize: 12 }}
                  label={{
                    value: language === 'ko' ? '\uD50C\uB7AB\uD3FC \uC218' : 'PF\u6570',
                    position: 'insideBottomRight',
                    offset: -5,
                    fill: '#94A3B8',
                    fontSize: 11,
                  }}
                  allowDecimals={false}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name={language === 'ko' ? '\uCD1D \uB9E4\uCD9C' : '\u7DCF\u58F2\u4E0A'}
                  stroke="#CBD5E1"
                  tick={{ fill: '#64748B', fontSize: 12 }}
                  tickFormatter={(v: number) => formatSalesShort(v)}
                />
                <ZAxis
                  type="number"
                  dataKey="z"
                  range={[60, 600]}
                />
                <Tooltip
                  {...tooltipStyle}
                  formatter={((value: number, name: string) => {
                    if (name === (language === 'ko' ? '\uCD1D \uB9E4\uCD9C' : '\u7DCF\u58F2\u4E0A')) {
                      return [formatSales(value, currency, exchangeRate, language), name];
                    }
                    return [value, name];
                  }) as never}
                  labelFormatter={(_, payload) => {
                    if (payload && payload.length > 0) {
                      return payload[0].payload.name;
                    }
                    return '';
                  }}
                />
                <Scatter
                  data={scatterData}
                  fill="#2563EB"
                  fillOpacity={0.6}
                  stroke="#2563EB"
                  strokeWidth={1}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </ChartCard>
        </DashboardGrid>
      </motion.div>

      {/* ================================================================ */}
      {/* Row 2: Revenue Stability Table                                    */}
      {/* ================================================================ */}
      <motion.div variants={staggerItem} className="mt-6">
        <Card variant="glass">
          <CardHeader>
            <CardTitle>
              {language === 'ko' ? '\uB9E4\uCD9C \uC548\uC815\uC131 \uBD84\uC11D' : '\u58F2\u4E0A\u5B89\u5B9A\u6027\u5206\u6790'}
            </CardTitle>
          </CardHeader>
          <CardContent>
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
                  <TableHead className="text-center font-semibold">
                    {language === 'ko' ? '\uC548\uC815\uC131' : '\u5B89\u5B9A\u6027'}
                  </TableHead>
                  <TableHead className="text-center font-semibold">
                    CV
                  </TableHead>
                  <TableHead className="font-semibold">
                    {language === 'ko' ? '\uC6D4\uBCC4 \uCD94\uC774' : '\u6708\u5225\u63A8\u79FB'}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stability.slice(0, 20).map((item, idx) => {
                  const badge = stabilityBadge(item.stability, language);
                  // Get monthly trend data for the mini sparkline
                  const titleData = data.titleSummary.find(ts => ts.titleKR === item.titleKR);
                  const trend = titleData
                    ? [...titleData.monthlyTrend].sort((a, b) => a.month.localeCompare(b.month))
                    : [];
                  const trendMax = trend.reduce((mx, m) => Math.max(mx, m.sales), 0);

                  return (
                    <TableRow
                      key={item.titleKR}
                      className={idx % 2 === 1 ? 'bg-background' : 'bg-card'}
                    >
                      <TableCell className="font-mono text-sm text-muted-foreground">
                        {idx + 1}
                      </TableCell>
                      <TableCell className="font-semibold text-foreground max-w-[200px]">
                        <div className="text-[13px] truncate">{titleName(item)}</div>
                        {item.titleKR !== item.titleJP && (
                          <div className="text-[10px] text-muted-foreground font-normal truncate">{secondaryName(item)}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold text-foreground">
                        {formatSales(item.totalSales, currency, exchangeRate, language)}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant={badge.variant}>
                          {badge.icon} {badge.label}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-center font-mono text-sm text-muted-foreground">
                        {item.cv.toFixed(2)}
                      </TableCell>
                      <TableCell>
                        {/* Mini bar sparkline */}
                        <div className="flex items-end gap-[2px] h-5">
                          {trend.map((m, i) => (
                            <div
                              key={i}
                              className="rounded-[1px] transition-all"
                              style={{
                                width: 4,
                                height: trendMax > 0 ? Math.max(2, (m.sales / trendMax) * 20) : 2,
                                backgroundColor:
                                  item.stability === 'stable'
                                    ? '#22c55e'
                                    : item.stability === 'moderate'
                                      ? '#f59e0b'
                                      : '#ef4444',
                                opacity: 0.4 + (m.sales / (trendMax || 1)) * 0.6,
                              }}
                            />
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {stability.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="p-8 text-center text-[15px] text-muted-foreground">
                      {language === 'ko' ? '\uB370\uC774\uD130\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4.' : '\u30C7\u30FC\u30BF\u304C\u3042\u308A\u307E\u305B\u3093\u3002'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </motion.div>

      {/* ================================================================ */}
      {/* Row 3: Revenue Heatmap                                            */}
      {/* ================================================================ */}
      <motion.div
        variants={staggerItem}
        className="mt-6"
      >
        <Card variant="glass">
          <CardHeader>
            <CardTitle>
              {language === 'ko' ? '\uC6D4\uBCC4 \uB9E4\uCD9C \uD788\uD2B8\uB9F5' : '\u6708\u5225\u58F2\u4E0A\u30D2\u30FC\u30C8\u30DE\u30C3\u30D7'}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <div className="min-w-[640px]">
                {/* Header row: months */}
                <div className="flex">
                  <div className="w-40 flex-shrink-0 text-xs font-semibold text-muted-foreground p-1.5">
                    {t(language, 'table.title')}
                  </div>
                  {heatmapData.months.map(month => (
                    <div
                      key={month}
                      className="flex-1 text-center text-[10px] font-medium text-muted-foreground p-1"
                    >
                      {month.substring(2).replace('-', '/')}
                    </div>
                  ))}
                </div>

                {/* Data rows */}
                {heatmapData.titles.map((title, rowIdx) => {
                  const monthMap = heatmapData.lookup.get(title.titleKR);
                  return (
                    <div
                      key={title.titleKR}
                      className={`flex items-center ${rowIdx % 2 === 0 ? 'bg-card' : 'bg-background'}`}
                    >
                      <div
                        className="w-40 flex-shrink-0 text-xs font-medium text-foreground p-1.5"
                        title={`${titleName(title)} / ${secondaryName(title)}`}
                      >
                        <div className="truncate">{titleName(title)}</div>
                        {title.titleKR !== title.titleJP && (
                          <div className="text-[9px] text-muted-foreground font-normal truncate">{secondaryName(title)}</div>
                        )}
                      </div>
                      {heatmapData.months.map(month => {
                        const sales = monthMap?.get(month) ?? 0;
                        const range = heatmapData.max - heatmapData.min;
                        const intensity = range > 0
                          ? (sales - heatmapData.min) / range
                          : 0;

                        return (
                          <div
                            key={month}
                            className="flex-1 p-0.5"
                          >
                            <div
                              className="rounded-sm w-full h-6 transition-colors duration-200 cursor-default"
                              style={{
                                backgroundColor: sales > 0
                                  ? `rgba(37, 99, 235, ${0.08 + intensity * 0.82})`
                                  : 'rgba(148, 163, 184, 0.08)',
                              }}
                              title={`${titleName(title)} | ${month}: ${formatSales(sales, currency, exchangeRate, language)}`}
                            />
                          </div>
                        );
                      })}
                    </div>
                  );
                })}

                {/* Legend */}
                <div className="flex items-center justify-end gap-2 mt-3 pr-1">
                  <span className="text-[10px] text-muted-foreground">
                    {language === 'ko' ? '\uB0AE\uC74C' : '\u4F4E'}
                  </span>
                  <div className="flex gap-0.5">
                    {[0.1, 0.25, 0.45, 0.65, 0.85].map((opacity, i) => (
                      <div
                        key={i}
                        className="w-5 h-3 rounded-[2px]"
                        style={{ backgroundColor: `rgba(37, 99, 235, ${opacity})` }}
                      />
                    ))}
                  </div>
                  <span className="text-[10px] text-muted-foreground">
                    {language === 'ko' ? '\uB192\uC74C' : '\u9AD8'}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  );
}
