import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiUnexpected } from '@/lib/api-utils';

export const dynamic = 'force-dynamic';

/**
 * POST /api/manage/reset-sales
 * 매출 데이터 삭제 (전체 또는 기간별)
 * body: { startDate?: string, endDate?: string }
 * 인증: ADMIN 세션 + 동일 출처 (requireApiAuth)
 * startDate/endDate 없으면 전체 삭제
 */
export async function POST(request: NextRequest) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const { startDate, endDate } = await request.json();

  try {
    const isFullReset = !startDate && !endDate;

    // 1. daily_sales_v2 삭제
    let query = supabaseServer.from('daily_sales_v2').delete();
    if (isFullReset) {
      query = query.gte('id', 0);
    } else {
      if (startDate) query = query.gte('sale_date', startDate);
      if (endDate) query = query.lte('sale_date', endDate);
    }
    const { error: salesError } = await query;
    if (salesError) throw new Error(`매출 삭제 실패: ${salesError.message}`);

    // 2. 전체 초기화 시 upload_logs도 삭제
    if (isFullReset) {
      await supabaseServer.from('upload_logs').delete().gte('created_at', '2000-01-01');
    }

    // 3. Materialized View 갱신
    try {
      await supabaseServer.rpc('refresh_materialized_views');
    } catch { /* MV 갱신 실패해도 계속 */ }

    const msg = isFullReset
      ? '매출 데이터가 전체 초기화되었습니다.'
      : `${startDate || ''} ~ ${endDate || ''} 기간 매출 데이터가 삭제되었습니다.`;

    return NextResponse.json({ success: true, message: msg });
  } catch (err) {
    return apiUnexpected(err);
  }
}
