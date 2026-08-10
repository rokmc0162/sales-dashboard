import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';

export const revalidate = 300;

/**
 * GET /api/analysis/weekly-trend
 * 주별 매출 추이 조회 (기간 내 주차별 총매출)
 * @param startDate — 조회 시작일 (YYYY-MM-DD, 선택)
 * @param endDate — 조회 종료일 (YYYY-MM-DD, 선택)
 * @returns WeeklyTrendRow[] — { week, total_sales }
 * @cache revalidate 300초 (5분)
 */
export async function GET(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate') || undefined;
  const endDate = searchParams.get('endDate') || undefined;

  const { data, error } = await supabaseServer.rpc('get_weekly_sales_trend', {
    p_start_date: startDate ?? null,
    p_end_date: endDate ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
