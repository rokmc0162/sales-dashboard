import type { DailySale, TitleSummary } from '../types';

export function calcMoMChange(monthlySales: { month: string; totalSales: number }[]): number {
  if (monthlySales.length < 2) return 0;
  const sorted = [...monthlySales].sort((a, b) => a.month.localeCompare(b.month));
  const current = sorted[sorted.length - 1].totalSales;
  const previous = sorted[sorted.length - 2].totalSales;
  if (previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

export function calcGrowthRate(titles: TitleSummary[], _days: number = 30): { title: TitleSummary; growth: number }[] {
  return titles.map(title => {
    const trend = title.monthlyTrend;
    if (trend.length < 2) return { title, growth: 0 };
    const recent = trend[trend.length - 1].sales;
    const previous = trend[trend.length - 2].sales;
    const growth = previous > 0 ? ((recent - previous) / previous) * 100 : 0;
    return { title, growth };
  }).sort((a, b) => b.growth - a.growth);
}

export function calcWeekdayPattern(dailySales: DailySale[]): { day: string; dayIndex: number; avgSales: number }[] {
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const totals = new Array(7).fill(0);
  const counts = new Array(7).fill(0);

  dailySales.forEach(sale => {
    const d = new Date(sale.date);
    const day = d.getDay();
    totals[day] += sale.sales;
    counts[day]++;
  });

  return dayNames.map((name, i) => ({
    day: name,
    dayIndex: i,
    avgSales: counts[i] > 0 ? Math.round(totals[i] / counts[i]) : 0,
  }));
}

export function filterByDateRange(data: DailySale[], start: string, end: string): DailySale[] {
  return data.filter(d => d.date >= start && d.date <= end);
}

export function groupByMonth(data: DailySale[]): Map<string, number> {
  const map = new Map<string, number>();
  data.forEach(d => {
    const month = d.date.substring(0, 7);
    map.set(month, (map.get(month) || 0) + d.sales);
  });
  return map;
}

export function groupByWeek(data: DailySale[]): Map<string, number> {
  const map = new Map<string, number>();
  data.forEach(d => {
    const date = new Date(d.date);
    const weekStart = new Date(date);
    weekStart.setDate(date.getDate() - date.getDay());
    const key = weekStart.toISOString().substring(0, 10);
    map.set(key, (map.get(key) || 0) + d.sales);
  });
  return map;
}
