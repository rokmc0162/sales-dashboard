import { useState, useMemo } from 'react';
import { useDataLoader } from '../hooks/useDataLoader';
import { useAppState } from '../hooks/useAppState';
import { t } from '../i18n';
import { formatSales, formatSalesShort, formatDate } from '../utils/formatters';
import { KPICard } from '../components/charts/KPICard';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';

const CHART_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];

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
    if (sortKey !== key) return ' ↕';
    return sortDir === 'desc' ? ' ↓' : ' ↑';
  }

  if (data.loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6" style={{ color: '#f8fafc' }}>
          {t(language, 'nav.titles')}
        </h1>
        <div
          className="rounded-xl p-8 flex items-center justify-center"
          style={{ backgroundColor: '#1e293b', border: '1px solid #334155', minHeight: '400px' }}
        >
          <div className="flex flex-col items-center gap-3">
            <div
              className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: '#3b82f6', borderTopColor: 'transparent' }}
            />
            <p className="text-sm" style={{ color: '#94a3b8' }}>Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Page Title */}
      <h1 className="text-2xl font-bold mb-6" style={{ color: '#f8fafc' }}>
        {t(language, 'nav.titles')}
      </h1>

      {/* Search Input */}
      <div className="mb-6">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t(language, 'filter.search')}
          className="w-full rounded-lg p-3 text-sm outline-none transition-colors focus:ring-2 focus:ring-blue-500/40"
          style={{
            backgroundColor: '#0f172a',
            border: '1px solid #334155',
            color: '#f8fafc',
          }}
        />
      </div>

      {/* Title Ranking Table */}
      <div
        className="rounded-xl p-6 mb-6 overflow-hidden"
        style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
      >
        <h2 className="text-lg font-semibold mb-4" style={{ color: '#f8fafc' }}>
          {t(language, 'chart.topTitles')}
          <span className="ml-2 text-sm font-normal" style={{ color: '#64748b' }}>
            ({sortedTitles.length})
          </span>
        </h2>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: '#0f172a' }}>
                <th className="text-left p-3 font-medium" style={{ color: '#94a3b8' }}>
                  {t(language, 'table.rank')}
                </th>
                <th className="text-left p-3 font-medium" style={{ color: '#94a3b8' }}>
                  {t(language, 'table.title')}
                </th>
                <th
                  className="text-right p-3 font-medium cursor-pointer select-none hover:opacity-80"
                  style={{ color: '#94a3b8' }}
                  onClick={() => handleSort('totalSales')}
                >
                  {t(language, 'kpi.totalSales')}{sortIndicator('totalSales')}
                </th>
                <th
                  className="text-right p-3 font-medium cursor-pointer select-none hover:opacity-80"
                  style={{ color: '#94a3b8' }}
                  onClick={() => handleSort('dailyAvg')}
                >
                  {language === 'ko' ? '일평균' : '日平均'}{sortIndicator('dailyAvg')}
                </th>
                <th
                  className="text-right p-3 font-medium cursor-pointer select-none hover:opacity-80"
                  style={{ color: '#94a3b8' }}
                  onClick={() => handleSort('peakSales')}
                >
                  {language === 'ko' ? '최고 매출' : 'ピーク売上'}{sortIndicator('peakSales')}
                </th>
                <th
                  className="text-right p-3 font-medium cursor-pointer select-none hover:opacity-80"
                  style={{ color: '#94a3b8' }}
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
                    className="cursor-pointer transition-colors"
                    style={{
                      backgroundColor: isSelected
                        ? 'rgba(59, 130, 246, 0.15)'
                        : 'transparent',
                      borderBottom: '1px solid #334155',
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = '#334155';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                  >
                    <td className="p-3 font-mono" style={{ color: '#64748b' }}>
                      {idx + 1}
                    </td>
                    <td className="p-3 font-medium" style={{ color: isSelected ? '#3b82f6' : '#f8fafc' }}>
                      {language === 'ko' ? title.titleKR : title.titleJP}
                    </td>
                    <td className="p-3 text-right font-mono" style={{ color: '#f8fafc' }}>
                      {formatSales(title.totalSales, currency, exchangeRate, language)}
                    </td>
                    <td className="p-3 text-right font-mono" style={{ color: '#94a3b8' }}>
                      {formatSales(title.dailyAvg, currency, exchangeRate, language)}
                    </td>
                    <td className="p-3 text-right font-mono" style={{ color: '#94a3b8' }}>
                      {formatSales(title.peakSales, currency, exchangeRate, language)}
                    </td>
                    <td className="p-3 text-right" style={{ color: '#94a3b8' }}>
                      {title.platforms.length}
                    </td>
                  </tr>
                );
              })}
              {sortedTitles.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center" style={{ color: '#64748b' }}>
                    {language === 'ko' ? '검색 결과가 없습니다.' : '検索結果がありません。'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Selected Title Detail Section */}
      {selectedTitleData && (
        <div className="space-y-6">
          {/* KPI Cards Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
          </div>

          {/* Daily Sales Trend Line Chart */}
          <div
            className="rounded-xl p-6"
            style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
          >
            <h3 className="text-base font-semibold mb-4" style={{ color: '#f8fafc' }}>
              {t(language, 'chart.dailySales')} - {language === 'ko' ? selectedTitleData.titleKR : selectedTitleData.titleJP}
            </h3>
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={selectedDailySales}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="date"
                  stroke="#64748b"
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                  tickFormatter={(val) => val.substring(5)}
                />
                <YAxis
                  stroke="#64748b"
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                  tickFormatter={(val) => formatSalesShort(val)}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    color: '#f8fafc',
                  }}
                  labelStyle={{ color: '#94a3b8' }}
                  formatter={(value: any) => [
                    formatSales(value, currency, exchangeRate, language),
                    t(language, 'table.sales'),
                  ]}
                />
                <Line
                  type="monotone"
                  dataKey="sales"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: '#3b82f6' }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Platform Breakdown Stacked Bar Chart */}
          <div
            className="rounded-xl p-6"
            style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
          >
            <h3 className="text-base font-semibold mb-4" style={{ color: '#f8fafc' }}>
              {t(language, 'chart.platformShare')} - {language === 'ko' ? selectedTitleData.titleKR : selectedTitleData.titleJP}
            </h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={selectedPlatformData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="name"
                  stroke="#64748b"
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                />
                <YAxis
                  stroke="#64748b"
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                  tickFormatter={(val) => formatSalesShort(val)}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1e293b',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    color: '#f8fafc',
                  }}
                  labelStyle={{ color: '#94a3b8' }}
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
          </div>
        </div>
      )}
    </div>
  );
}
