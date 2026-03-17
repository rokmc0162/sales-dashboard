import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, TrendingUp, TrendingDown, Minus, BarChart3, Filter, Zap } from 'lucide-react';
import { InitialSalesView } from './InitialSalesView';
import { useDataLoader, useDailySales } from '@/hooks/useDataLoader';
import { useAppState } from '@/hooks/useAppState';
import { t } from '@/i18n';
import { formatSales, formatSalesShort, formatPercent, getChangeColor } from '@/utils/formatters';
import { getPlatformBrand, buildPlatformColorMap } from '@/utils/platformConfig';
import { PlatformIcon, PlatformBadge } from '@/components/PlatformIcon';
import { Card } from '@/components/ui/card';
import { ChartCard } from '@/components/ui/chart-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DashboardGrid } from '@/components/layout/DashboardGrid';
import { BilingualTitle } from '@/components/BilingualTitle';
import { ContentTypeBadge } from '@/components/ContentTypeBadge';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { CHART_COLORS, tooltipStyle, staggerContainer, staggerItem } from '@/lib/constants';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

// ---------------------------------------------------------------------------
// Local animation variant (unique to this page) - uses "show" to match constants
// ---------------------------------------------------------------------------
const detailReveal = {
  hidden: { opacity: 0, x: 20 },
  show: { opacity: 1, x: 0, transition: { duration: 0.4, ease: 'easeOut' as const } },
};

type SortKey = 'sales' | 'platforms' | 'name';

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------
function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-64" /> {/* Title */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Left panel */}
        <Card variant="glass" className="w-full lg:w-80 p-4 space-y-3">
          <Skeleton className="h-8 w-full" /> {/* Search */}
          <div className="flex gap-1.5">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-7 w-16" />)}
          </div>
          {[...Array(8)].map((_, i) => (
            <div key={i} className="space-y-2 py-2">
              <div className="flex justify-between"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-20" /></div>
              <div className="flex gap-1">{[...Array(3)].map((_, j) => <Skeleton key={j} className="h-5 w-5 rounded" />)}</div>
            </div>
          ))}
        </Card>
        {/* Right panel */}
        <div className="flex-1 space-y-6">
          <div className="flex justify-between"><Skeleton className="h-8 w-48" /><Skeleton className="h-10 w-36" /></div>
          <DashboardGrid cols={4}>
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </DashboardGrid>
          <DashboardGrid cols={2}>
            {[...Array(2)].map((_, i) => <Skeleton key={i} className="h-72 rounded-xl" />)}
          </DashboardGrid>
          <Skeleton className="h-96 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
type MainTab = 'analysis' | 'initial';

