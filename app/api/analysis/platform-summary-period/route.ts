import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = 'force-dynamic';

/**
 * GET /api/analysis/platform-summary-period
 * 특정 기간의 플랫폼별 매출 요약
 * @param startDate — 조회 시작일 (YYYY-MM-DD, 필수)
 * @param endDate — 조회 종료일 (YYYY-MM-DD, 필수)
 * @returns PlatformSummaryRow[] — { channel, total_sales, title_count, avg_daily }
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');

  if (!startDate || !endDate) {
    return NextResponse.json({ error: 'startDate and endDate required' }, { status: 400 });
  }

  // Paginated fetch from daily_sales_v2 with date range filter
  const allRows: Array<{ channel: string; title_jp: string; sale_date: string; sales_amount: number }> = [];
  const batchSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await supabaseServer
      .from('daily_sales_v2')
      .select('channel, title_jp, sale_date, sales_amount')
      .gte('sale_date', startDate)
      .lte('sale_date', endDate)
      .range(from, from + batchSize - 1);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < batchSize) break;
    from += batchSize;
  }

  // Aggregate by channel
  const channelMap = new Map<string, { total: number; titles: Set<string>; dates: Set<string> }>();
  for (const row of allRows) {
    if (!channelMap.has(row.channel)) {
      channelMap.set(row.channel, { total: 0, titles: new Set(), dates: new Set() });
    }
    const ch = channelMap.get(row.channel)!;
    ch.total += row.sales_amount;
    ch.titles.add(row.title_jp);
    ch.dates.add(row.sale_date);
  }

  const result = Array.from(channelMap.entries())
    .map(([channel, d]) => ({
      channel,
      total_sales: d.total,
      title_count: d.titles.size,
      avg_daily: d.dates.size > 0 ? Math.round(d.total / d.dates.size) : 0,
    }))
    .sort((a, b) => b.total_sales - a.total_sales);

  return NextResponse.json(result);
}
