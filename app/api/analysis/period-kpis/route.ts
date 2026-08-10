import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';

export const revalidate = 300;

/**
 * GET /api/analysis/period-kpis
 * 특정 기간의 KPI 조회 (총매출, 활성 작품 수, 활성 플랫폼 수)
 * @param startDate — 조회 시작일 (YYYY-MM-DD, 필수)
 * @param endDate — 조회 종료일 (YYYY-MM-DD, 필수)
 * @returns PeriodKPIData — { total_sales, active_titles, active_platforms }
 * @cache revalidate 300초 (5분)
 */
export async function GET(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');

  if (!startDate || !endDate) {
    return NextResponse.json({ error: 'startDate and endDate are required' }, { status: 400 });
  }

  const { data, error } = await supabaseServer.rpc('get_kpis_for_period', {
    p_start_date: startDate,
    p_end_date: endDate,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
