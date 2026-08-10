'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ReTooltip,
  Legend, AreaChart, Area, ResponsiveContainer,
} from 'recharts';
import {
  Rocket, Search, X, Check, BarChart3, ChevronDown, ChevronUp,
} from 'lucide-react';
import {
  fetchTitleDailySales,
  fetchTitleMaster,
  fetchTitleSummaries,
} from '@/lib/supabase';
import { PlatformBadge } from '@/components/PlatformBadge';
import { useApp } from '@/context/AppContext';
import { format, parseISO, addDays } from 'date-fns';

// ============================================================
// Types
// ============================================================

interface TitleSummary {
  title_jp: string;
  title_kr: string | null;
  channels: string[];
  firstDate: string;
  totalSales: number;
  dayCount: number;
  genre: string | null;
  company: string | null;
}

interface DayPoint {
  day: number;
  date: string;
  sales: number;
}

interface WeekPoint {
  week: number;
  sales: number;
}

interface SelectedTitle {
  title_jp: string;
  title_kr: string | null;
  color: string;
  dailyData: DayPoint[];
  weeklyData: WeekPoint[];
  total28d: number;
}

interface TitleDailySalesRow {
  sale_date: string;
  daily_total: number;
}

// ============================================================
// Constants
// ============================================================

const GLASS_CARD = {
  background: 'var(--color-glass)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid var(--color-glass-border)',
  borderRadius: '16px',
} as const;

const containerVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.03 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
};

const darkTooltipStyle = {
  contentStyle: {
    backgroundColor: 'var(--color-tooltip-bg)',
    border: '1px solid var(--color-tooltip-border)',
    borderRadius: '12px',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.35)',
    padding: '14px 18px',
  },
  labelStyle: { color: 'var(--color-tooltip-label)', fontWeight: 600, fontSize: '12px', marginBottom: '6px' },
  itemStyle: { color: 'var(--color-tooltip-value)', fontWeight: 700, fontSize: '14px' },
};

const CHART_COLORS = [
  '#3B6FF6', '#f472b6', '#34d399', '#fbbf24',
  '#f87171', '#60a5fa', '#a78bfa', '#fb923c',
  '#2dd4bf', '#e879f9',
];

// ============================================================
// Helpers
// ============================================================

function formatYenShort(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}億`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(0)}万`;
  return value.toLocaleString();
}

function displayTitle(jp: string, kr: string | null): string {
  if (kr) return `${kr} (${jp.length > 15 ? jp.slice(0, 15) + '…' : jp})`;
  return jp.length > 25 ? jp.slice(0, 25) + '…' : jp;
}

