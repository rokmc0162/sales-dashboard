import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from "@/lib/api-auth";

export const revalidate = 300;

/**
 * GET /api/dashboard/growth-alerts
 * 매출 성장/하락 알림 조회 (이번달 vs 전월 비교, 하락폭 순 정렬 상위 30개)
 * @returns GrowthAlertRow[] — { title_jp, title_kr, this_month, last_month, growth_pct }
 * @cache revalidate 300초 (5분)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  // RPC has type mismatch (numeric vs bigint), query directly instead
  const now = new Date();
  const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStart = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, '0')}-01`;

  const { data, error } = await supabaseServer
    .from('daily_sales_v2')
    .select('title_jp, title_kr, sale_date, sales_amount');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

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

  const results = Array.from(titleMap.entries())
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

  return NextResponse.json(results);
}
