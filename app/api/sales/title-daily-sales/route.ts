import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sales/title-daily-sales
 * 특정 작품의 일별 매출 조회 (날짜별 합산)
 * @param title_jp — 작품 일본어명 (필수)
 * @returns { sale_date, sales_amount }[] — 일별 매출 배열
 * @dynamic force-dynamic (캐시 없음)
 */
export async function GET(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const titleJp = searchParams.get('title_jp');

  if (!titleJp) {
    return NextResponse.json({ error: 'title_jp parameter is required' }, { status: 400 });
  }

  const { data, error } = await supabaseServer
    .from('daily_sales_v2')
    .select('sale_date, sales_amount')
    .eq('title_jp', titleJp)
    .order('sale_date');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Group by sale_date and sum sales_amount
  const grouped = new Map<string, number>();
  for (const row of data ?? []) {
    const date = row.sale_date;
    grouped.set(date, (grouped.get(date) || 0) + (row.sales_amount || 0));
  }

  const result = Array.from(grouped.entries()).map(([sale_date, sales_amount]) => ({
    sale_date,
    sales_amount,
  }));

  return NextResponse.json(result);
}
