import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';
import { readBoundedJson } from '@/lib/auth-route.server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/manage/reset-sales
 * 매출 데이터 삭제 (전체 또는 기간별)
 * body: { startDate?: string, endDate?: string }
 * startDate/endDate 없으면 전체 삭제
 */
export async function POST(request: NextRequest) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await readBoundedJson(request, 2_048);
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { startDate, endDate } = body as Record<string, unknown>;
  const validDate = (value: unknown) =>
    value === undefined || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (!validDate(startDate) || !validDate(endDate)) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  try {
    const isFullReset = !startDate && !endDate;

    // 1. daily_sales_v2 삭제
    let query = supabaseServer.from('daily_sales_v2').delete();
    if (isFullReset) {
      query = query.gte('id', 0);
    } else {
      if (typeof startDate === 'string') query = query.gte('sale_date', startDate);
      if (typeof endDate === 'string') query = query.lte('sale_date', endDate);
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
      : `${typeof startDate === 'string' ? startDate : ''} ~ ${typeof endDate === 'string' ? endDate : ''} 기간 매출 데이터가 삭제되었습니다.`;

    return NextResponse.json({ success: true, message: msg });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
