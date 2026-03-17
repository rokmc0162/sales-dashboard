// ---------------------------------------------------------------------------
// InitialSalesView — 초동매출 분석 탭 (inside TitleAnalysis)
// ---------------------------------------------------------------------------
import { useState, useMemo, useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Cell,
} from 'recharts';
import { Search, TrendingUp, Hash, Trophy, BarChart3, Upload } from 'lucide-react';
import { useInitialSales } from '@/hooks/useInitialSales';
import { useAppState } from '@/hooks/useAppState';
import { t } from '@/i18n';
import { formatSales, formatSalesShort } from '@/utils/formatters';
import { Card } from '@/components/ui/card';
import { ChartCard } from '@/components/ui/chart-card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { CHART_COLORS, tooltipStyle, staggerContainer, staggerItem } from '@/lib/constants';
import type { InitialSaleDaily, InitialSaleWeekly } from '@/types/initialSales';

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_COMPARE = 8;
const AUTO_SELECT_COUNT = 5;

const LAUNCH_TYPE_COLORS: Record<string, string> = {
  '독점': '#2563EB',
  '선행': '#7C3AED',
  '비독점': '#16A34A',
  '2차선행': '#0891B2',
  '듀얼': '#D97706',
  '선행 듀얼': '#DB2777',
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

type SortKey = 'total' | 'day1' | 'launchDate' | 'title' | 'platform';
type SortDir = 'asc' | 'desc';

/** Unique key for a row — must include launchDate to distinguish duplicate title+platform */
function rowKey(r: { titleKR: string; platform: string; launchDate: string }) {
  return `${r.titleKR}|${r.platform}|${r.launchDate}`;
}

/** Short display name for chart legend */
function shortName(r: { titleKR: string; platform: string }) {
  const name = r.titleKR.length > 10 ? r.titleKR.slice(0, 10) + '…' : r.titleKR;
  return `${name} (${r.platform})`;
}

function getUnique<T extends InitialSaleDaily | InitialSaleWeekly>(data: T[], key: keyof T): string[] {
  const set = new Set<string>();
  for (const d of data) {
    const v = String(d[key] ?? '').trim();
    if (v) set.add(v);
  }
  return [...set].sort();
}

/* ------------------------------------------------------------------ */
/*  Loading skeleton                                                   */
/* ------------------------------------------------------------------ */

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map(i => (
          <Skeleton key={i} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-12 rounded-lg" />
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Empty state                                                        */
/* ------------------------------------------------------------------ */

function EmptyState({ language }: { language: 'ko' | 'ja' }) {
  return (
    <Card variant="glass" className="flex flex-col items-center justify-center py-20 text-center">
      <Upload size={48} className="text-muted-foreground mb-4" strokeWidth={1.2} />
      <p className="text-lg font-semibold text-foreground mb-2">
        {language === 'ko' ? '초동매출 데이터가 없습니다' : '初動売上データがありません'}
      </p>
      <p className="text-sm text-muted-foreground max-w-md">
        {language === 'ko'
          ? '"초동매출" Excel 파일을 업로드하면 런칭 초기 매출 추이를 분석할 수 있습니다.'
          : '「初動売上」Excelファイルをアップロードすると、配信初期の売上推移を分析できます。'}
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function InitialSalesView() {
  const { language, currency, exchangeRate } = useAppState();
  const { data, loading } = useInitialSales();

  // View mode
  const [viewMode, setViewMode] = useState<'daily' | 'weekly'>('daily');

  // Filters
  const [search, setSearch] = useState('');
  const [platformFilter, setPlatformFilter] = useState('');
  const [genreFilter, setGenreFilter] = useState('');
  const [launchTypeFilter, setLaunchTypeFilter] = useState('');

  // Sort
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Title comparison selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // ---------- derived data ----------

  const dailyData = data?.daily ?? [];
  const weeklyData = data?.weekly ?? [];
  const dataset = viewMode === 'daily' ? dailyData : weeklyData;

  // Unique filter options (always from daily — it has the most data)
  const platforms = useMemo(() => getUnique(dailyData, 'platform'), [dailyData]);
  const genres = useMemo(() => getUnique(dailyData, 'genre'), [dailyData]);
  const launchTypes = useMemo(() => getUnique(dailyData, 'launchType'), [dailyData]);

  // Filtered data
  const filtered = useMemo(() => {
    let d = [...dataset];
    if (search) {
      const q = search.toLowerCase();
      d = d.filter(r => r.titleKR.toLowerCase().includes(q));
    }
    if (platformFilter) d = d.filter(r => r.platform === platformFilter);
    if (genreFilter) d = d.filter(r => r.genre === genreFilter);
    if (launchTypeFilter) d = d.filter(r => r.launchType === launchTypeFilter);
    return d;
  }, [dataset, search, platformFilter, genreFilter, launchTypeFilter]);

  // Sorted data
  const sorted = useMemo(() => {
    const arr = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      switch (sortKey) {
        case 'total': return (a.total - b.total) * dir;
        case 'day1': {
          const aVal = 'days' in a ? (a as InitialSaleDaily).days[0] : (a as InitialSaleWeekly).weeks[0];
          const bVal = 'days' in b ? (b as InitialSaleDaily).days[0] : (b as InitialSaleWeekly).weeks[0];
          return (aVal - bVal) * dir;
        }
        case 'launchDate': return a.launchDate.localeCompare(b.launchDate) * dir;
        case 'title': return a.titleKR.localeCompare(b.titleKR) * dir;
        case 'platform': return a.platform.localeCompare(b.platform) * dir;
        default: return 0;
      }
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  // ★ Auto-select top N whenever filtered/sorted changes
  useEffect(() => {
    const top = sorted.slice(0, AUTO_SELECT_COUNT);
    const autoKeys = new Set(top.map(r => rowKey(r)));
    setSelected(autoKeys);
  }, [sorted]);

  // KPIs
  const kpis = useMemo(() => {
    if (filtered.length === 0) return null;
    const avgFirst = viewMode === 'daily'
      ? filtered.reduce((s, r) => s + ((r as InitialSaleDaily).days?.[0] ?? 0), 0) / filtered.length
      : filtered.reduce((s, r) => s + ((r as InitialSaleWeekly).weeks?.[0] ?? 0), 0) / filtered.length;
    const avgTotal = filtered.reduce((s, r) => s + r.total, 0) / filtered.length;
    const best = filtered.reduce((max, r) => r.total > max.total ? r : max, filtered[0]);
    return { count: filtered.length, avgFirst, avgTotal, best };
  }, [filtered, viewMode]);

  // Comparison chart data — based on selected keys
  const comparisonData = useMemo(() => {
    const selectedItems = sorted.filter(r => selected.has(rowKey(r)));
    if (selectedItems.length === 0) return [];

    if (viewMode === 'daily') {
      return Array.from({ length: 8 }, (_, i) => {
        const point: Record<string, unknown> = { label: `Day${i + 1}` };
        for (const item of selectedItems) {
          point[shortName(item)] = (item as InitialSaleDaily).days[i];
        }
        return point;
      });
    }

    return Array.from({ length: 12 }, (_, i) => {
      const point: Record<string, unknown> = { label: `W${i + 1}` };
      for (const item of selectedItems) {
        point[shortName(item)] = (item as InitialSaleWeekly).weeks[i];
      }
      return point;
    });
  }, [sorted, selected, viewMode]);

  const comparisonKeys = useMemo(() => {
    if (comparisonData.length === 0) return [];
    return Object.keys(comparisonData[0]).filter(k => k !== 'label');
  }, [comparisonData]);

  // Genre analysis
  const genreStats = useMemo(() => {
    const map = new Map<string, { total: number; count: number; first: number }>();
    for (const r of filtered) {
      const existing = map.get(r.genre) ?? { total: 0, count: 0, first: 0 };
      const firstVal = viewMode === 'daily'
        ? (r as InitialSaleDaily).days[0]
        : (r as InitialSaleWeekly).weeks[0];
      map.set(r.genre, {
        total: existing.total + r.total,
        count: existing.count + 1,
        first: existing.first + firstVal,
      });
    }
    return [...map.entries()]
      .map(([genre, s]) => ({ genre, avgTotal: s.total / s.count, avgFirst: s.first / s.count, count: s.count }))
      .sort((a, b) => b.avgTotal - a.avgTotal);
  }, [filtered, viewMode]);

  // Genre × LaunchType matrix
  const genreLaunchStats = useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const r of filtered) {
      const key = `${r.genre}|${r.launchType}`;
      const existing = map.get(key) ?? { total: 0, count: 0 };
      map.set(key, { total: existing.total + r.total, count: existing.count + 1 });
    }
    const topGenres = genreStats.slice(0, 8).map(g => g.genre);
    return topGenres.map(genre => {
      const point: Record<string, unknown> = { genre };
      for (const lt of launchTypes) {
        const entry = map.get(`${genre}|${lt}`);
        point[lt] = entry ? Math.round(entry.total / entry.count) : 0;
      }
      return point;
    });
  }, [filtered, genreStats, launchTypes]);

  // ---------- handlers ----------

  const toggleSelect = useCallback((r: { titleKR: string; platform: string; launchDate: string }) => {
    const key = rowKey(r);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        if (next.size >= MAX_COMPARE) return prev;
        next.add(key);
      }
      return next;
    });
  }, []);

  const toggleSort = useCallback((key: SortKey) => {
    setSortKey(prev => {
      if (prev === key) {
        setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        return key;
      }
      setSortDir('desc');
      return key;
    });
  }, []);

  const fmt = useCallback((v: number) => formatSales(v, currency, exchangeRate, language), [currency, exchangeRate, language]);

  // ---------- render ----------

  if (loading) return <LoadingSkeleton />;
  if (!data || (dailyData.length === 0 && weeklyData.length === 0)) {
    return <EmptyState language={language} />;
  }

  const hasWeekly = weeklyData.length > 0;
  const periodLabels = viewMode === 'daily'
    ? Array.from({ length: 8 }, (_, i) => `Day${i + 1}`)
    : Array.from({ length: 12 }, (_, i) => `W${i + 1}`);

  return (
    <motion.div initial="hidden" animate="show" variants={staggerContainer} className="space-y-6">

      {/* ── KPI Cards ── */}
      <motion.div variants={staggerItem} className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card variant="glass" className="p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium mb-1">
            <Hash size={14} />
            {t(language, 'initialSales.totalTitles')}
          </div>
          <p className="text-2xl font-bold text-foreground">{kpis?.count ?? 0}</p>
        </Card>
        <Card variant="glass" className="p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium mb-1">
            <TrendingUp size={14} />
            {t(language, 'initialSales.avgDay1')}
          </div>
          <p className="text-2xl font-bold text-foreground">{kpis ? fmt(kpis.avgFirst) : '-'}</p>
        </Card>
        <Card variant="glass" className="p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium mb-1">
            <BarChart3 size={14} />
            {t(language, 'initialSales.avgTotal')}
          </div>
          <p className="text-2xl font-bold text-foreground">{kpis ? fmt(kpis.avgTotal) : '-'}</p>
        </Card>
        <Card variant="glass" className="p-4">
          <div className="flex items-center gap-2 text-muted-foreground text-xs font-medium mb-1">
            <Trophy size={14} />
            {t(language, 'initialSales.bestTitle')}
          </div>
          <p className="text-sm font-bold text-foreground truncate">{kpis?.best.titleKR ?? '-'}</p>
          <p className="text-xs text-muted-foreground">{kpis ? fmt(kpis.best.total) : ''}</p>
        </Card>
      </motion.div>

      {/* ── Filter bar ── */}
      <motion.div variants={staggerItem}>
        <Card variant="glass" className="p-4">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[200px] max-w-[320px]">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={t(language, 'filter.search')}
                className="pl-9 h-9"
              />
            </div>
            <Select value={platformFilter} onChange={e => setPlatformFilter(e.target.value)} className="h-9 min-w-[140px]">
              <option value="">{language === 'ko' ? '전체 플랫폼' : '全PF'}</option>
              {platforms.map(p => <option key={p} value={p}>{p}</option>)}
            </Select>
            <Select value={genreFilter} onChange={e => setGenreFilter(e.target.value)} className="h-9 min-w-[120px]">
              <option value="">{language === 'ko' ? '전체 장르' : '全ジャンル'}</option>
              {genres.map(g => <option key={g} value={g}>{g}</option>)}
            </Select>
            <Select value={launchTypeFilter} onChange={e => setLaunchTypeFilter(e.target.value)} className="h-9 min-w-[130px]">
              <option value="">{language === 'ko' ? '전체 런칭형태' : '全配信形態'}</option>
              {launchTypes.map(lt => <option key={lt} value={lt}>{lt}</option>)}
            </Select>
            {hasWeekly && (
              <Tabs defaultValue="daily" value={viewMode} onValueChange={v => setViewMode(v as 'daily' | 'weekly')}>
                <TabsList className="h-9">
                  <TabsTrigger value="daily" className="text-xs px-3">{t(language, 'initialSales.daily')}</TabsTrigger>
                  <TabsTrigger value="weekly" className="text-xs px-3">{t(language, 'initialSales.weekly')}</TabsTrigger>
                </TabsList>
              </Tabs>
            )}
          </div>
        </Card>
      </motion.div>

      {/* ── Comparison Chart ── */}
      <motion.div variants={staggerItem}>
        <ChartCard
          title={viewMode === 'daily'
            ? t(language, 'initialSales.dailyComparison')
            : t(language, 'initialSales.weeklyComparison')}
          subtitle={selected.size > 0
            ? `${selected.size}${language === 'ko' ? '개 작품 비교' : '作品比較'}`
            : t(language, 'initialSales.selectToCompare')}
          variant="glass"
        >
          {comparisonData.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={comparisonData} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={formatSalesShort} width={60} />
                <Tooltip
                  {...tooltipStyle}
                  formatter={(value: any) => [fmt(value), '']}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {comparisonKeys.map((key, i) => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    stroke={CHART_COLORS[i % CHART_COLORS.length]}
                    strokeWidth={2.5}
                    dot={{ r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-[300px] text-muted-foreground text-sm">
              {t(language, 'initialSales.selectToCompare')}
            </div>
          )}
        </ChartCard>
      </motion.div>

      {/* ── Data Table ── */}
      <motion.div variants={staggerItem}>
        <Card variant="glass">
          <div className="px-4 pt-4 pb-2 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {sorted.length}{language === 'ko' ? '개 작품' : '作品'}
              {selected.size > 0 && (
                <span className="ml-2 text-primary font-medium">
                  ({selected.size}/{MAX_COMPARE} {t(language, 'initialSales.compare')})
                </span>
              )}
            </p>
          </div>
          <div className="overflow-x-auto max-h-[500px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="w-10 text-center">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={selected.size > 0 && selected.size === Math.min(sorted.length, MAX_COMPARE)}
                      onChange={() => {
                        if (selected.size > 0) {
                          setSelected(new Set());
                        } else {
                          const next = new Set<string>();
                          for (let i = 0; i < Math.min(sorted.length, MAX_COMPARE); i++) {
                            next.add(rowKey(sorted[i]));
                          }
                          setSelected(next);
                        }
                      }}
                    />
                  </TableHead>
                  <TableHead
                    className="cursor-pointer hover:text-primary min-w-[180px]"
                    onClick={() => toggleSort('title')}
                  >
                    {t(language, 'table.title')} {sortKey === 'title' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </TableHead>
                  <TableHead
                    className="cursor-pointer hover:text-primary"
                    onClick={() => toggleSort('platform')}
                  >
                    PF {sortKey === 'platform' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </TableHead>
                  <TableHead>{language === 'ko' ? '장르' : 'ジャンル'}</TableHead>
                  <TableHead>{t(language, 'initialSales.launchType')}</TableHead>
                  <TableHead
                    className="cursor-pointer hover:text-primary"
                    onClick={() => toggleSort('launchDate')}
                  >
                    {t(language, 'initialSales.launchDate')} {sortKey === 'launchDate' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </TableHead>
                  {periodLabels.map((label, idx) => (
                    <TableHead
                      key={label}
                      className={`text-right text-xs ${idx === 0 ? 'cursor-pointer hover:text-primary' : ''} ${idx === 0 && sortKey === 'day1' ? 'text-primary' : ''}`}
                      onClick={() => idx === 0 ? toggleSort('day1') : undefined}
                    >
                      {label}
                    </TableHead>
                  ))}
                  <TableHead
                    className="text-right cursor-pointer hover:text-primary font-bold"
                    onClick={() => toggleSort('total')}
                  >
                    {language === 'ko' ? '합계' : '合計'} {sortKey === 'total' ? (sortDir === 'asc' ? '↑' : '↓') : ''}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((row) => {
                  const rk = rowKey(row);
                  const isSelected = selected.has(rk);
                  const periods = viewMode === 'daily'
                    ? (row as InitialSaleDaily).days
                    : (row as InitialSaleWeekly).weeks;

                  return (
                    <TableRow
                      key={rk}
                      className={`cursor-pointer transition-colors ${isSelected ? 'bg-primary/5' : 'hover:bg-muted/50'}`}
                      onClick={() => toggleSelect(row)}
                    >
                      <TableCell className="text-center">
                        <input
                          type="checkbox"
                          className="accent-primary"
                          checked={isSelected}
                          onChange={() => toggleSelect(row)}
                          onClick={e => e.stopPropagation()}
                        />
                      </TableCell>
                      <TableCell className="font-medium max-w-[200px] truncate" title={row.titleKR}>
                        {row.titleKR}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs whitespace-nowrap">
                          {row.platform}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{row.genre}</TableCell>
                      <TableCell>
                        <span
                          className="inline-block px-2 py-0.5 rounded-full text-xs font-medium text-white"
                          style={{ backgroundColor: LAUNCH_TYPE_COLORS[row.launchType] ?? '#94a3b8' }}
                        >
                          {row.launchType}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{row.launchDate}</TableCell>
                      {periods.map((val, idx) => (
                        <TableCell key={idx} className="text-right text-xs tabular-nums">
                          {val > 0 ? formatSalesShort(val) : '-'}
                        </TableCell>
                      ))}
                      <TableCell className="text-right font-bold tabular-nums">
                        {formatSalesShort(row.total)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      </motion.div>

      {/* ── Genre Analysis ── */}
      <motion.div variants={staggerItem} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Genre average initial sales */}
        <ChartCard
          title={t(language, 'initialSales.avgByGenre')}
          subtitle={`${genreStats.length}${language === 'ko' ? '개 장르' : 'ジャンル'}`}
          variant="glass"
        >
          <ResponsiveContainer width="100%" height={320}>
            <BarChart
              data={genreStats.slice(0, 12)}
              layout="vertical"
              margin={{ top: 4, right: 16, bottom: 0, left: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" horizontal={false} />
              <XAxis type="number" tickFormatter={formatSalesShort} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="genre" width={80} tick={{ fontSize: 11 }} />
              <Tooltip
                {...tooltipStyle}
                formatter={(value: any, name: any) => {
                  const label = name === 'avgTotal'
                    ? (language === 'ko' ? '평균 합계' : '平均合計')
                    : (language === 'ko' ? '평균 첫날' : '平均初日');
                  return [fmt(value), label];
                }}
              />
              <Bar dataKey="avgTotal" radius={[0, 6, 6, 0]} barSize={18}>
                {genreStats.slice(0, 12).map((_, i) => (
                  <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Genre × Launch Type grouped bar */}
        <ChartCard
          title={t(language, 'initialSales.genreLaunchType')}
          subtitle={language === 'ko' ? '상위 장르 × 런칭형태별 평균 초동' : '上位ジャンル×配信形態別平均初動'}
          variant="glass"
        >
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={genreLaunchStats} margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
              <XAxis dataKey="genre" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" height={50} />
              <YAxis tickFormatter={formatSalesShort} tick={{ fontSize: 11 }} />
              <Tooltip
                {...tooltipStyle}
                formatter={(value: any, name: any) => [fmt(value), name]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {launchTypes.filter(lt => ['독점', '선행', '비독점', '2차선행'].includes(lt)).map(lt => (
                <Bar
                  key={lt}
                  dataKey={lt}
                  fill={LAUNCH_TYPE_COLORS[lt] ?? '#94a3b8'}
                  radius={[4, 4, 0, 0]}
                  barSize={14}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </motion.div>
    </motion.div>
  );
}
