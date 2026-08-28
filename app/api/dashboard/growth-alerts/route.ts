import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiUnexpected } from '@/lib/api-utils';
import { cachedRead } from '@/lib/api-cache';


/**
 * 300초 캐시. 쿼리뿐 아니라 집계까지 캐시한다 — daily_sales_v2 전체를 읽어
 * 작품별로 접는 작업이라 이 라우트에서는 계산이 조회보다 비싸다.
 */
const read = cachedRead('dashboard-growth-alerts', 300, async () => {
  const now = new Date();
  const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStart = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}-01`;

  const { data, error } = await supabaseServer
    .from('daily_sales_v2')
    .select('title_jp, title_kr, sale_date, sales_amount');

  if (error) throw new Error(error.message);

  const titleMap = new Map<string, { title_kr: string | null; thisMonth: number; lastMonth: number }>();

  for (const row of data ?? []) {
    if (!titleMap.has(row.title_jp)) {
      titleMap.set(row.title_jp, { title_kr: row.title_kr, thisMonth: 0, lastMonth: 0 });
    }
    const entry = titleMap.get(row.title_jp)!;
    if (row.sale_date >= thisMonthStart) {
      entry.thisMonth += row.sales_amount;
    } else if (row.sale_date >= lastMonthStart && row.sale_date < thisMonthStart) {
      entry.lastMonth += row.sales_amount;
    }
    if (row.title_kr) entry.title_kr = row.title_kr;
  }

  return Array.from(titleMap.entries())
    .filter(([, v]) => v.lastMonth > 0)
    .map(([title_jp, v]) => ({
      title_jp,
      title_kr: v.title_kr,
      this_month: v.thisMonth,
      last_month: v.lastMonth,
      growth_pct: Math.round(((v.thisMonth - v.lastMonth) / v.lastMonth) * 1000) / 10,
    }))
    .sort((a, b) => a.growth_pct - b.growth_pct)
    .slice(0, 30);
});

/**
 * GET /api/dashboard/growth-alerts
 * 매출 성장/하락 알림 조회 (이번달 vs 전월 비교, 하락폭 순 정렬 상위 30개)
 * @returns GrowthAlertRow[] — { title_jp, title_kr, this_month, last_month, growth_pct }
 * @cache 300초 — 라우트가 아니라 아래 read()에 걸린다
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  try {
    return NextResponse.json(await read());
  } catch (e) {
    return apiUnexpected(e);
  }
}
