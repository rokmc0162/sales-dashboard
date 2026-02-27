import { useState, useMemo } from 'react';
import { useDataLoader } from '../hooks/useDataLoader';
import { useAppState } from '../hooks/useAppState';
import { t } from '../i18n';
import { formatSales, formatSalesShort } from '../utils/formatters';
import { KPICard } from '../components/charts/KPICard';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, AreaChart, Area,
} from 'recharts';

const CHART_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];

export function PlatformAnalysis() {
  const { language, currency, exchangeRate } = useAppState();
  const data = useDataLoader();

  const [selectedPlatform, setSelectedPlatform] = useState<string | null>(null);

  // Auto-select first platform when data loads
  const platforms = data.platformSummary;
  const activePlatform = selectedPlatform ?? (platforms.length > 0 ? platforms[0].platform : null);

  // Selected platform data
  const selectedPlatformData = useMemo(() => {
    if (!activePlatform) return null;
    return platforms.find((p) => p.platform === activePlatform) ?? null;
  }, [platforms, activePlatform]);

  // Grand total for share calculation
  const grandTotal = useMemo(() => {
    return platforms.reduce((sum, p) => sum + p.totalSales, 0);
  }, [platforms]);

  // Monthly sales for selected platform (bar chart data)
  const selectedMonthlyData = useMemo(() => {
    if (!selectedPlatformData) return [];
    return [...selectedPlatformData.monthlyTrend].sort((a, b) =>
      a.month.localeCompare(b.month)
    );
  }, [selectedPlatformData]);

  // Top 10 titles for selected platform
  const selectedTopTitles = useMemo(() => {
    if (!selectedPlatformData) return [];
    return selectedPlatformData.topTitles.slice(0, 10);
  }, [selectedPlatformData]);

  // Platform comparison: stacked area data (all platforms' monthly trends merged)
  const comparisonData = useMemo(() => {
    if (platforms.length === 0) return [];

    // Collect all months
    const monthSet = new Set<string>();
    platforms.forEach((p) => {
      p.monthlyTrend.forEach((mt) => monthSet.add(mt.month));
    });

    const months = Array.from(monthSet).sort();
    return months.map((month) => {
      const row: Record<string, string | number> = { month };
      platforms.forEach((p) => {
        const entry = p.monthlyTrend.find((mt) => mt.month === month);
        row[p.platform] = entry ? entry.sales : 0;
      });
      return row;
    });
  }, [platforms]);

  if (data.loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6" style={{ color: '#f8fafc' }}>
          {t(language, 'nav.platforms')}
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
        {t(language, 'nav.platforms')}
      </h1>

      {/* Platform Tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {platforms.map((p, idx) => {
          const isActive = p.platform === activePlatform;
          return (
            <button
              key={p.platform}
              onClick={() => setSelectedPlatform(p.platform)}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200"
              style={{
                backgroundColor: isActive ? CHART_COLORS[idx % CHART_COLORS.length] : '#1e293b',
                color: isActive ? '#ffffff' : '#94a3b8',
                border: isActive
                  ? `1px solid ${CHART_COLORS[idx % CHART_COLORS.length]}`
                  : '1px solid #334155',
              }}
            >
              {p.platform}
            </button>
          );
        })}
      </div>

      {/* Selected Platform View */}
      {selectedPlatformData && (
        <div className="space-y-6">
          {/* KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
          </div>

          {/* Monthly Sales Bar Chart */}
          <div
            className="rounded-xl p-6"
            style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
          >
            <h3 className="text-base font-semibold mb-4" style={{ color: '#f8fafc' }}>
              {t(language, 'chart.monthlySales')} - {selectedPlatformData.platform}
            </h3>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={selectedMonthlyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                <XAxis
                  dataKey="month"
                  stroke="#64748b"
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                  tickFormatter={(val) => val.substring(2).replace('-', '/')}
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
                <Bar
                  dataKey="sales"
                  fill={CHART_COLORS[platforms.findIndex((p) => p.platform === activePlatform) % CHART_COLORS.length]}
                  radius={[6, 6, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Top 10 Titles Table */}
          <div
            className="rounded-xl p-6"
            style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
          >
            <h3 className="text-base font-semibold mb-4" style={{ color: '#f8fafc' }}>
              {t(language, 'chart.topTitles')} - {selectedPlatformData.platform}
            </h3>
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
                    <th className="text-right p-3 font-medium" style={{ color: '#94a3b8' }}>
                      {t(language, 'table.sales')}
                    </th>
                    <th className="text-right p-3 font-medium" style={{ color: '#94a3b8' }}>
                      {language === 'ko' ? '비중' : 'シェア'}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {selectedTopTitles.map((title, idx) => (
                    <tr
                      key={`${title.titleKR}-${idx}`}
                      className="transition-colors"
                      style={{ borderBottom: '1px solid #334155' }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = '#334155';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                    >
                      <td className="p-3 font-mono" style={{ color: '#64748b' }}>
                        {idx + 1}
                      </td>
                      <td className="p-3 font-medium" style={{ color: '#f8fafc' }}>
                        {language === 'ko' ? title.titleKR : title.titleJP}
                      </td>
                      <td className="p-3 text-right font-mono" style={{ color: '#f8fafc' }}>
                        {formatSales(title.sales, currency, exchangeRate, language)}
                      </td>
                      <td className="p-3 text-right font-mono" style={{ color: '#94a3b8' }}>
                        {selectedPlatformData.totalSales > 0
                          ? `${((title.sales / selectedPlatformData.totalSales) * 100).toFixed(1)}%`
                          : '0%'
                        }
                      </td>
                    </tr>
                  ))}
                  {selectedTopTitles.length === 0 && (
                    <tr>
                      <td colSpan={4} className="p-8 text-center" style={{ color: '#64748b' }}>
                        {language === 'ko' ? '데이터가 없습니다.' : 'データがありません。'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Platform Comparison Section */}
      <div
        className="rounded-xl p-6 mt-6"
        style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
      >
        <h3 className="text-base font-semibold mb-4" style={{ color: '#f8fafc' }}>
          {t(language, 'chart.platformShareTrend')}
        </h3>
        <ResponsiveContainer width="100%" height={400}>
          <AreaChart data={comparisonData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis
              dataKey="month"
              stroke="#64748b"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              tickFormatter={(val) => val.substring(2).replace('-', '/')}
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
              formatter={(value: any, name: any) => [
                formatSales(value, currency, exchangeRate, language),
                name,
              ]}
            />
            <Legend
              wrapperStyle={{ color: '#94a3b8', fontSize: '12px' }}
            />
            {platforms.map((p, idx) => (
              <Area
                key={p.platform}
                type="monotone"
                dataKey={p.platform}
                stackId="1"
                stroke={CHART_COLORS[idx % CHART_COLORS.length]}
                fill={CHART_COLORS[idx % CHART_COLORS.length]}
                fillOpacity={0.6}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
