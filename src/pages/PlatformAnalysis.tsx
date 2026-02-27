import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useDataLoader } from '../hooks/useDataLoader';
import { useAppState } from '../hooks/useAppState';
import { t } from '../i18n';
import { formatSales, formatSalesShort } from '../utils/formatters';
import { KPICard } from '../components/charts/KPICard';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, AreaChart, Area,
} from 'recharts';
import { getPlatformBrand, getPlatformColor } from '../utils/platformConfig';
import { PlatformIcon } from '../components/PlatformIcon';

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
        <h1 className="font-bold mb-6" style={{ color: '#0F1B4C', fontSize: '28px' }}>
          {t(language, 'nav.platforms')}
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
        {t(language, 'nav.platforms')}
      </motion.h1>

      {/* Platform Tabs - Pill Buttons */}
      <motion.div variants={staggerItem} className="flex flex-wrap gap-2 mb-6">
        {platforms.map((p) => {
          const isActive = p.platform === activePlatform;
          return (
            <motion.button
              key={p.platform}
              onClick={() => setSelectedPlatform(p.platform)}
              whileHover={{ scale: 1.04 }}
              whileTap={{ scale: 0.97 }}
              className="flex items-center gap-2 px-4 py-2.5 rounded-full font-medium transition-all duration-200"
              style={{
                backgroundColor: isActive ? getPlatformBrand(p.platform).color : '#F1F5F9',
                color: isActive ? '#ffffff' : '#475569',
                fontSize: '14px',
                border: isActive ? 'none' : `1px solid ${getPlatformBrand(p.platform).borderColor}`,
                boxShadow: isActive ? `0 2px 8px ${getPlatformBrand(p.platform).color}40` : 'none',
                cursor: 'pointer',
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
          animate="visible"
          variants={staggerContainer}
          className="space-y-6"
        >
          {/* KPI Cards */}
          <motion.div variants={staggerItem} className="grid grid-cols-1 sm:grid-cols-3 gap-4">
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
          </motion.div>

          {/* Monthly Sales Bar Chart */}
          <motion.div
            variants={staggerItem}
            className="rounded-xl p-6"
            style={{ backgroundColor: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
          >
            <h3 className="font-semibold mb-4" style={{ color: '#0F1B4C', fontSize: '16px' }}>
              {t(language, 'chart.monthlySales')} - {selectedPlatformData.platform}
            </h3>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={selectedMonthlyData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
                <XAxis
                  dataKey="month"
                  stroke="#CBD5E1"
                  tick={{ fill: '#64748B', fontSize: 12 }}
                  tickFormatter={(val: any) => val.substring(2).replace('-', '/')}
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
                <Bar
                  dataKey="sales"
                  fill={getPlatformColor(activePlatform || '')}
                  radius={[6, 6, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </motion.div>

          {/* Top 10 Titles Table */}
          <motion.div
            variants={staggerItem}
            className="rounded-xl p-6"
            style={{ backgroundColor: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
          >
            <h3 className="font-semibold mb-4" style={{ color: '#0F1B4C', fontSize: '16px' }}>
              {t(language, 'chart.topTitles')} - {selectedPlatformData.platform}
            </h3>
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
                    <th className="text-right p-3.5 font-semibold" style={{ color: '#475569' }}>
                      {t(language, 'table.sales')}
                    </th>
                    <th className="text-right p-3.5 font-semibold rounded-tr-lg" style={{ color: '#475569' }}>
                      {language === 'ko' ? '비중' : 'シェア'}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {selectedTopTitles.map((title, idx) => (
                    <tr
                      key={`${title.titleKR}-${idx}`}
                      className="transition-colors duration-150"
                      style={{
                        borderBottom: '1px solid #F1F5F9',
                        backgroundColor: idx % 2 === 1 ? '#F8FAFC' : '#ffffff',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = '#F1F5F9';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = idx % 2 === 1 ? '#F8FAFC' : '#ffffff';
                      }}
                    >
                      <td className="p-3.5 font-mono" style={{ color: '#94A3B8', fontSize: '14px' }}>
                        {idx + 1}
                      </td>
                      <td className="p-3.5 font-semibold" style={{ color: '#0F172A', fontSize: '15px' }}>
                        {language === 'ko' ? title.titleKR : title.titleJP}
                      </td>
                      <td className="p-3.5 text-right font-mono" style={{ color: '#0F172A', fontSize: '14px', fontWeight: 600 }}>
                        {formatSales(title.sales, currency, exchangeRate, language)}
                      </td>
                      <td className="p-3.5 text-right font-mono" style={{ color: '#475569', fontSize: '14px' }}>
                        {selectedPlatformData.totalSales > 0
                          ? `${((title.sales / selectedPlatformData.totalSales) * 100).toFixed(1)}%`
                          : '0%'
                        }
                      </td>
                    </tr>
                  ))}
                  {selectedTopTitles.length === 0 && (
                    <tr>
                      <td colSpan={4} className="p-8 text-center" style={{ color: '#94A3B8', fontSize: '15px' }}>
                        {language === 'ko' ? '데이터가 없습니다.' : 'データがありません。'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* Platform Comparison Section */}
      <motion.div
        variants={staggerItem}
        className="rounded-xl p-6 mt-6"
        style={{ backgroundColor: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}
      >
        <h3 className="font-semibold mb-4" style={{ color: '#0F1B4C', fontSize: '16px' }}>
          {t(language, 'chart.platformShareTrend')}
        </h3>
        <ResponsiveContainer width="100%" height={400}>
          <AreaChart data={comparisonData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" />
            <XAxis
              dataKey="month"
              stroke="#CBD5E1"
              tick={{ fill: '#64748B', fontSize: 12 }}
              tickFormatter={(val: any) => val.substring(2).replace('-', '/')}
            />
            <YAxis
              stroke="#CBD5E1"
              tick={{ fill: '#64748B', fontSize: 12 }}
              tickFormatter={(val: any) => formatSalesShort(val)}
            />
            <Tooltip
              {...tooltipStyle}
              formatter={(value: any, name: any) => [
                formatSales(value, currency, exchangeRate, language),
                name,
              ]}
            />
            <Legend
              wrapperStyle={{ color: '#334155', fontSize: '13px', fontWeight: 500 }}
            />
            {platforms.map((p) => (
              <Area
                key={p.platform}
                type="monotone"
                dataKey={p.platform}
                stackId="1"
                stroke={getPlatformColor(p.platform)}
                fill={getPlatformColor(p.platform)}
                fillOpacity={0.5}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </motion.div>
    </motion.div>
  );
}
