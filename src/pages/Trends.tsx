import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { useDataLoader } from '../hooks/useDataLoader';
import { useAppState } from '../hooks/useAppState';
import { t } from '../i18n';
import { formatSales, formatSalesShort, formatPercent, getChangeColor } from '../utils/formatters';
import { calcGrowthRate, calcWeekdayPattern } from '../utils/calculations';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';

const CHART_COLORS = ['#2563EB', '#7C3AED', '#0891B2', '#16A34A', '#D97706', '#DC2626', '#DB2777', '#0D9488', '#4F46E5', '#EA580C'];

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

const stagger = {
  visible: {
    transition: { staggerChildren: 0.08 },
  },
};

const listItem = {
  hidden: { opacity: 0, x: -12 },
  visible: { opacity: 1, x: 0 },
};

const tooltipStyle = {
  contentStyle: { backgroundColor: '#fff', border: '1px solid #E2E8F0', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' },
  labelStyle: { color: '#475569', fontWeight: 600 },
  itemStyle: { color: '#0F172A' },
};

export function Trends() {
  const data = useDataLoader();
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
    if (data.dailySales.length === 0 || data.titleSummary.length === 0) return [];

    const allDates = data.dailySales.map(d => d.date).sort();
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
  }, [data.dailySales, data.titleSummary]);

  // Weekday pattern
  const weekdayData = useMemo(() => {
    if (data.dailySales.length === 0) return [];
    return calcWeekdayPattern(data.dailySales);
  }, [data.dailySales]);

  const bestDay = useMemo(() => {
    if (weekdayData.length === 0) return -1;
    let maxIdx = 0;
    weekdayData.forEach((d, i) => {
      if (d.avgSales > weekdayData[maxIdx].avgSales) maxIdx = i;
    });
    return maxIdx;
  }, [weekdayData]);

  if (data.loading) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: '400px' }}>
        <div className="animate-spin rounded-full h-10 w-10 border-b-2" style={{ borderColor: '#2563EB' }} />
      </div>
    );
  }

  const titleName = (item: { titleKR: string; titleJP: string }) =>
    language === 'ko' ? item.titleKR : item.titleJP;

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={stagger}
    >
      {/* Page title */}
      <motion.h1
        variants={fadeIn}
        className="font-bold mb-8"
        style={{ color: '#0F1B4C', fontSize: '28px', letterSpacing: '-0.025em' }}
      >
        {t(language, 'nav.trends')}
      </motion.h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Growth TOP 10 */}
        <motion.div
          variants={fadeIn}
          className="rounded-2xl p-6"
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #E2E8F0',
            boxShadow: '0 1px 3px 0 rgba(0,0,0,0.05)',
          }}
        >
          <h3 className="font-bold mb-5" style={{ color: '#0F1B4C', fontSize: '18px' }}>
            {t(language, 'chart.growthTop')} 10
          </h3>
          {growthTop10.length === 0 ? (
            <p style={{ color: '#94A3B8', fontSize: '15px' }}>
              {language === 'ko' ? '데이터 없음' : 'データなし'}
            </p>
          ) : (
            <motion.div variants={stagger} className="space-y-1.5">
              {growthTop10.map((item, idx) => (
                <motion.div
                  key={idx}
                  variants={listItem}
                  className="flex items-center justify-between py-2.5 px-4 rounded-xl transition-colors duration-150"
                  style={{
                    backgroundColor: idx % 2 === 0 ? '#F8FAFC' : 'transparent',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#F1F5F9'; }}
                  onMouseLeave={e => { e.currentTarget.style.backgroundColor = idx % 2 === 0 ? '#F8FAFC' : 'transparent'; }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center font-bold"
                      style={{
                        backgroundColor: idx < 3 ? '#2563EB' : '#E2E8F0',
                        color: idx < 3 ? '#ffffff' : '#64748B',
                        fontSize: '12px',
                      }}
                    >
                      {idx + 1}
                    </span>
                    <span className="truncate font-medium" style={{ color: '#0F172A', fontSize: '14px' }}>
                      {titleName(item.title)}
                    </span>
                  </div>
                  <span
                    className="flex-shrink-0 font-bold ml-3"
                    style={{ color: getChangeColor(item.growth), fontSize: '14px' }}
                  >
                    {formatPercent(item.growth)}
                  </span>
                </motion.div>
              ))}
            </motion.div>
          )}
        </motion.div>

        {/* Decline Alerts */}
        <motion.div
          variants={fadeIn}
          className="rounded-2xl p-6"
          style={{
            backgroundColor: '#ffffff',
            border: '1px solid #E2E8F0',
            boxShadow: '0 1px 3px 0 rgba(0,0,0,0.05)',
          }}
        >
          <h3 className="font-bold mb-5" style={{ color: '#0F1B4C', fontSize: '18px' }}>
            {t(language, 'chart.declineAlert')}
          </h3>
          {declineAlerts.length === 0 ? (
            <div className="flex items-center gap-3 py-5 px-4 rounded-xl" style={{ backgroundColor: '#F0FDF4' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#16A34A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <span className="font-medium" style={{ color: '#16A34A', fontSize: '15px' }}>
                {language === 'ko' ? '30% 이상 하락한 작품이 없습니다' : '30%以上下落した作品はありません'}
              </span>
            </div>
          ) : (
            <motion.div variants={stagger} className="space-y-1.5">
              {declineAlerts.map((item, idx) => (
                <motion.div
                  key={idx}
                  variants={listItem}
                  className="flex items-center justify-between py-2.5 px-4 rounded-xl"
                  style={{ backgroundColor: '#FEF2F2' }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <span className="truncate font-medium" style={{ color: '#0F172A', fontSize: '14px' }}>
                      {titleName(item.title)}
                    </span>
                  </div>
                  <span className="flex-shrink-0 font-bold ml-3" style={{ color: '#DC2626', fontSize: '14px' }}>
                    {formatPercent(item.growth)}
                  </span>
                </motion.div>
              ))}
            </motion.div>
          )}
        </motion.div>
      </div>

      {/* New Title Performance */}
      <motion.div
        variants={fadeIn}
        className="rounded-2xl p-6 mb-6"
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E2E8F0',
          boxShadow: '0 1px 3px 0 rgba(0,0,0,0.05)',
        }}
      >
        <h3 className="font-bold mb-5" style={{ color: '#0F1B4C', fontSize: '18px' }}>
          {t(language, 'chart.newTitles')}
        </h3>
        {newTitlePerformance.length === 0 ? (
          <p style={{ color: '#94A3B8', fontSize: '15px' }}>
            {language === 'ko' ? '최근 60일간 신규 작품이 없습니다' : '過去60日間の新規作品はありません'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" style={{ fontSize: '14px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #E2E8F0' }}>
                  <th className="text-left py-3.5 px-4 font-semibold" style={{ color: '#475569' }}>
                    {t(language, 'table.title')}
                  </th>
                  <th className="text-left py-3.5 px-4 font-semibold" style={{ color: '#475569' }}>
                    {t(language, 'table.date')}
                  </th>
                  <th className="text-right py-3.5 px-4 font-semibold" style={{ color: '#475569' }}>
                    {t(language, 'table.sales')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {newTitlePerformance.map((item, idx) => (
                  <tr
                    key={idx}
                    className="transition-colors duration-150"
                    style={{
                      backgroundColor: idx % 2 === 0 ? '#F8FAFC' : 'transparent',
                      borderBottom: '1px solid #F1F5F9',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#F1F5F9'; }}
                    onMouseLeave={e => { e.currentTarget.style.backgroundColor = idx % 2 === 0 ? '#F8FAFC' : 'transparent'; }}
                  >
                    <td className="py-3.5 px-4">
                      <div className="flex items-center gap-2.5">
                        <span
                          className="flex-shrink-0 px-2 py-1 rounded-md font-bold"
                          style={{
                            backgroundColor: '#F0FDF4',
                            color: '#16A34A',
                            fontSize: '11px',
                            letterSpacing: '0.05em',
                          }}
                        >
                          {t(language, 'trend.new')}
                        </span>
                        <span className="truncate font-medium" style={{ color: '#0F172A' }}>
                          {language === 'ko' ? item.titleKR : item.titleJP}
                        </span>
                      </div>
                    </td>
                    <td className="py-3.5 px-4" style={{ color: '#64748B', fontWeight: 500 }}>
                      {item.firstDate}
                    </td>
                    <td className="py-3.5 px-4 text-right font-bold" style={{ color: '#0F172A', fontSize: '15px' }}>
                      {formatSales(item.totalSales, currency, exchangeRate, language)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </motion.div>

      {/* Weekday Pattern */}
      <motion.div
        variants={fadeIn}
        className="rounded-2xl p-6"
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E2E8F0',
          boxShadow: '0 1px 3px 0 rgba(0,0,0,0.05)',
        }}
      >
        <h3 className="font-bold mb-1" style={{ color: '#0F1B4C', fontSize: '18px' }}>
          {t(language, 'chart.weekdayPattern')}
        </h3>
        {bestDay >= 0 && (
          <p className="mb-5" style={{ color: '#64748B', fontSize: '14px', fontWeight: 500 }}>
            {language === 'ko'
              ? `매출이 가장 높은 요일: ${weekdayData[bestDay].day}요일`
              : `売上最多曜日: ${weekdayData[bestDay].day}曜日`}
          </p>
        )}
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
      </motion.div>
    </motion.div>
  );
}