export function TitleAnalysis() {
  const { language, currency, exchangeRate } = useAppState();
  const data = useDataLoader();
  const { dailySales, loading: dailyLoading } = useDailySales(data);

  const [mainTab, setMainTab] = useState<MainTab>('analysis');
  const [search, setSearch] = useState('');
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('sales');
  // Period filter for detail panel
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');

  // Build platform -> color map (consistent across the page)
  const platformColorMap = useMemo(() => {
    const allPlatforms = new Set<string>();
    data.titleSummary.forEach(ts => ts.platforms.forEach(p => allPlatforms.add(p.name)));
    return buildPlatformColorMap(allPlatforms);
  }, [data.titleSummary]);

  // Growth for every title (last month vs previous month)
  const titleGrowths = useMemo(() => {
    const map: Record<string, number> = {};
    data.titleSummary.forEach(ts => {
      const trend = [...ts.monthlyTrend].sort((a, b) => a.month.localeCompare(b.month));
      if (trend.length < 2) { map[ts.titleKR] = 0; return; }
      const last = trend[trend.length - 1].sales;
      const prev = trend[trend.length - 2].sales;
      map[ts.titleKR] = prev > 0 ? ((last - prev) / prev) * 100 : 0;
    });
    return map;
  }, [data.titleSummary]);

  // Filter by search
  const filteredTitles = useMemo(() => {
    if (!search.trim()) return data.titleSummary;
    const q = search.toLowerCase();
    return data.titleSummary.filter(
      ts => ts.titleKR.toLowerCase().includes(q) || ts.titleJP.toLowerCase().includes(q),
    );
  }, [data.titleSummary, search]);

  // Sort
  const sortedTitles = useMemo(() => {
    const arr = [...filteredTitles];
    switch (sortKey) {
      case 'sales':
        return arr.sort((a, b) => b.totalSales - a.totalSales);
      case 'platforms':
        return arr.sort((a, b) => b.platforms.length - a.platforms.length || b.totalSales - a.totalSales);
      case 'name':
        return arr.sort((a, b) => {
          const nameA = language === 'ko' ? a.titleKR : a.titleJP;
          const nameB = language === 'ko' ? b.titleKR : b.titleJP;
          return nameA.localeCompare(nameB);
        });
      default:
        return arr;
    }
  }, [filteredTitles, sortKey, language]);

  // Auto-select first title when none selected
  const activeTitleKey = selectedTitle ?? (sortedTitles.length > 0 ? sortedTitles[0].titleKR : null);

  // Selected title data
  const selectedTitleData = useMemo(() => {
    if (!activeTitleKey) return null;
    return data.titleSummary.find(ts => ts.titleKR === activeTitleKey) ?? null;
  }, [data.titleSummary, activeTitleKey]);

  // Donut chart: platform sales share
  const platformShareData = useMemo(() => {
    if (!selectedTitleData) return [];
    const total = selectedTitleData.platforms.reduce((s, p) => s + p.sales, 0);
    return selectedTitleData.platforms
      .map(p => ({ name: p.name, sales: p.sales, percent: total > 0 ? (p.sales / total) * 100 : 0 }))
      .sort((a, b) => b.sales - a.sales);
  }, [selectedTitleData]);

  // Monthly trend bar chart data
  const monthlyTrendData = useMemo(() => {
    if (!selectedTitleData) return [];
    return [...selectedTitleData.monthlyTrend]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map(m => ({
        month: m.month,
        label: `${parseInt(m.month.split('-')[1])}${language === 'ko' ? '월' : '月'}`,
        sales: m.sales,
      }));
  }, [selectedTitleData, language]);

  // Weekly platform trend (multi-line chart)
  const weeklyPlatformTrend = useMemo(() => {
    if (!activeTitleKey) return { data: [] as Record<string, string | number>[], platforms: [] as string[] };

    const titleSales = dailySales.filter(d => d.titleKR === activeTitleKey);

    const platformSet = new Set<string>();
    titleSales.forEach(d => platformSet.add(d.channel));
    const platforms = Array.from(platformSet);

    // Group by week + channel
    const weekMap = new Map<string, Record<string, number>>();
    titleSales.forEach(d => {
      const date = new Date(d.date);
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      const weekKey = weekStart.toISOString().substring(0, 10);

      if (!weekMap.has(weekKey)) weekMap.set(weekKey, {});
      const entry = weekMap.get(weekKey)!;
      entry[d.channel] = (entry[d.channel] || 0) + d.sales;
    });

    const weeks = Array.from(weekMap.keys()).sort();
    const chartData = weeks.map(week => {
      const ws = new Date(week);
      const we = new Date(ws);
      we.setDate(ws.getDate() + 6);
      const label = `${ws.getMonth() + 1}/${ws.getDate()}-${we.getMonth() + 1}/${we.getDate()}`;

      const row: Record<string, string | number> = { week, label };
      const entry = weekMap.get(week)!;
      platforms.forEach(p => { row[p] = entry[p] || 0; });
      return row;
    });

    return { data: chartData, platforms };
  }, [dailySales, activeTitleKey]);

  // Per-platform growth for selected title
  const platformGrowths = useMemo(() => {
    if (!activeTitleKey || !selectedTitleData) return new Map<string, number>();

    const titleSales = dailySales.filter(d => d.titleKR === activeTitleKey);
    const map = new Map<string, number>();

    selectedTitleData.platforms.forEach(p => {
      const platformSales = titleSales.filter(d => d.channel === p.name);
      const monthMap = new Map<string, number>();
      platformSales.forEach(d => {
        const month = d.date.substring(0, 7);
        monthMap.set(month, (monthMap.get(month) || 0) + d.sales);
      });

      const months = Array.from(monthMap.keys()).sort();
      if (months.length < 2) { map.set(p.name, 0); return; }
      const last = monthMap.get(months[months.length - 1]) || 0;
      const prev = monthMap.get(months[months.length - 2]) || 0;
      map.set(p.name, prev > 0 ? ((last - prev) / prev) * 100 : 0);
    });

    return map;
  }, [dailySales, activeTitleKey, selectedTitleData]);

  // Date range for quick buttons
  const dataDateRange = useMemo(() => {
    if (dailySales.length === 0) return { min: '', max: '' };
    const dates = dailySales.map(d => d.date).sort();
    return { min: dates[0], max: dates[dates.length - 1] };
  }, [dailySales]);

  // Filtered daily sales for selected title + period + platform
  const filteredDailySales = useMemo(() => {
    if (!activeTitleKey) return [];
    let sales = dailySales.filter(d => d.titleKR === activeTitleKey);
    if (periodStart) sales = sales.filter(d => d.date >= periodStart);
    if (periodEnd) sales = sales.filter(d => d.date <= periodEnd);
    if (platformFilter) sales = sales.filter(d => d.channel === platformFilter);
    return sales;
  }, [dailySales, activeTitleKey, periodStart, periodEnd, platformFilter]);

  // Platform period summary table
  const platformPeriodSummary = useMemo(() => {
    if (!activeTitleKey) return [];
    let sales = dailySales.filter(d => d.titleKR === activeTitleKey);
    if (periodStart) sales = sales.filter(d => d.date >= periodStart);
    if (periodEnd) sales = sales.filter(d => d.date <= periodEnd);

    const platformMap = new Map<string, number>();
    sales.forEach(d => {
      platformMap.set(d.channel, (platformMap.get(d.channel) || 0) + d.sales);
    });

    const total = Array.from(platformMap.values()).reduce((s, v) => s + v, 0);
    return Array.from(platformMap.entries())
      .map(([name, pSales]) => ({
        name,
        sales: pSales,
        percent: total > 0 ? (pSales / total) * 100 : 0,
      }))
      .sort((a, b) => b.sales - a.sales);
  }, [dailySales, activeTitleKey, periodStart, periodEnd]);

  const filteredPeriodTotal = useMemo(() => {
    return filteredDailySales.reduce((s, d) => s + d.sales, 0);
  }, [filteredDailySales]);

  // Quick period buttons helper
  const setQuickPeriod = (days: number | null) => {
    if (days === null) {
      setPeriodStart('');
      setPeriodEnd('');
    } else {
      const end = dataDateRange.max;
      const start = new Date(end);
      start.setDate(start.getDate() - days);
      setPeriodStart(start.toISOString().substring(0, 10));
      setPeriodEnd(end);
    }
  };

  // Reset filters when title changes
  useMemo(() => {
    setPlatformFilter('');
  }, [activeTitleKey]);

  // titleName kept for chart axis labels (single-line)
  const titleName = (ts: { titleKR: string; titleJP: string }) =>
    language === 'ko' ? ts.titleKR : ts.titleJP;

  // ---------------------------------------------------------------------------
  // Loading — wait for both summaries and dailySales
  // ---------------------------------------------------------------------------
  if (data.loading || dailyLoading) {
    return <LoadingSkeleton />;
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'sales', label: language === 'ko' ? '매출순' : '売上順' },
    { key: 'platforms', label: language === 'ko' ? '플랫폼수' : 'PF数' },
    { key: 'name', label: language === 'ko' ? '가나다순' : '名前順' },
  ];

  return (
    <motion.div initial="hidden" animate="show" variants={staggerContainer}>
      {/* Page Title */}
      <motion.h1
        variants={staggerItem}
        className="font-bold mb-4 text-primary text-2xl md:text-3xl tracking-tight"
      >
        {t(language, 'nav.titles')}
      </motion.h1>

      {/* Main Tab Toggle: 매출 분석 | 초동매출 */}
      <motion.div variants={staggerItem} className="mb-5">
        <Tabs defaultValue="analysis" value={mainTab} onValueChange={(v) => setMainTab(v as MainTab)}>
          <TabsList>
            <TabsTrigger value="analysis" className="gap-1.5">
              <BarChart3 size={14} />
              {t(language, 'initialSales.salesAnalysis')}
            </TabsTrigger>
            <TabsTrigger value="initial" className="gap-1.5">
              <Zap size={14} />
              {t(language, 'initialSales.tab')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </motion.div>

      {/* Tab Content */}
      {mainTab === 'initial' ? (
        <InitialSalesView />
      ) : (
      <div className="flex flex-col lg:flex-row gap-4 lg:gap-6 lg:h-[calc(100vh-200px)]">
        {/* ================================================================ */}
        {/* LEFT PANEL -- Title List                                         */}
        {/* ================================================================ */}
        <motion.div variants={staggerItem} className="flex-shrink-0 w-full lg:w-80 max-h-[40vh] lg:max-h-none">
          <Card
            variant="glass"
            className="flex flex-col overflow-hidden h-full"
          >
            {/* Header + Search + Sort */}
            <div className="px-4 pt-5 pb-3">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <BarChart3 size={18} className="text-primary" />
                  <h2 className="font-bold text-primary text-[15px]">
                    {language === 'ko' ? '작품 목록' : '作品一覧'}
                  </h2>
                </div>
                <Badge variant="secondary">
                  {filteredTitles.length}{language === 'ko' ? '개' : '件'}
                </Badge>
              </div>

              {/* Search */}
              <div className="relative mb-3">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <Search size={15} className="text-text-muted" />
                </div>
                <Input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder={language === 'ko' ? '작품명 검색...' : '作品名検索...'}
                  className="pl-9 text-[13px] bg-background"
                />
              </div>

              {/* Sort tabs */}
              <Tabs
                defaultValue="sales"
                value={sortKey}
                onValueChange={(v) => setSortKey(v as SortKey)}
              >
                <TabsList className="w-full">
                  {sortOptions.map(opt => (
                    <TabsTrigger
                      key={opt.key}
                      value={opt.key}
                      className="text-[11px] flex-1"
                    >
                      {opt.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>

            {/* Scrollable list */}
            <ScrollArea className="flex-1 px-2 pb-2">
              {sortedTitles.map(title => {
                const isSelected = activeTitleKey === title.titleKR;
                const growth = titleGrowths[title.titleKR] || 0;

                return (
                  <div
                    key={title.titleKR}
                    onClick={() => setSelectedTitle(title.titleKR)}
                    className={`px-3 py-3 rounded-xl mb-1 cursor-pointer transition-all duration-150
                      ${isSelected
                        ? 'bg-blue-50 border border-blue-200'
                        : 'border border-transparent hover:bg-background'
                      }`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <div className={`max-w-[180px] ${isSelected ? 'text-blue-600' : 'text-foreground'}`}>
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold leading-tight text-[13px] truncate">{titleName(title)}</span>
                          {title.contentType && title.contentType !== 'UNKNOWN' && (
                            <ContentTypeBadge type={title.contentType} language={language} size="sm" />
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                          {language === 'ko' ? title.titleJP : title.titleKR}
                        </div>
                      </div>
                      <span className="font-bold flex-shrink-0 text-foreground text-[13px]">
                        {formatSales(title.totalSales, currency, exchangeRate, language)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between">
                      {/* Platform dots */}
                      <div className="flex items-center gap-1.5">
                        {title.platforms.slice(0, 5).map((p, i) => (
                          <PlatformIcon key={i} name={p.name} size={22} />
                        ))}
                        {title.platforms.length > 5 && (
                          <div
                            className="flex items-center justify-center flex-shrink-0 rounded-[5px] bg-border text-muted-foreground text-[9px] font-bold leading-none"
                            style={{ width: 22, height: 22 }}
                            title={title.platforms.slice(5).map(p => p.name).join(', ')}
                          >
                            +{title.platforms.length - 5}
                          </div>
                        )}
                      </div>

                      {/* Growth + platform count */}
                      <div className="flex items-center gap-1.5">
                        {growth > 5 ? (
                          <TrendingUp size={13} color="#16A34A" />
                        ) : growth < -5 ? (
                          <TrendingDown size={13} color="#DC2626" />
                        ) : (
                          <Minus size={13} className="text-text-muted" />
                        )}
                        <span className="text-text-muted text-[11px] font-medium">
                          {title.platforms.length}{language === 'ko' ? '개 플랫폼' : 'PF'}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </ScrollArea>
          </Card>
        </motion.div>

        {/* ================================================================ */}
        {/* RIGHT PANEL -- Detail View                                       */}
        {/* ================================================================ */}
        <ScrollArea className="flex-1 pr-1">
          {selectedTitleData ? (
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTitleKey}
                initial="hidden"
                animate="show"
                variants={staggerContainer}
                className="space-y-6 pb-8"
              >
                {/* Header: Title Name + Cumulative Sales */}
                <motion.div
                  variants={detailReveal}
                  className="flex items-start justify-between flex-wrap gap-4"
                >
                  <div className="min-w-0">
                    <BilingualTitle
                      titleKR={selectedTitleData.titleKR}
                      titleJP={selectedTitleData.titleJP}
                      language={language}
                      variant="default"
                      className="text-primary [&>div:first-child]:text-2xl [&>div:first-child]:font-bold [&>div:last-child]:text-sm"
                    />
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      {selectedTitleData.platforms.map((p, i) => (
                        <PlatformBadge key={i} name={p.name} />
                      ))}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-muted-foreground text-[13px] font-medium">
                      {language === 'ko' ? '누적 매출' : '累計売上'}
                    </p>
                    <p className="font-extrabold text-primary text-[32px] leading-tight">
                      {formatSales(selectedTitleData.totalSales, currency, exchangeRate, language)}
                    </p>
                  </div>
                </motion.div>

                {/* Period & Platform Filter */}
                <motion.div variants={detailReveal}>
                  <Card variant="glass" className="p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <Filter size={15} className="text-primary" />
                      <span className="text-sm font-bold text-primary">
                        {language === 'ko' ? '기간 · 플랫폼 필터' : '期間・PFフィルター'}
                      </span>
                      {(periodStart || periodEnd || platformFilter) && (
                        <button
                          onClick={() => { setPeriodStart(''); setPeriodEnd(''); setPlatformFilter(''); }}
                          className="ml-auto text-[11px] text-muted-foreground hover:text-foreground cursor-pointer bg-transparent border-none"
                        >
                          {language === 'ko' ? '초기화' : 'リセット'}
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap items-end gap-3">
                      {/* Quick period buttons */}
                      <div className="flex gap-1.5">
                        {[
                          { days: 7, label: language === 'ko' ? '7일' : '7日' },
                          { days: 30, label: language === 'ko' ? '30일' : '30日' },
                          { days: 90, label: language === 'ko' ? '90일' : '90日' },
                          { days: null as number | null, label: language === 'ko' ? '전체' : '全体' },
                        ].map((btn) => (
                          <button
                            key={btn.label}
                            onClick={() => setQuickPeriod(btn.days)}
                            className={`px-3 py-1.5 rounded-lg text-[11px] font-semibold cursor-pointer transition-colors border ${
                              (btn.days === null && !periodStart && !periodEnd) ||
                              (btn.days !== null && periodStart && periodEnd)
                                ? ''
                                : ''
                            } ${
                              btn.days === null && !periodStart && !periodEnd
                                ? 'bg-primary text-white border-primary'
                                : 'bg-background text-muted-foreground border-border hover:bg-muted'
                            }`}
                          >
                            {btn.label}
                          </button>
                        ))}
                      </div>
                      {/* Date range inputs */}
                      <div className="flex items-center gap-1.5">
                        <Input
                          type="date"
                          value={periodStart}
                          onChange={e => setPeriodStart(e.target.value)}
                          className="h-8 text-[11px] w-[130px] rounded-lg"
                        />
                        <span className="text-muted-foreground text-xs">~</span>
                        <Input
                          type="date"
                          value={periodEnd}
                          onChange={e => setPeriodEnd(e.target.value)}
                          className="h-8 text-[11px] w-[130px] rounded-lg"
                        />
                      </div>
                      {/* Platform filter */}
                      <Select
                        value={platformFilter}
                        onChange={e => setPlatformFilter(e.target.value)}
                        className="h-8 text-[11px] min-w-[140px] rounded-lg"
                      >
                        <option value="">{language === 'ko' ? '전체 플랫폼' : '全PF'}</option>
                        {selectedTitleData.platforms.map(p => (
                          <option key={p.name} value={p.name}>{p.name}</option>
                        ))}
                      </Select>
                    </div>
                    {/* Period total */}
                    {(periodStart || periodEnd || platformFilter) && (
                      <div className="mt-3 pt-3 border-t border-border/60">
                        <span className="text-xs text-muted-foreground">
                          {language === 'ko' ? '필터 적용 매출: ' : 'フィルター適用売上: '}
                        </span>
                        <span className="text-sm font-bold text-primary">
                          {formatSales(filteredPeriodTotal, currency, exchangeRate, language)}
                        </span>
                      </div>
                    )}
                  </Card>
                </motion.div>

                {/* Platform Period Summary Table */}
                {(periodStart || periodEnd) && platformPeriodSummary.length > 0 && (
                  <motion.div variants={detailReveal}>
                    <Card variant="glass" className="overflow-hidden">
                      <div className="px-4 py-3 border-b border-border/60">
                        <h3 className="font-bold text-primary text-sm">
                          {language === 'ko' ? '기간별 플랫폼 매출 요약' : '期間別PF売上サマリー'}
                        </h3>
                      </div>
                      <Table className="text-sm">
                        <TableHeader>
                          <TableRow className="bg-muted hover:bg-muted">
                            <TableHead className="font-semibold text-xs">{t(language, 'table.platform')}</TableHead>
                            <TableHead className="text-right font-semibold text-xs">{t(language, 'table.sales')}</TableHead>
                            <TableHead className="text-right font-semibold text-xs">{language === 'ko' ? '비중' : 'シェア'}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {platformPeriodSummary.map((p, idx) => (
                            <TableRow key={p.name} className={idx % 2 === 1 ? 'bg-background' : 'bg-card'}>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <PlatformIcon name={p.name} size={18} />
                                  <span className="font-medium text-foreground text-[13px]">{p.name}</span>
                                </div>
                              </TableCell>
                              <TableCell className="text-right font-mono text-[13px] font-semibold text-foreground">
                                {formatSales(p.sales, currency, exchangeRate, language)}
                              </TableCell>
                              <TableCell className="text-right font-mono text-[13px] text-muted-foreground">
                                {p.percent.toFixed(1)}%
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </Card>
                  </motion.div>
                )}

                {/* Platform Cards Grid */}
                <motion.div variants={detailReveal}>
                  <h3 className="font-bold mb-3 text-primary text-base">
                    {language === 'ko' ? '서비스 플랫폼' : 'サービスプラットフォーム'}
                  </h3>
                  <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                    {selectedTitleData.platforms
                      .sort((a, b) => b.sales - a.sales)
                      .map((p, i) => {
                        const growth = platformGrowths.get(p.name) || 0;
                        return (
                          <Card
                            key={i}
                            variant="glass"
                            className="p-4 transition-shadow duration-200 hover:shadow-md"
                            style={{
                              borderLeft: `3px solid ${getPlatformBrand(p.name).color}`,
                            }}
                          >
                            <div className="flex items-center gap-2 mb-2">
                              <PlatformIcon name={p.name} size={22} />
                              <span className="font-semibold truncate text-primary text-[13px]">
                                {p.name}
                              </span>
                            </div>
                            <p className="font-bold mb-1 text-foreground text-base">
                              {formatSales(p.sales, currency, exchangeRate, language)}
                            </p>
                            <div className="flex items-center gap-1">
                              {growth > 0 ? (
                                <TrendingUp size={12} color="#16A34A" />
                              ) : growth < 0 ? (
                                <TrendingDown size={12} color="#DC2626" />
                              ) : (
                                <Minus size={12} className="text-text-muted" />
                              )}
                              <span
                                className="font-medium text-xs"
                                style={{ color: getChangeColor(growth) }}
                              >
                                {formatPercent(growth)}
                              </span>
                            </div>
                          </Card>
                        );
                      })}
                  </div>
                </motion.div>

                {/* Two charts side by side: Donut + Monthly Bar */}
                <motion.div variants={detailReveal} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Donut: Platform Sales Share */}
                  <ChartCard
                    title={language === 'ko' ? '누적 플랫폼별 매출 비중' : '累計PF別売上シェア'}
                    subtitle={
                      language === 'ko'
                        ? `전체 기간 누적 · 총 ${formatSales(selectedTitleData.totalSales, currency, exchangeRate, language)}`
                        : `全期間累計 · 合計 ${formatSales(selectedTitleData.totalSales, currency, exchangeRate, language)}`
                    }
                    variant="glass"
                  >
                    <ResponsiveContainer width="100%" height={240}>
                      <PieChart>
                        <Pie
                          data={platformShareData}
                          cx="50%"
                          cy="50%"
                          innerRadius={55}
                          outerRadius={95}
                          dataKey="sales"
                          nameKey="name"
                          paddingAngle={3}
                        >
                          {platformShareData.map((entry, idx) => (
                            <Cell
                              key={idx}
                              fill={platformColorMap[entry.name] || CHART_COLORS[idx % CHART_COLORS.length]}
                              stroke="#ffffff"
                              strokeWidth={2}
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          {...tooltipStyle}
                          formatter={(value: any, name: any) => [
                            formatSales(value, currency, exchangeRate, language),
                            name,
                          ]}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 mt-3">
                      {platformShareData.map((entry) => (
                        <div key={entry.name} className="flex items-center gap-1.5">
                          <PlatformIcon name={entry.name} size={18} />
                          <span className="text-text-secondary text-xs font-medium">
                            {entry.name}
                          </span>
                          <span className="text-text-muted text-xs">
                            {entry.percent.toFixed(1)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </ChartCard>

                  {/* Monthly Sales Bar Chart */}
                  <ChartCard
                    title={language === 'ko' ? '월별 매출 추이' : '月別売上推移'}
                    subtitle={
                      language === 'ko'
                        ? `전체 플랫폼 합산 · ${monthlyTrendData.length}개월`
                        : `全PF合計 · ${monthlyTrendData.length}ヶ月`
                    }
                    variant="glass"
                  >
                    <ResponsiveContainer width="100%" height={280}>
                      <BarChart data={monthlyTrendData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis
                          dataKey="label"
                          stroke="#CBD5E1"
                          tick={{ fill: '#64748B', fontSize: 12 }}
                        />
                        <YAxis
                          stroke="#CBD5E1"
                          tick={{ fill: '#64748B', fontSize: 12 }}
                          tickFormatter={(v: any) => formatSalesShort(v)}
                        />
                        <Tooltip
                          {...tooltipStyle}
                          formatter={(value: any) => [
                            formatSales(value, currency, exchangeRate, language),
                            language === 'ko' ? '매출' : '売上',
                          ]}
                        />
                        <Bar dataKey="sales" fill="#2563EB" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartCard>
                </motion.div>

                {/* Weekly Platform Trend - Multi-line Chart */}
                <motion.div variants={detailReveal}>
                  <ChartCard
                    title={language === 'ko' ? '플랫폼별 주간 매출 추이' : 'PF別週間売上推移'}
                    subtitle={
                      language === 'ko'
                        ? `거래액 기준 (엔) · ${weeklyPlatformTrend.data.length}주간`
                        : `取引額基準 (円) · ${weeklyPlatformTrend.data.length}週間`
                    }
                    variant="glass"
                  >
                    <ResponsiveContainer width="100%" height={350}>
                      <LineChart data={weeklyPlatformTrend.data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                        <XAxis
                          dataKey="label"
                          stroke="#CBD5E1"
                          tick={{ fill: '#64748B', fontSize: 11 }}
                          interval={Math.max(0, Math.floor(weeklyPlatformTrend.data.length / 10))}
                        />
                        <YAxis
                          stroke="#CBD5E1"
                          tick={{ fill: '#64748B', fontSize: 12 }}
                          tickFormatter={(v: any) => formatSalesShort(v)}
                        />
                        <Tooltip
                          {...tooltipStyle}
                          formatter={(value: any, name: any) => [
                            formatSales(value, currency, exchangeRate, language),
                            name,
                          ]}
                        />
                        <Legend content={() => null} />
                        {weeklyPlatformTrend.platforms.map((platform, idx) => (
                          <Line
                            key={platform}
                            type="monotone"
                            dataKey={platform}
                            stroke={platformColorMap[platform] || CHART_COLORS[idx % CHART_COLORS.length]}
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 4 }}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                    <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 mt-2 px-2">
                      {weeklyPlatformTrend.platforms.map((platform) => (
                        <div key={platform} className="flex items-center gap-1.5">
                          <PlatformIcon name={platform} size={16} />
                          <span className="text-text-secondary text-xs font-medium">{platform}</span>
                        </div>
                      ))}
                    </div>
                  </ChartCard>
                </motion.div>
              </motion.div>
            </AnimatePresence>
          ) : (
            /* Empty state */
            <Card
              variant="glass"
              className="flex items-center justify-center h-full min-h-[400px]"
            >
              <div className="text-center">
                <BarChart3 size={48} className="mx-auto mb-4 text-border" />
                <p className="font-semibold text-muted-foreground text-base">
                  {language === 'ko' ? '작품을 선택하세요' : '作品を選択してください'}
                </p>
              </div>
            </Card>
          )}
        </ScrollArea>
      </div>
      )}
    </motion.div>
  );
}
