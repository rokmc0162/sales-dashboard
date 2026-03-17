import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { useDataLoader, useDailySales } from '@/hooks/useDataLoader';
import { useAppState } from '@/hooks/useAppState';
import { t } from '@/i18n';
import { formatSales, formatSalesShort, formatPercent, getChangeColor } from '@/utils/formatters';
import { calcGrowthRate, calcWeekdayPattern } from '@/utils/calculations';
import { CHART_COLORS, tooltipStyle, staggerContainer, staggerItem } from '@/lib/constants';
import { Card, CardContent } from '@/components/ui/card';
import { ChartCard } from '@/components/ui/chart-card';
import { DashboardGrid } from '@/components/layout/DashboardGrid';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';

/* ------------------------------------------------------------------ */
/*  Local animation variant for list slide-in                          */
/* ------------------------------------------------------------------ */

const listItem = {
  hidden: { opacity: 0, x: -12 },
  show: { opacity: 1, x: 0 },
};

/* ------------------------------------------------------------------ */
/*  Skeleton loader                                                    */
/* ------------------------------------------------------------------ */

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-64" />
      <DashboardGrid cols={2}>
        {[...Array(2)].map((_, i) => <Card key={i} variant="glass"><CardContent className="p-6 space-y-3">
          <Skeleton className="h-5 w-40 mb-3" />
          {[...Array(5)].map((_, j) => <div key={j} className="flex justify-between py-2"><Skeleton className="h-4 w-40" /><Skeleton className="h-4 w-16" /></div>)}
        </CardContent></Card>)}
      </DashboardGrid>
      <Card variant="glass"><CardContent className="p-6"><Skeleton className="h-5 w-48 mb-4" /><Skeleton className="h-64 w-full rounded-xl" /></CardContent></Card>
      <Card variant="glass"><CardContent className="p-6"><Skeleton className="h-5 w-48 mb-4" /><Skeleton className="h-80 w-full rounded-xl" /></CardContent></Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function Trends() {
  const data = useDataLoader();
  const { dailySales, loading: dailyLoading } = useDailySales(data);
  const { language, currency, exchangeRate } = useAppState();

  // Growth TOP 10
  const growthTop10 = useMemo(() => {
    if (data.titleSummary.length === 0) return [];
    return calcGrowthRate(data.titleSummary).slice(0, 10);
  }, [data.titleSummary]);

  // Decline alerts: titles with >30% decline
  const declineAlerts = useMemo(() => {
    if (data.titleSummary.length === 0) return [];
    return calcGrowthRate(data.titleSummary)
      .filter(item => item.growth < -30)
      .sort((a, b) => a.growth - b.growth);
  }, [data.titleSummary]);

  // New title performance: titles that first appeared in last 60 days of data range
  const newTitlePerformance = useMemo(() => {
    if (dailySales.length === 0 || data.titleSummary.length === 0) return [];

    const allDates = dailySales.map(d => d.date).sort();
    const latestDate = allDates[allDates.length - 1];
    const cutoff = new Date(latestDate);
    cutoff.setDate(cutoff.getDate() - 60);
    const cutoffStr = cutoff.toISOString().substring(0, 10);

    return data.titleSummary
      .filter(ts => ts.firstDate >= cutoffStr)
      .map(ts => ({
        titleKR: ts.titleKR,
        titleJP: ts.titleJP,
        firstDate: ts.firstDate,
        totalSales: ts.totalSales,
      }))
      .sort((a, b) => b.totalSales - a.totalSales);
  }, [dailySales, data.titleSummary]);

  // Weekday pattern
  const weekdayData = useMemo(() => {
    if (dailySales.length === 0) return [];
    return calcWeekdayPattern(dailySales);
  }, [dailySales]);

  const bestDay = useMemo(() => {
    if (weekdayData.length === 0) return -1;
    let maxIdx = 0;
    weekdayData.forEach((d, i) => {
      if (d.avgSales > weekdayData[maxIdx].avgSales) maxIdx = i;
    });
    return maxIdx;
  }, [weekdayData]);

  if (dailyLoading) {
    return <LoadingSkeleton />;
  }

  const titleName = (item: { titleKR: string; titleJP: string }) =>
    language === 'ko' ? item.titleKR : item.titleJP;
  const secondaryName = (item: { titleKR: string; titleJP: string }) =>
    language === 'ko' ? item.titleJP : item.titleKR;

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
        {t(language, 'nav.trends')}
      </motion.h1>

      <DashboardGrid cols={2} className="mb-6">
        {/* Growth TOP 10 */}
        <motion.div variants={staggerItem}>
          <Card variant="glass" className="h-full">
            <CardContent className="p-6">
              <h3 className="text-lg font-bold mb-5 text-primary">
                {t(language, 'chart.growthTop')} 10
              </h3>
              {growthTop10.length === 0 ? (
                <p className="text-sm text-text-muted">
                  {language === 'ko' ? '데이터 없음' : 'データなし'}
                </p>
              ) : (
                <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-1.5">
                  {growthTop10.map((item, idx) => (
                    <motion.div
                      key={idx}
                      variants={listItem}
                      className={`flex items-center justify-between py-2.5 px-4 rounded-xl transition-colors duration-150 hover:bg-muted ${
                        idx % 2 === 0 ? 'bg-background' : 'bg-transparent'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span
                          className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                            idx < 3
                              ? 'bg-primary text-white'
                              : 'bg-border text-muted-foreground'
                          }`}
                        >
                          {idx + 1}
                        </span>
                        <div className="min-w-0">
                          <span className="truncate text-sm font-medium text-foreground block">
                            {titleName(item.title)}
                          </span>
                          {item.title.titleKR !== item.title.titleJP && (
                            <span className="text-[10px] text-muted-foreground block truncate">{secondaryName(item.title)}</span>
                          )}
                        </div>
                      </div>
                      <span
                        className="flex-shrink-0 text-sm font-bold ml-3"
                        style={{ color: getChangeColor(item.growth) }}
                      >
                        {formatPercent(item.growth)}
                      </span>
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Decline Alerts */}
        <motion.div variants={staggerItem}>
          <Card variant="glass" className="h-full">
            <CardContent className="p-6">
              <h3 className="text-lg font-bold mb-5 text-primary">
                {t(language, 'chart.declineAlert')}
              </h3>
              {declineAlerts.length === 0 ? (
                <div className="flex items-center gap-3 py-5 px-4 rounded-xl bg-[#F0FDF4]">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                  <span className="text-sm font-medium text-[#16A34A]">
                    {language === 'ko' ? '30% 이상 하락한 작품이 없습니다' : '30%以上下落した作品はありません'}
                  </span>
                </div>
              ) : (
                <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-1.5">
                  {declineAlerts.map((item, idx) => (
                    <motion.div
                      key={idx}
                      variants={listItem}
                      className="flex items-center justify-between py-2.5 px-4 rounded-xl bg-[#FEF2F2]"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                          <line x1="12" y1="9" x2="12" y2="13" />
                          <line x1="12" y1="17" x2="12.01" y2="17" />
                        </svg>
                        <div className="min-w-0">
                          <span className="truncate text-sm font-medium text-foreground block">
                            {titleName(item.title)}
                          </span>
                          {item.title.titleKR !== item.title.titleJP && (
                            <span className="text-[10px] text-muted-foreground block truncate">{secondaryName(item.title)}</span>
                          )}
                        </div>
                      </div>
                      <span className="flex-shrink-0 text-sm font-bold ml-3 text-[#DC2626]">
                        {formatPercent(item.growth)}
                      </span>
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </DashboardGrid>

      {/* New Title Performance */}
      <motion.div variants={staggerItem} className="mb-6">
        <Card variant="glass">
          <CardContent className="p-6">
            <h3 className="text-lg font-bold mb-5 text-primary">
              {t(language, 'chart.newTitles')}
            </h3>
            {newTitlePerformance.length === 0 ? (
              <p className="text-sm text-text-muted">
                {language === 'ko' ? '최근 60일간 신규 작품이 없습니다' : '過去60日間の新規作品はありません'}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t(language, 'table.title')}</TableHead>
                    <TableHead>{t(language, 'table.date')}</TableHead>
                    <TableHead className="text-right">{t(language, 'table.sales')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {newTitlePerformance.map((item, idx) => (
                    <TableRow key={idx}>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <Badge variant="success">
                            {t(language, 'trend.new')}
                          </Badge>
                          <div className="min-w-0">
                            <span className="truncate font-medium text-foreground block">
                              {language === 'ko' ? item.titleKR : item.titleJP}
                            </span>
                            {item.titleKR !== item.titleJP && (
                              <span className="text-[10px] text-muted-foreground block truncate">
                                {language === 'ko' ? item.titleJP : item.titleKR}
                              </span>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground font-medium">
                        {item.firstDate}
                      </TableCell>
                      <TableCell className="text-right font-bold text-foreground text-[15px]">
                        {formatSales(item.totalSales, currency, exchangeRate, language)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </motion.div>

      {/* Weekday Pattern */}
      <motion.div variants={staggerItem}>
        <ChartCard
          title={t(language, 'chart.weekdayPattern')}
          subtitle={
            bestDay >= 0
              ? language === 'ko'
                ? `매출이 가장 높은 요일: ${weekdayData[bestDay].day}요일`
                : `売上最多曜日: ${weekdayData[bestDay].day}曜日`
              : undefined
          }
          variant="glass"
        >
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={weekdayData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis
                dataKey="day"
                stroke="#CBD5E1"
                tick={{ fill: '#475569', fontSize: 13, fontWeight: 600 }}
              />
              <YAxis
                stroke="#CBD5E1"
                tick={{ fill: '#64748B', fontSize: 12, fontWeight: 500 }}
                tickFormatter={(v: any) => formatSalesShort(v)}
              />
              <Tooltip
                {...tooltipStyle}
                formatter={(value: any) => [
                  formatSales(value, currency, exchangeRate, language),
                  language === 'ko' ? '평균 매출' : '平均売上',
                ]}
              />
              <Bar dataKey="avgSales" radius={[6, 6, 0, 0]}>
                {weekdayData.map((_, idx) => (
                  <Cell
                    key={idx}
                    fill={idx === bestDay ? '#16A34A' : CHART_COLORS[0]}
                    fillOpacity={idx === bestDay ? 1 : 0.8}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </motion.div>
    </motion.div>
  );
}
