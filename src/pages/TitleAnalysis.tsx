import { useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, TrendingUp, TrendingDown, Minus, BarChart3 } from 'lucide-react';
import { useDataLoader } from '../hooks/useDataLoader';
import { useAppState } from '../hooks/useAppState';
import { t } from '../i18n';
import { formatSales, formatSalesShort, formatPercent, getChangeColor } from '../utils/formatters';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

const CHART_COLORS = ['#2563EB', '#7C3AED', '#0891B2', '#16A34A', '#D97706', '#DC2626', '#DB2777', '#0D9488', '#4F46E5', '#EA580C'];

const tooltipStyle = {
  contentStyle: { backgroundColor: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' },
  labelStyle: { color: '#475569', fontWeight: 600 },
  itemStyle: { color: '#0F172A' },
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
};

const staggerItem = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' as const } },
};

const detailReveal = {
  hidden: { opacity: 0, x: 20 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.4, ease: 'easeOut' as const } },
};

type SortKey = 'sales' | 'platforms' | 'name';

export function TitleAnalysis() {
  const { language, currency, exchangeRate } = useAppState();
  const data = useDataLoader();

  const [search, setSearch] = useState('');
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('sales');

  // Build platform → color map (consistent across the page)
  const platformColorMap = useMemo(() => {
    const allPlatforms = new Set<string>();
    data.titleSummary.forEach(ts => ts.platforms.forEach(p => allPlatforms.add(p.name)));
    const map: Record<string, string> = {};
    Array.from(allPlatforms).forEach((name, idx) => {
      map[name] = CHART_COLORS[idx % CHART_COLORS.length];
    });
    return map;
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

    const titleSales = data.dailySales.filter(d => d.titleKR === activeTitleKey);

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
  }, [data.dailySales, activeTitleKey]);

  // Per-platform growth for selected title
  const platformGrowths = useMemo(() => {
    if (!activeTitleKey || !selectedTitleData) return new Map<string, number>();

    const titleSales = data.dailySales.filter(d => d.titleKR === activeTitleKey);
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
  }, [data.dailySales, activeTitleKey, selectedTitleData]);

  const titleName = (ts: { titleKR: string; titleJP: string }) =>
    language === 'ko' ? ts.titleKR : ts.titleJP;

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------
  if (data.loading) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: '400px' }}>
        <div className="animate-spin rounded-full h-10 w-10 border-b-2" style={{ borderColor: '#2563EB' }} />
      </div>
    );
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
    <motion.div initial="hidden" animate="visible" variants={staggerContainer}>
      {/* Page Title */}
      <motion.h1
        variants={staggerItem}
        className="font-bold mb-6"
        style={{ color: '#0F1B4C', fontSize: '28px', letterSpacing: '-0.02em' }}
      >
        {t(language, 'nav.titles')}
      </motion.h1>

      <div className="flex gap-6" style={{ height: 'calc(100vh - 160px)' }}>
        {/* ================================================================ */}
        {/* LEFT PANEL — Title List                                          */}
        {/* ================================================================ */}
        <motion.div
          variants={staggerItem}
          className="flex-shrink-0 flex flex-col rounded-2xl overflow-hidden"
          style={{
            width: '320px',
            backgroundColor: '#ffffff',
            border: '1px solid #E2E8F0',
            boxShadow: '0 1px 3px 0 rgba(0,0,0,0.05)',
          }}
        >
          {/* Header + Search + Sort */}
          <div className="px-4 pt-5 pb-3">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <BarChart3 size={18} color="#0F1B4C" />
                <h2 className="font-bold" style={{ color: '#0F1B4C', fontSize: '15px' }}>
                  {language === 'ko' ? '작품 목록' : '作品一覧'}
                </h2>
              </div>
              <span
                className="px-2.5 py-0.5 rounded-full font-semibold"
                style={{ backgroundColor: '#F1F5F9', color: '#64748B', fontSize: '12px' }}
              >
                {filteredTitles.length}{language === 'ko' ? '개' : '件'}
              </span>
            </div>

            {/* Search */}
            <div className="relative mb-3">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search size={15} color="#94A3B8" />
              </div>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder={language === 'ko' ? '작품명 검색...' : '作品名検索...'}
                className="w-full rounded-lg py-2.5 pl-9 pr-3 outline-none transition-all"
                style={{
                  backgroundColor: '#F8FAFC',
                  border: '1px solid #E2E8F0',
                  color: '#0F172A',
                  fontSize: '13px',
                }}
                onFocus={e => { e.currentTarget.style.borderColor = '#2563EB'; }}
                onBlur={e => { e.currentTarget.style.borderColor = '#E2E8F0'; }}
              />
            </div>

            {/* Sort tabs */}
            <div className="flex gap-1.5">
              {sortOptions.map(opt => (
                <button
                  key={opt.key}
                  onClick={() => setSortKey(opt.key)}
                  className="px-3 py-1.5 rounded-md font-medium transition-all"
                  style={{
                    backgroundColor: sortKey === opt.key ? '#0F1B4C' : '#F1F5F9',
                    color: sortKey === opt.key ? '#ffffff' : '#64748B',
                    fontSize: '11px',
                    border: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Scrollable list */}
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {sortedTitles.map(title => {
              const isSelected = activeTitleKey === title.titleKR;
              const growth = titleGrowths[title.titleKR] || 0;

              return (
                <div
                  key={title.titleKR}
                  onClick={() => setSelectedTitle(title.titleKR)}
                  className="px-3 py-3 rounded-xl mb-1 cursor-pointer transition-all duration-150"
                  style={{
                    backgroundColor: isSelected ? '#EFF6FF' : 'transparent',
                    border: isSelected ? '1px solid #BFDBFE' : '1px solid transparent',
                  }}
                  onMouseEnter={e => {
                    if (!isSelected) e.currentTarget.style.backgroundColor = '#F8FAFC';
                  }}
                  onMouseLeave={e => {
                    if (!isSelected) e.currentTarget.style.backgroundColor = isSelected ? '#EFF6FF' : 'transparent';
                  }}
                >
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <span
                      className="font-semibold leading-tight"
                      style={{
                        color: isSelected ? '#2563EB' : '#0F172A',
                        fontSize: '13px',
                        maxWidth: '180px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        display: 'block',
                      }}
                    >
                      {titleName(title)}
                    </span>
                    <span className="font-bold flex-shrink-0" style={{ color: '#0F172A', fontSize: '13px' }}>
                      {formatSales(title.totalSales, currency, exchangeRate, language)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between">
                    {/* Platform dots */}
                    <div className="flex items-center gap-1">
                      {title.platforms.slice(0, 5).map((p, i) => (
                        <span
                          key={i}
                          className="w-[18px] h-[18px] rounded-full flex items-center justify-center"
                          style={{ backgroundColor: platformColorMap[p.name] || '#94A3B8' }}
                          title={p.name}
                        >
                          <span style={{ color: '#fff', fontSize: '7px', fontWeight: 700 }}>
                            {p.name.charAt(0).toUpperCase()}
                          </span>
                        </span>
                      ))}
                      {title.platforms.length > 5 && (
                        <span style={{ color: '#94A3B8', fontSize: '10px', fontWeight: 500 }}>
                          +{title.platforms.length - 5}
                        </span>
                      )}
                    </div>

                    {/* Growth + platform count */}
                    <div className="flex items-center gap-1.5">
                      {growth > 5 ? (
                        <TrendingUp size={13} color="#16A34A" />
                      ) : growth < -5 ? (
                        <TrendingDown size={13} color="#DC2626" />
                      ) : (
                        <Minus size={13} color="#94A3B8" />
                      )}
                      <span style={{ color: '#94A3B8', fontSize: '11px', fontWeight: 500 }}>
                        {title.platforms.length}{language === 'ko' ? '개 플랫폼' : 'PF'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </motion.div>

        {/* ================================================================ */}
        {/* RIGHT PANEL — Detail View                                        */}
        {/* ================================================================ */}
        <div className="flex-1 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
          {selectedTitleData ? (
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTitleKey}
                initial="hidden"
                animate="visible"
                variants={staggerContainer}
                className="space-y-6 pb-8"
              >
                {/* Header: Title Name + Cumulative Sales */}
                <motion.div
                  variants={detailReveal}
                  className="flex items-start justify-between flex-wrap gap-4"
                >
                  <div className="min-w-0">
                    <h2 className="font-bold" style={{ color: '#0F1B4C', fontSize: '24px' }}>
                      {titleName(selectedTitleData)}
                    </h2>
                    <div className="flex flex-wrap items-center gap-2 mt-2">
                      {selectedTitleData.platforms.map((p, i) => (
                        <span
                          key={i}
                          className="px-2.5 py-1 rounded-md font-medium"
                          style={{
                            backgroundColor: `${platformColorMap[p.name]}15`,
                            color: platformColorMap[p.name],
                            fontSize: '12px',
                            border: `1px solid ${platformColorMap[p.name]}30`,
                          }}
                        >
                          {p.name}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p style={{ color: '#64748B', fontSize: '13px', fontWeight: 500 }}>
                      {language === 'ko' ? '누적 매출' : '累計売上'}
                    </p>
                    <p className="font-extrabold" style={{ color: '#0F1B4C', fontSize: '32px', lineHeight: 1.2 }}>
                      {formatSales(selectedTitleData.totalSales, currency, exchangeRate, language)}
                    </p>
                  </div>
                </motion.div>

                {/* Platform Cards Grid */}
                <motion.div variants={detailReveal}>
                  <h3 className="font-bold mb-3" style={{ color: '#0F1B4C', fontSize: '16px' }}>
                    {language === 'ko' ? '서비스 플랫폼' : 'サービスプラットフォーム'}
                  </h3>
                  <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                    {selectedTitleData.platforms
                      .sort((a, b) => b.sales - a.sales)
                      .map((p, i) => {
                        const growth = platformGrowths.get(p.name) || 0;
                        return (
                          <div
                            key={i}
                            className="rounded-xl p-4 transition-shadow duration-200 hover:shadow-md"
                            style={{
                              backgroundColor: '#ffffff',
                              border: '1px solid #E2E8F0',
                            }}
                          >
                            <div className="flex items-center gap-2 mb-2">
                              <span
                                className="w-3 h-3 rounded-full flex-shrink-0"
                                style={{ backgroundColor: platformColorMap[p.name] || '#94A3B8' }}
                              />
                              <span className="font-semibold truncate" style={{ color: '#0F1B4C', fontSize: '13px' }}>
                                {p.name}
                              </span>
                            </div>
                            <p className="font-bold mb-1" style={{ color: '#0F172A', fontSize: '16px' }}>
                              {formatSales(p.sales, currency, exchangeRate, language)}
                            </p>
                            <div className="flex items-center gap-1">
                              {growth > 0 ? (
                                <TrendingUp size={12} color="#16A34A" />
                              ) : growth < 0 ? (
                                <TrendingDown size={12} color="#DC2626" />
                              ) : (
                                <Minus size={12} color="#94A3B8" />
                              )}
                              <span
                                className="font-medium"
                                style={{ color: getChangeColor(growth), fontSize: '12px' }}
                              >
                                {formatPercent(growth)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </motion.div>

                {/* Two charts side by side: Donut + Monthly Bar */}
                <motion.div variants={detailReveal} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Donut: Platform Sales Share */}
                  <div
                    className="rounded-2xl p-6"
                    style={{
                      backgroundColor: '#ffffff',
                      border: '1px solid #E2E8F0',
                      boxShadow: '0 1px 3px 0 rgba(0,0,0,0.05)',
                    }}
                  >
                    <h3 className="font-bold mb-1" style={{ color: '#0F1B4C', fontSize: '16px' }}>
                      {language === 'ko' ? '누적 플랫폼별 매출 비중' : '累計PF別売上シェア'}
                    </h3>
                    <p className="mb-4" style={{ color: '#64748B', fontSize: '13px' }}>
                      {language === 'ko'
                        ? `전체 기간 누적 · 총 ${formatSales(selectedTitleData.totalSales, currency, exchangeRate, language)}`
                        : `全期間累計 · 合計 ${formatSales(selectedTitleData.totalSales, currency, exchangeRate, language)}`}
                    </p>
                    <ResponsiveContainer width="100%" height={280}>
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
                          label={({ name, percent }: any) =>
                            percent > 0.03 ? `${name} ${(percent * 100).toFixed(1)}%` : null
                          }
                          labelLine={{ stroke: '#94A3B8', strokeWidth: 1 }}
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
                  </div>

                  {/* Monthly Sales Bar Chart */}
                  <div
                    className="rounded-2xl p-6"
                    style={{
                      backgroundColor: '#ffffff',
                      border: '1px solid #E2E8F0',
                      boxShadow: '0 1px 3px 0 rgba(0,0,0,0.05)',
                    }}
                  >
                    <h3 className="font-bold mb-1" style={{ color: '#0F1B4C', fontSize: '16px' }}>
                      {language === 'ko' ? '월별 매출 추이' : '月別売上推移'}
                    </h3>
                    <p className="mb-4" style={{ color: '#64748B', fontSize: '13px' }}>
                      {language === 'ko'
                        ? `전체 플랫폼 합산 · ${monthlyTrendData.length}개월`
                        : `全PF合計 · ${monthlyTrendData.length}ヶ月`}
                    </p>
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
                  </div>
                </motion.div>

                {/* Weekly Platform Trend - Multi-line Chart */}
                <motion.div
                  variants={detailReveal}
                  className="rounded-2xl p-6"
                  style={{
                    backgroundColor: '#ffffff',
                    border: '1px solid #E2E8F0',
                    boxShadow: '0 1px 3px 0 rgba(0,0,0,0.05)',
                  }}
                >
                  <h3 className="font-bold mb-1" style={{ color: '#0F1B4C', fontSize: '16px' }}>
                    {language === 'ko' ? '플랫폼별 주간 매출 추이' : 'PF別週間売上推移'}
                  </h3>
                  <p className="mb-4" style={{ color: '#64748B', fontSize: '13px' }}>
                    {language === 'ko'
                      ? `거래액 기준 (엔) · ${weeklyPlatformTrend.data.length}주간`
                      : `取引額基準 (円) · ${weeklyPlatformTrend.data.length}週間`}
                  </p>
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
                      <Legend wrapperStyle={{ fontSize: '13px', color: '#475569' }} />
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
                </motion.div>
              </motion.div>
            </AnimatePresence>
          ) : (
            /* Empty state */
            <div
              className="flex items-center justify-center rounded-2xl"
              style={{
                backgroundColor: '#ffffff',
                border: '1px solid #E2E8F0',
                height: '100%',
                minHeight: '400px',
              }}
            >
              <div className="text-center">
                <BarChart3 size={48} color="#CBD5E1" className="mx-auto mb-4" />
                <p className="font-semibold" style={{ color: '#64748B', fontSize: '16px' }}>
                  {language === 'ko' ? '작품을 선택하세요' : '作品を選択してください'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