function Skeleton() {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl p-6 animate-pulse" style={GLASS_CARD}>
        <div className="h-4 w-48 rounded skeleton-shimmer mb-6" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex gap-4 py-3">
            <div className="h-4 w-6 rounded skeleton-shimmer" />
            <div className="h-4 flex-1 rounded skeleton-shimmer" />
            <div className="h-4 w-20 rounded skeleton-shimmer" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Main Component
// ============================================================

export default function InitialSalesPage() {
  const { formatCurrency, t } = useApp();

  const [loading, setLoading] = useState(true);
  const [titles, setTitles] = useState<TitleSummary[]>([]);
  const [search, setSearch] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [genreFilter, setGenreFilter] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [sortKey, setSortKey] = useState<'totalSales' | 'firstDate' | 'dayCount' | 'channelCount'>('totalSales');
  const [sortAsc, setSortAsc] = useState(false);
  const [checkedTitles, setCheckedTitles] = useState<Set<string>>(new Set());
  const [selectedData, setSelectedData] = useState<SelectedTitle[]>([]);
  const [loadingCurves, setLoadingCurves] = useState(false);
  const [viewMode, setViewMode] = useState<'daily' | 'weekly'>('daily');
  const [chartType, setChartType] = useState<'line' | 'area'>('area');

  useEffect(() => {
    async function loadTitles() {
      setLoading(true);
      const [summaryData, masterData] = await Promise.all([
        fetchTitleSummaries(),
        fetchTitleMaster(),
      ]);

      const masterMap = new Map<string, { genre: string | null; company: string | null }>();
      for (const m of masterData) {
        masterMap.set(m.title_jp, { genre: m.genre, company: m.company });
      }

      const result: TitleSummary[] = summaryData.map((row: { title_jp: string; title_kr: string | null; channels: string[]; first_date: string; total_sales: number; day_count: number }) => {
        const master = masterMap.get(row.title_jp);
        return {
          title_jp: row.title_jp,
          title_kr: row.title_kr,
          channels: row.channels ?? [],
          firstDate: row.first_date,
          totalSales: row.total_sales,
          dayCount: row.day_count,
          genre: master?.genre ?? null,
          company: master?.company ?? null,
        };
      });

      setTitles(result);
      setLoading(false);
    }
    loadTitles();
  }, []);

  const channels = useMemo(() => {
    const set = new Set<string>();
    for (const t of titles) t.channels.forEach((c) => set.add(c));
    return Array.from(set).sort();
  }, [titles]);

  const genres = useMemo(() => {
    const set = new Set<string>();
    for (const t of titles) if (t.genre) set.add(t.genre);
    return Array.from(set).sort();
  }, [titles]);

  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const t of titles) if (t.company) set.add(t.company);
    return Array.from(set).sort();
  }, [titles]);

  const filteredTitles = useMemo(() => {
    let list = titles;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter((t) => t.title_jp.toLowerCase().includes(q) || (t.title_kr && t.title_kr.toLowerCase().includes(q)));
    }
    if (channelFilter) list = list.filter((t) => t.channels.includes(channelFilter));
    if (genreFilter) list = list.filter((t) => t.genre === genreFilter);
    if (companyFilter) list = list.filter((t) => t.company === companyFilter);
    list = [...list].sort((a, b) => {
      let va: number | string, vb: number | string;
      if (sortKey === 'firstDate') { va = a.firstDate; vb = b.firstDate; }
      else if (sortKey === 'channelCount') { va = a.channels.length; vb = b.channels.length; }
      else { va = a[sortKey]; vb = b[sortKey]; }
      if (va < vb) return sortAsc ? -1 : 1;
      if (va > vb) return sortAsc ? 1 : -1;
      return 0;
    });
    return list;
  }, [titles, search, channelFilter, genreFilter, companyFilter, sortKey, sortAsc]);

  const activeFilterCount = [channelFilter, genreFilter, companyFilter].filter(Boolean).length;

  const toggleTitle = useCallback((titleJP: string) => {
    setCheckedTitles((prev) => {
      const next = new Set(prev);
      if (next.has(titleJP)) next.delete(titleJP);
      else if (next.size < 10) next.add(titleJP);
      return next;
    });
  }, []);

  const loadCurves = useCallback(async () => {
    if (checkedTitles.size === 0) return;
    setLoadingCurves(true);
    const titleList = Array.from(checkedTitles);
    const promises = titleList.map(async (titleJP, idx) => {
      const rows = await fetchTitleDailySales(titleJP) as TitleDailySalesRow[];
      if (rows.length === 0) return null;
      const titleInfo = titles.find((t) => t.title_jp === titleJP);
      const firstDate = parseISO(rows[0].sale_date);
      const dateMap = new Map<string, number>();
      for (const row of rows) dateMap.set(row.sale_date, row.daily_total);
      const dailyData: DayPoint[] = [];
      for (let d = 0; d < 28; d++) {
        const date = addDays(firstDate, d);
        const dateStr = format(date, 'yyyy-MM-dd');
        dailyData.push({ day: d + 1, date: dateStr, sales: dateMap.get(dateStr) ?? 0 });
      }
      const weeklyData: WeekPoint[] = [];
      for (let w = 0; w < 4; w++) {
        let weekTotal = 0;
        for (let d = w * 7; d < (w + 1) * 7; d++) weekTotal += dailyData[d]?.sales ?? 0;
        weeklyData.push({ week: w + 1, sales: weekTotal });
      }
      const total28d = dailyData.reduce((s, p) => s + p.sales, 0);
      return {
        title_jp: titleJP,
        title_kr: titleInfo?.title_kr ?? null,
        color: CHART_COLORS[idx % CHART_COLORS.length],
        dailyData, weeklyData, total28d,
      } as SelectedTitle;
    });
    const settled = await Promise.allSettled(promises);
    const results: SelectedTitle[] = [];
    for (const r of settled) { if (r.status === 'fulfilled' && r.value) results.push(r.value); }
    setSelectedData(results);
    setLoadingCurves(false);
  }, [checkedTitles, titles]);

  const chartData = useMemo(() => {
    if (selectedData.length === 0) return [];
    if (viewMode === 'daily') {
      return Array.from({ length: 28 }, (_, i) => {
        const point: Record<string, string | number> = { label: `D${i + 1}` };
        for (const sel of selectedData) {
          const key = sel.title_kr || sel.title_jp.slice(0, 12);
          point[key] = sel.dailyData[i]?.sales ?? 0;
        }
        return point;
      });
    } else {
      return Array.from({ length: 4 }, (_, i) => {
        const point: Record<string, string | number> = { label: `W${i + 1}` };
        for (const sel of selectedData) {
          const key = sel.title_kr || sel.title_jp.slice(0, 12);
          point[key] = sel.weeklyData[i]?.sales ?? 0;
        }
        return point;
      });
    }
  }, [selectedData, viewMode]);

  const cumulativeData = useMemo(() => {
    if (selectedData.length === 0) return [];
    return Array.from({ length: 28 }, (_, i) => {
      const point: Record<string, string | number> = { label: `D${i + 1}` };
      for (const sel of selectedData) {
        const key = sel.title_kr || sel.title_jp.slice(0, 12);
        let cumul = 0;
        for (let d = 0; d <= i; d++) cumul += sel.dailyData[d]?.sales ?? 0;
        point[key] = cumul;
      }
      return point;
    });
  }, [selectedData]);

  function handleSort(key: typeof sortKey) {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(false); }
  }

  const renderSortIcon = (col: typeof sortKey) =>
    sortKey === col ? (sortAsc ? <ChevronUp size={14} className="inline" /> : <ChevronDown size={14} className="inline" />) : null;

  if (loading) return <Skeleton />;

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="show" className="space-y-6">
      {/* Header */}
      <motion.div variants={cardVariants} className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-orange-500 to-pink-500 flex items-center justify-center" style={{ boxShadow: '0 4px 16px rgba(249, 115, 22, 0.4), 0 0 40px rgba(249, 115, 22, 0.15)' }}>
          <Rocket size={22} className="text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text-primary)]">{t('초동매출 비교', '初動売上比較')}</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">{t('런칭일 기준 4주간 매출 비교 분석', 'ローンチ日基準4週間売上比較分析')}</p>
        </div>
      </motion.div>

      {/* Search & Filters */}
      <motion.div variants={cardVariants} className="rounded-2xl p-5" style={GLASS_CARD}>
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input
            type="text"
            placeholder={t('작품명 검색 (JP/KR)...', 'タイトル検索 (JP/KR)...')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-[var(--color-input-bg)] border border-[var(--color-input-border)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:border-[#1A2B5E]/50 placeholder:text-[var(--color-text-muted)]"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
              <X size={14} />
            </button>
          )}
        </div>

        <div className="mt-4 pt-4 grid grid-cols-1 sm:grid-cols-3 gap-3" style={{ borderTop: '1px solid var(--color-glass-border)' }}>
          <div>
            <label className="block text-[10px] font-medium mb-1 tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
              {t('플랫폼', 'プラットフォーム')}
            </label>
            <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} className="w-full px-3 py-2 rounded-lg text-xs bg-[var(--color-input-bg)] border border-[var(--color-input-border)] text-[var(--color-text-primary)] focus:outline-none">
              <option value="">{t('전체', 'すべて')}</option>
              {channels.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-medium mb-1 tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
              {t('장르', 'ジャンル')}
            </label>
            <select value={genreFilter} onChange={(e) => setGenreFilter(e.target.value)} className="w-full px-3 py-2 rounded-lg text-xs bg-[var(--color-input-bg)] border border-[var(--color-input-border)] text-[var(--color-text-primary)] focus:outline-none">
              <option value="">{t('전체', 'すべて')}</option>
              {genres.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-medium mb-1 tracking-wide" style={{ color: 'var(--color-text-muted)' }}>
              {t('제작회사', '制作会社')}
            </label>
            <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)} className="w-full px-3 py-2 rounded-lg text-xs bg-[var(--color-input-bg)] border border-[var(--color-input-border)] text-[var(--color-text-primary)] focus:outline-none">
              <option value="">{t('전체', 'すべて')}</option>
              {companies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {activeFilterCount > 0 && (
          <div className="mt-3 flex justify-end">
            <button
              onClick={() => { setChannelFilter(''); setGenreFilter(''); setCompanyFilter(''); }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
              style={{ background: 'rgba(239, 68, 68, 0.08)', color: '#ef4444', border: '1px solid var(--color-input-border)' }}
            >
              {t('필터 초기화', 'フィルターリセット')}
            </button>
          </div>
        )}

        <div className="mt-3 flex items-center gap-3 text-xs text-[var(--color-text-secondary)]">
          <span style={{ color: 'var(--color-text-primary)', fontWeight: 600 }}>{filteredTitles.length}</span>
          <span>{t('개 작품', 'タイトル')}</span>
          {activeFilterCount > 0 && (
            <span style={{ color: 'var(--color-text-muted)' }}>({activeFilterCount}{t('개 필터 적용', 'フィルター適用')})</span>
          )}
          <span>|</span>
          <span style={{ color: '#1A2B5E', fontWeight: 600 }}>{checkedTitles.size}/10 {t('선택됨', '選択中')}</span>
          {checkedTitles.size > 0 && (
            <button
              onClick={loadCurves}
              className="ml-auto px-4 py-1.5 rounded-lg text-white text-xs font-semibold hover:opacity-90 transition-opacity flex items-center gap-1.5"
              style={{ background: '#1A2B5E' }}
            >
              <BarChart3 size={13} />
              {t('비교 시작', '比較開始')} ({checkedTitles.size}{t('개', '件')})
            </button>
          )}
        </div>
      </motion.div>

      {/* Title Selection Table */}
      <motion.div variants={cardVariants} className="rounded-2xl" style={GLASS_CARD}>
        <div style={{ height: '300px', overflow: 'auto', borderRadius: '16px' }}>
          <table className="w-full text-sm table-striped">
            <thead className="sticky top-0 z-10">
              <tr className="text-[var(--color-text-secondary)] text-xs" style={{ background: 'var(--color-tooltip-bg)' }}>
                <th className="px-4 py-3 text-left w-10"></th>
                <th className="px-4 py-3 text-left">{t('작품', 'タイトル')}</th>
                <th className="px-4 py-3 text-left">{t('플랫폼', 'PF')}</th>
                <th className="px-4 py-3 text-right cursor-pointer select-none hover:text-[var(--color-text-primary)]" onClick={() => handleSort('firstDate')}>
                  {t('런칭일', 'ローンチ日')} {renderSortIcon('firstDate')}
                </th>
                <th className="px-4 py-3 text-right cursor-pointer select-none hover:text-[var(--color-text-primary)]" onClick={() => handleSort('totalSales')}>
                  {t('총 매출', '累計売上')} {renderSortIcon('totalSales')}
                </th>
                <th className="px-4 py-3 text-right cursor-pointer select-none hover:text-[var(--color-text-primary)]" onClick={() => handleSort('dayCount')}>
                  {t('데이터일수', 'データ日数')} {renderSortIcon('dayCount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredTitles.slice(0, 30).map((item) => {
                const checked = checkedTitles.has(item.title_jp);
                return (
                  <tr
                    key={item.title_jp}
                    className={`border-t border-[var(--color-glass-border)] cursor-pointer transition-colors ${checked ? 'bg-indigo-500/10' : 'hover:bg-[var(--color-glass)]'}`}
                    onClick={() => toggleTitle(item.title_jp)}
                  >
                    <td className="px-4 py-2.5">
                      <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${checked ? 'bg-indigo-500 border-indigo-500' : 'border-[var(--color-glass-border)] hover:border-[var(--color-glass-border)]0'}`}>
                        {checked && <Check size={12} className="text-white" />}
                      </div>
                    </td>
                    <td className="px-4 py-2.5" style={{ maxWidth: '280px' }}>
                      <div className="text-[var(--color-text-primary)] font-medium text-xs truncate" title={item.title_jp}>
                        {item.title_jp.length > 30 ? item.title_jp.slice(0, 30) + '…' : item.title_jp}
                      </div>
                      {item.title_kr && <div className="text-[var(--color-text-secondary)] text-[11px] truncate" title={item.title_kr}>{item.title_kr}</div>}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {item.channels.slice(0, 3).map((ch) => <PlatformBadge key={ch} name={ch} showName={false} size="sm" />)}
                        {item.channels.length > 3 && <span className="text-[10px] text-[var(--color-text-muted)]">+{item.channels.length - 3}</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-right text-[var(--color-text-secondary)] text-xs">
                      {format(parseISO(item.firstDate), 'yyyy/MM/dd')}
                    </td>
                    <td className="px-4 py-2.5 text-right text-[var(--color-text-primary)] text-xs font-medium">
                      {formatCurrency(item.totalSales)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-[var(--color-text-secondary)] text-xs">
                      {item.dayCount}{t('일', '日')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filteredTitles.length > 30 && (
          <div className="px-4 py-2 text-[11px] text-[var(--color-text-muted)] text-center border-t border-[var(--color-glass-border)]">
            {t(`상위 30개 표시 중 (총 ${filteredTitles.length}개) - 필터로 좁혀보세요`, `上位30件表示中 (全${filteredTitles.length}件) - フィルターで絞り込み`)}
          </div>
        )}
      </motion.div>

      {loadingCurves && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-center py-8">
          <div className="flex items-center gap-3 text-[var(--color-text-secondary)]">
            <div className="w-5 h-5 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
            {t('데이터 로딩 중...', 'データ読み込み中...')}
          </div>
        </motion.div>
      )}

      <AnimatePresence>
        {selectedData.length > 0 && !loadingCurves && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-6">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex rounded-xl overflow-hidden border border-[var(--color-input-border)]">
                {(['daily', 'weekly'] as const).map((mode) => (
                  <button key={mode} onClick={() => setViewMode(mode)} className={`px-4 py-2 text-xs font-medium transition-colors ${viewMode === mode ? 'bg-indigo-500 text-white' : 'bg-[var(--color-glass)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}>
                    {mode === 'daily' ? t('일별', '日別') : t('주별', '週別')}
                  </button>
                ))}
              </div>
              <div className="flex rounded-xl overflow-hidden border border-[var(--color-input-border)]">
                {(['area', 'line'] as const).map((type) => (
                  <button key={type} onClick={() => setChartType(type)} className={`px-4 py-2 text-xs font-medium transition-colors ${chartType === type ? 'bg-purple-500 text-white' : 'bg-[var(--color-glass)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}>
                    {type === 'area' ? 'Area' : 'Line'}
                  </button>
                ))}
              </div>
              <div className="ml-auto flex gap-2 flex-wrap">
                {selectedData.map((sel) => (
                  <span key={sel.title_jp} className="px-2 py-1 rounded-lg text-[11px] font-medium flex items-center gap-1" style={{ backgroundColor: sel.color + '22', color: sel.color }}>
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: sel.color }} />
                    {sel.title_kr || sel.title_jp.slice(0, 10)}
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-2xl p-6" style={GLASS_CARD}>
              <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">
                {viewMode === 'daily' ? t('일별 매출 비교 (런칭일 기준 D1~D28)', '日別売上比較 (ローンチ日基準 D1〜D28)') : t('주별 매출 비교 (W1~W4)', '週別売上比較 (W1〜W4)')}
              </h3>
              {chartType === 'area' ? (
                <ResponsiveContainer width="100%" height={350}>
                  <AreaChart data={chartData}>
                    <defs>
                      {selectedData.map((sel, i) => (
                        <linearGradient key={i} id={`grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={sel.color} stopOpacity={0.3} />
                          <stop offset="95%" stopColor={sel.color} stopOpacity={0} />
                        </linearGradient>
                      ))}
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
                    <XAxis dataKey="label" tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={formatYenShort} width={60} />
                    <ReTooltip {...darkTooltipStyle} formatter={(v: unknown) => [formatCurrency(Number(v ?? 0)), '']} />
                    <Legend wrapperStyle={{ fontSize: 11, color: 'var(--color-text-secondary)' }} />
                    {selectedData.map((sel, i) => {
                      const key = sel.title_kr || sel.title_jp.slice(0, 12);
                      return <Area key={key} type="monotone" dataKey={key} stroke={sel.color} strokeWidth={2} fill={`url(#grad-${i})`} />;
                    })}
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <ResponsiveContainer width="100%" height={350}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
                    <XAxis dataKey="label" tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={formatYenShort} width={60} />
                    <ReTooltip {...darkTooltipStyle} formatter={(v: unknown) => [formatCurrency(Number(v ?? 0)), '']} />
                    <Legend wrapperStyle={{ fontSize: 11, color: 'var(--color-text-secondary)' }} />
                    {selectedData.map((sel) => {
                      const key = sel.title_kr || sel.title_jp.slice(0, 12);
                      return <Line key={key} type="monotone" dataKey={key} stroke={sel.color} strokeWidth={2.5} dot={{ r: 3, fill: sel.color }} activeDot={{ r: 5, stroke: sel.color, strokeWidth: 2, fill: '#0a0a0f' }} />;
                    })}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="rounded-2xl p-6" style={GLASS_CARD}>
              <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">{t('누적 매출 비교 (D1~D28)', '累計売上比較 (D1〜D28)')}</h3>
              <ResponsiveContainer width="100%" height={320}>
                <AreaChart data={cumulativeData}>
                  <defs>
                    {selectedData.map((sel, i) => (
                      <linearGradient key={i} id={`cumGrad-${i}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={sel.color} stopOpacity={0.2} />
                        <stop offset="95%" stopColor={sel.color} stopOpacity={0} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--color-chart-grid)" />
                  <XAxis dataKey="label" tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={formatYenShort} width={60} />
                  <ReTooltip {...darkTooltipStyle} formatter={(v: unknown) => [formatCurrency(Number(v ?? 0)), '']} />
                  <Legend wrapperStyle={{ fontSize: 11, color: 'var(--color-text-secondary)' }} />
                  {selectedData.map((sel, i) => {
                    const key = sel.title_kr || sel.title_jp.slice(0, 12);
                    return <Area key={key} type="monotone" dataKey={key} stroke={sel.color} strokeWidth={2} fill={`url(#cumGrad-${i})`} />;
                  })}
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <div className="rounded-2xl p-6" style={GLASS_CARD}>
              <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">{t('4주 매출 요약', '4週間売上サマリー')}</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm table-striped">
                  <thead>
                    <tr className="text-[var(--color-text-secondary)] text-xs border-b border-[var(--color-table-border)]">
                      <th className="px-3 py-2 text-left">{t('작품', 'タイトル')}</th>
                      <th className="px-3 py-2 text-right">D1</th>
                      <th className="px-3 py-2 text-right">D3</th>
                      <th className="px-3 py-2 text-right">D7</th>
                      <th className="px-3 py-2 text-right">W1</th>
                      <th className="px-3 py-2 text-right">W2</th>
                      <th className="px-3 py-2 text-right">W3</th>
                      <th className="px-3 py-2 text-right">W4</th>
                      <th className="px-3 py-2 text-right font-semibold">{t('28일 합계', '28日合計')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedData.map((sel) => (
                      <tr key={sel.title_jp} className="border-t border-[var(--color-glass-border)] hover:bg-[var(--color-glass)]">
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: sel.color }} />
                            <span className="text-[var(--color-text-primary)] font-medium text-xs">
                              {displayTitle(sel.title_jp, sel.title_kr)}
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-right text-xs text-[var(--color-text-primary)]">
                          {formatCurrency(sel.dailyData[0]?.sales ?? 0)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-xs text-[var(--color-text-primary)]">
                          {formatCurrency(sel.dailyData.slice(0, 3).reduce((s, d) => s + d.sales, 0))}
                        </td>
                        <td className="px-3 py-2.5 text-right text-xs text-[var(--color-text-primary)]">
                          {formatCurrency(sel.dailyData.slice(0, 7).reduce((s, d) => s + d.sales, 0))}
                        </td>
                        {sel.weeklyData.map((w) => (
                          <td key={w.week} className="px-3 py-2.5 text-right text-xs text-[var(--color-text-primary)]">
                            {formatCurrency(w.sales)}
                          </td>
                        ))}
                        <td className="px-3 py-2.5 text-right text-xs font-bold" style={{ color: sel.color }}>
                          {formatCurrency(sel.total28d)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
