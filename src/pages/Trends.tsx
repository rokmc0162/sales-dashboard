import { useMemo } from 'react';
import { useDataLoader } from '../hooks/useDataLoader';
import { useAppState } from '../hooks/useAppState';
import { t } from '../i18n';
import { formatSales, formatSalesShort, formatPercent, getChangeColor } from '../utils/formatters';
import { calcGrowthRate, calcWeekdayPattern } from '../utils/calculations';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from 'recharts';

const CHART_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6'];

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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: '#3b82f6' }} />
      </div>
    );
  }

  const tooltipStyle = {
    contentStyle: { backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: '8px' },
    labelStyle: { color: '#94a3b8' },
    itemStyle: { color: '#f8fafc' },
  };

  const titleName = (item: { titleKR: string; titleJP: string }) =>
    language === 'ko' ? item.titleKR : item.titleJP;

  return (
    <div>
      {/* Page title */}
      <h1 className="text-2xl font-bold mb-6" style={{ color: '#f8fafc' }}>
        {t(language, 'nav.trends')}
      </h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Growth TOP 10 */}
        <div
          className="rounded-xl p-6"
          style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
        >
          <h3 className="text-lg font-semibold mb-4" style={{ color: '#f8fafc' }}>
            {t(language, 'chart.growthTop')} 10
          </h3>
          {growthTop10.length === 0 ? (
            <p className="text-sm" style={{ color: '#94a3b8' }}>
              {language === 'ko' ? '데이터 없음' : 'データなし'}
            </p>
          ) : (
            <div className="space-y-2">
              {growthTop10.map((item, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between py-2 px-3 rounded-lg"
                  style={{ backgroundColor: idx % 2 === 0 ? '#0f172a' : 'transparent' }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
                      style={{
                        backgroundColor: idx < 3 ? '#3b82f6' : '#334155',
                        color: '#f8fafc',
                      }}
                    >
                      {idx + 1}
                    </span>
                    <span className="text-sm truncate" style={{ color: '#f8fafc' }}>
                      {titleName(item.title)}
                    </span>
                  </div>
                  <span
                    className="flex-shrink-0 text-sm font-semibold ml-2"
                    style={{ color: getChangeColor(item.growth) }}
                  >
                    {formatPercent(item.growth)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Decline Alerts */}
        <div
          className="rounded-xl p-6"
          style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
        >
          <h3 className="text-lg font-semibold mb-4" style={{ color: '#f8fafc' }}>
            {t(language, 'chart.declineAlert')}
          </h3>
          {declineAlerts.length === 0 ? (
            <div className="flex items-center gap-2 py-4">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <span className="text-sm" style={{ color: '#22c55e' }}>
                {language === 'ko' ? '30% 이상 하락한 작품이 없습니다' : '30%以上下落した作品はありません'}
              </span>
            </div>
          ) : (
            <div className="space-y-2">
              {declineAlerts.map((item, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between py-2 px-3 rounded-lg"
                  style={{ backgroundColor: 'rgba(239, 68, 68, 0.08)' }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                      <line x1="12" y1="9" x2="12" y2="13" />
                      <line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    <span className="text-sm truncate" style={{ color: '#f8fafc' }}>
                      {titleName(item.title)}
                    </span>
                  </div>
                  <span className="flex-shrink-0 text-sm font-semibold ml-2" style={{ color: '#ef4444' }}>
                    {formatPercent(item.growth)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* New Title Performance */}
      <div
        className="rounded-xl p-6 mb-6"
        style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
      >
        <h3 className="text-lg font-semibold mb-4" style={{ color: '#f8fafc' }}>
          {t(language, 'chart.newTitles')}
        </h3>
        {newTitlePerformance.length === 0 ? (
          <p className="text-sm" style={{ color: '#94a3b8' }}>
            {language === 'ko' ? '최근 60일간 신규 작품이 없습니다' : '過去60日間の新規作品はありません'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ color: '#f8fafc' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #334155' }}>
                  <th className="text-left py-3 px-4 font-medium" style={{ color: '#94a3b8' }}>
                    {t(language, 'table.title')}
                  </th>
                  <th className="text-left py-3 px-4 font-medium" style={{ color: '#94a3b8' }}>
                    {t(language, 'table.date')}
                  </th>
                  <th className="text-right py-3 px-4 font-medium" style={{ color: '#94a3b8' }}>
                    {t(language, 'table.sales')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {newTitlePerformance.map((item, idx) => (
                  <tr
                    key={idx}
                    style={{
                      backgroundColor: idx % 2 === 0 ? '#0f172a' : 'transparent',
                      borderBottom: '1px solid #334155',
                    }}
                  >
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span
                          className="flex-shrink-0 px-1.5 py-0.5 rounded text-xs font-medium"
                          style={{ backgroundColor: 'rgba(34, 197, 94, 0.15)', color: '#22c55e' }}
                        >
                          {t(language, 'trend.new')}
                        </span>
                        <span className="truncate">
                          {language === 'ko' ? item.titleKR : item.titleJP}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-4" style={{ color: '#94a3b8' }}>
                      {item.firstDate}
                    </td>
                    <td className="py-3 px-4 text-right font-medium">
                      {formatSales(item.totalSales, currency, exchangeRate, language)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Weekday Pattern */}
      <div
        className="rounded-xl p-6"
        style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
      >
        <h3 className="text-lg font-semibold mb-1" style={{ color: '#f8fafc' }}>
          {t(language, 'chart.weekdayPattern')}
        </h3>
        {bestDay >= 0 && (
          <p className="text-sm mb-4" style={{ color: '#94a3b8' }}>
            {language === 'ko'
              ? `매출이 가장 높은 요일: ${weekdayData[bestDay].day}요일`
              : `売上最多曜日: ${weekdayData[bestDay].day}曜日`}
          </p>
        )}
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={weekdayData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
            <XAxis
              dataKey="day"
              stroke="#94a3b8"
              tick={{ fill: '#94a3b8', fontSize: 12 }}
            />
            <YAxis
              stroke="#94a3b8"
              tick={{ fill: '#94a3b8', fontSize: 11 }}
              tickFormatter={v => formatSalesShort(v)}
            />
            <Tooltip
              {...tooltipStyle}
              formatter={(value: any) => [
                formatSales(value, currency, exchangeRate, language),
                language === 'ko' ? '평균 매출' : '平均売上',
              ]}
            />
            <Bar dataKey="avgSales" radius={[4, 4, 0, 0]}>
              {weekdayData.map((_, idx) => (
                <Cell
                  key={idx}
                  fill={idx === bestDay ? '#22c55e' : CHART_COLORS[0]}
                  fillOpacity={idx === bestDay ? 1 : 0.7}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
