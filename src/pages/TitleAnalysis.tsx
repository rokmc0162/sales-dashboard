import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Search } from 'lucide-react';
import { useDataLoader } from '../hooks/useDataLoader';
import { useAppState } from '../hooks/useAppState';
import { t } from '../i18n';
import { formatSales, formatSalesShort, formatDate } from '../utils/formatters';
import { KPICard } from '../components/charts/KPICard';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

const CHART_COLORS = ['#2563EB', '#7C3AED', '#0891B2', '#16A34A', '#D97706', '#DC2626', '#DB2777', '#0D9488', '#4F46E5', '#EA580C'];

const tooltipStyle = {
  contentStyle: { backgroundColor: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' },
  labelStyle: { color: '#475569', fontWeight: 600 },
  itemStyle: { color: '#0F172A' },
};

const staggerContainer = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
};

const staggerItem = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: 'easeOut' as const } },
};

type SortKey = 'totalSales' | 'dailyAvg' | 'peakSales' | 'platformCount';
type SortDir = 'asc' | 'desc';

export function TitleAnalysis() {
  const { language, currency, exchangeRate } = useAppState();
  const data = useDataLoader();

  const [search, setSearch] = useState('');
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('totalSales');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Filter titles by search query
  const filteredTitles = useMemo(() => {
    if (!search.trim()) return data.titleSummary;
    const q = search.toLowerCase();
    return data.titleSummary.filter(
      (ts) =>
        ts.titleKR.toLowerCase().includes(q) ||
        ts.titleJP.toLowerCase().includes(q)
    );
  }, [data.titleSummary, search]);

  // Sort filtered titles
  const sortedTitles = useMemo(() => {
    const sorted = [...filteredTitles].sort((a, b) => {
      let aVal: number;
      let bVal: number;
      switch (sortKey) {
        case 'totalSales':
          aVal = a.totalSales;
          bVal = b.totalSales;
          break;
        case 'dailyAvg':
          aVal = a.dailyAvg;
          bVal = b.dailyAvg;
          break;
        case 'peakSales':
          aVal = a.peakSales;
          bVal = b.peakSales;
          break;
        case 'platformCount':
          aVal = a.platforms.length;
          bVal = b.platforms.length;
          break;
        default:
          aVal = a.totalSales;
          bVal = b.totalSales;
      }
      return sortDir === 'desc' ? bVal - aVal : aVal - bVal;
    });
    return sorted;
  }, [filteredTitles, sortKey, sortDir]);

  // Selected title data
  const selectedTitleData = useMemo(() => {
    if (!selectedTitle) return null;
    return data.titleSummary.find((ts) => ts.titleKR === selectedTitle) ?? null;
  }, [data.titleSummary, selectedTitle]);

  // Daily sales for selected title
  const selectedDailySales = useMemo(() => {
    if (!selectedTitle) return [];
    return data.dailySales
      .filter((ds) => ds.titleKR === selectedTitle)
      .reduce<{ date: string; sales: number }[]>((acc, ds) => {
        const existing = acc.find((a) => a.date === ds.date);
        if (existing) {
          existing.sales += ds.sales;
        } else {
          acc.push({ date: ds.date, sales: ds.sales });
        }
        return acc;
      }, [])
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [data.dailySales, selectedTitle]);

  // Platform breakdown for selected title
  const selectedPlatformData = useMemo(() => {
    if (!selectedTitleData) return [];
    return selectedTitleData.platforms.map((p) => ({
      name: p.name,
      sales: p.sales,
    }));
  }, [selectedTitleData]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return <span style={{ color: '#94A3B8' }}> ↕</span>;
    return <span style={{ color: '#2563EB' }}>{sortDir === 'desc' ? ' ↓' : ' ↑'}</span>;
  }

  if (data.loading) {
    return (
      <div style={{ backgroundColor: '#F8FAFC', minHeight: '100vh' }}>
        <h1 className="text-2xl font-bold mb-6" style={{ color: '#0F1B4C', fontSize: '28px' }}>
          {t(language, 'nav.titles')}
        </h1>
        <div
          className="rounded-xl p-8 flex items-center justify-center"
          style={{ backgroundColor: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.08)', minHeight: '400px' }}
        >
          <div className="flex flex-col items-center gap-3">
            <div
              className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: '#2563EB', borderTopColor: 'transparent' }}
            />
            <p style={{ color: '#64748B', fontSize: '15px' }}>Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={staggerContainer}
    >
      {/* Page Title */}
      <motion.h1
        variants={staggerItem}
        className="font-bold mb-6"
        style={{ color: '#0F1B4C', fontSize: '28px', letterSpacing: '-0.02em' }}
      >
        {t(language, 'nav.titles')}
      </motion.h1>

      {/* Search Input */}
      <motion.div variants={staggerItem} className="mb-6 relative">
        <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
          <Search size={20} color="#94A3B8" />
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t(language, 'filter.search')}
          className="w-full rounded-xl py-3.5 pl-12 pr-4 outline-none transition-all duration-200"
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #E2E8F0',
            color: '#0F172A',
            fontSize: '16px',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = '#2563EB';
            e.currentTarget.style.boxShadow = '0 0 0 3px rgba(37,99,235,0.12)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = '#E2E8F0';
            e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.04)';
          }}
        />
      </motion.div>

      {/* Title Ranking Table */}
      <motion.div
        variants={staggerItem}
        className="rounded-xl p-6 mb-6 overflow-hidden"
        style={{ backgroundColor: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
      >
        <h2 className="font-semibold mb-4" style={{ color: '#0F1B4C', fontSize: '18px' }}>
          {t(language, 'chart.topTitles')}
          <span className="ml-2 font-normal" style={{ color: '#64748B', fontSize: '14px' }}>
            ({sortedTitles.length})
          </span>
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full" style={{ fontSize: '14px' }}>
            <thead>
              <tr style={{ backgroundColor: '#F1F5F9' }}>
                <th className="text-left p-3.5 font-semibold rounded-tl-lg" style={{ color: '#475569' }}>
                  {t(language, 'table.rank')}
                </th>
                <th className="text-left p-3.5 font-semibold" style={{ color: '#475569' }}>
                  {t(language, 'table.title')}
                </th>
                <th
                  className="text-right p-3.5 font-semibold cursor-pointer select-none hover:opacity-80 transition-opacity"
                  style={{ color: '#475569' }}
                  onClick={() => handleSort('totalSales')}
                >
                  {t(language, 'kpi.totalSales')}{sortIndicator('totalSales')}
                </th>
                <th
                  className="text-right p-3.5 font-semibold cursor-pointer select-none hover:opacity-80 transition-opacity"
                  style={{ color: '#475569' }}
                  onClick={() => handleSort('dailyAvg')}
                >
                  {language === 'ko' ? '일평균' : '日平均'}{sortIndicator('dailyAvg')}
                </th>
                <th
                  className="text-right p-3.5 font-semibold cursor-pointer select-none hover:opacity-80 transition-opacity"
                  style={{ color: '#475569' }}
                  onClick={() => handleSort('peakSales')}
                >
                  {language === 'ko' ? '최고 매출' : 'ピーク売上'}{sortIndicator('peakSales')}
                </th>
                <th
                  className="text-right p-3.5 font-semibold cursor-pointer select-none hover:opacity-80 transition-opacity rounded-tr-lg"
                  style={{ color: '#475569' }}
                  onClick={() => handleSort('platformCount')}
                >
                  {t(language, 'table.platform')}{sortIndicator('platformCount')}
                </th>
              </tr>
            </thead>
            <tbody>
              {sortedTitles.map((title, idx) => {
                const isSelected = selectedTitle === title.titleKR;
                return (
                  <tr
                    key={title.titleKR}
                    onClick={() =>
                      setSelectedTitle(isSelected ? null : title.titleKR)
                    }
                    className="cursor-pointer transition-all duration-150"
                    style={{
                      backgroundColor: isSelected
                        ? '#EFF6FF'
                        : idx % 2 === 1 ? '#F8FAFC' : '#ffffff',
                      borderBottom: '1px solid #F1F5F9',
                      borderLeft: isSelected ? '3px solid #2563EB' : '3px solid transparent',
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = '#F8FAFC';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = idx % 2 === 1 ? '#F8FAFC' : '#ffffff';
                    }}
                  >
                    <td className="p-3.5 font-mono" style={{ color: '#94A3B8', fontSize: '14px' }}>
                      {idx + 1}
                    </td>
                    <td className="p-3.5 font-semibold" style={{ color: isSelected ? '#2563EB' : '#0F172A', fontSize: '15px' }}>
                      {language === 'ko' ? title.titleKR : title.titleJP}
                    </td>
                    <td className="p-3.5 text-right font-mono" style={{ color: '#0F172A', fontSize: '14px', fontWeight: 600 }}>
                      {formatSales(title.totalSales, currency, exchangeRate, language)}
                    </td>
                    <td className="p-3.5 text-right font-mono" style={{ color: '#475569', fontSize: '14px' }}>
                      {formatSales(title.dailyAvg, currency, exchangeRate, language)}
                    </td>
                    <td className="p-3.5 text-right font-mono" style={{ color: '#475569', fontSize: '14px' }}>
                      {formatSales(title.peakSales, currency, exchangeRate, language)}
                    </td>
                    <td className="p-3.5 text-right" style={{ color: '#475569', fontSize: '14px' }}>
                      {title.platforms.length}
                    </td>
                  </tr>
                );
              })}
              {sortedTitles.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center" style={{ color: '#94A3B8', fontSize: '15px' }}>
                    {language === 'ko' ? '검색 결과가 없습니다.' : '検索結果がありません。'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </motion.div>

      {/* Selected Title Detail Section */}
      {selectedTitleData && (
        <motion.div
          key={selectedTitleData.titleKR}
          initial="hidden"
          animate="visible"
          variants={staggerContainer}
          className="space-y-6"
        >
          {/* KPI Cards Row */}
          <motion.div variants={staggerItem} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <KPICard
              title={t(language, 'kpi.totalSales')}
              value={formatSales(selectedTitleData.totalSales, currency, exchangeRate, language)}
              subtitle={language === 'ko' ? '누적 매출' : '累計売上'}
            />
            <KPICard
              title={language === 'ko' ? '일평균 매출' : '日平均売上'}
              value={formatSales(selectedTitleData.dailyAvg, currency, exchangeRate, language)}
              subtitle={language === 'ko' ? '하루 평균' : '1日平均'}
            />
            <KPICard
              title={language === 'ko' ? '최고 매출' : 'ピーク売上'}
              value={formatSales(selectedTitleData.peakSales, currency, exchangeRate, language)}
              subtitle={formatDate(selectedTitleData.peakDate, language)}
            />
            <KPICard
              title={language === 'ko' ? '플랫폼 수' : 'PF数'}
              value={String(selectedTitleData.platforms.length)}
              subtitle={selectedTitleData.platforms.map((p) => p.name).join(', ')}
            />
          </motion.div>

          {/* Daily Sales Trend Line Chart */}
          <motion.div
            variants={staggerItem}
            className="rounded-xl p-6"
            style={{ backgroundColor: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
          >
            <h3 className="font-semibold mb-4" style={{ color: '#0F1B4C', fontSize: '16px' }}>
              {t(language, 'chart.dailySales')} - {language === 'ko' ? selectedTitleData.titleKR : selectedTitleData.titleJP}
            </h3>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={selectedDailySales}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis
                  dataKey="date"
                  stroke="#CBD5E1"
                  tick={{ fill: '#64748B', fontSize: 12 }}
                  tickFormatter={(val: any) => val.substring(5)}
                />
                <YAxis
                  stroke="#CBD5E1"
                  tick={{ fill: '#64748B', fontSize: 12 }}
                  tickFormatter={(val: any) => formatSalesShort(val)}
                />
                <Tooltip
                  {...tooltipStyle}
                  formatter={(value: any) => [
                    formatSales(value, currency, exchangeRate, language),
                    t(language, 'table.sales'),
                  ]}
                />
                <Line
                  type="monotone"
                  dataKey="sales"
                  stroke="#2563EB"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 5, fill: '#2563EB', stroke: '#fff', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </motion.div>

          {/* Platform Breakdown Bar Chart */}
          <motion.div
            variants={staggerItem}
            className="rounded-xl p-6"
            style={{ backgroundColor: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
          >
            <h3 className="font-semibold mb-4" style={{ color: '#0F1B4C', fontSize: '16px' }}>
              {t(language, 'chart.platformShare')} - {language === 'ko' ? selectedTitleData.titleKR : selectedTitleData.titleJP}
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={selectedPlatformData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis
                  dataKey="name"
                  stroke="#CBD5E1"
                  tick={{ fill: '#64748B', fontSize: 12 }}
                />
                <YAxis
                  stroke="#CBD5E1"
                  tick={{ fill: '#64748B', fontSize: 12 }}
                  tickFormatter={(val: any) => formatSalesShort(val)}
                />
                <Tooltip
                  {...tooltipStyle}
                  formatter={(value: any) => [
                    formatSales(value, currency, exchangeRate, language),
                    t(language, 'table.sales'),
                  ]}
                />
                <Bar dataKey="sales" radius={[6, 6, 0, 0]}>
                  {selectedPlatformData.map((_entry, index) => (
                    <Cell key={`cell-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </motion.div>
        </motion.div>
      )}
    </motion.div>
  );
}
