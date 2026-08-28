import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiUnexpected } from '@/lib/api-utils';
import { cachedSupabaseRead } from '@/lib/api-cache';

/** 300초 캐시. 인증은 요청마다, 이 읽기만 공유된다. */
const read = cachedSupabaseRead('dashboard-monthly-trend', 300, () =>
  supabaseServer.rpc('get_monthly_sales_trend'),
);

/**
 * GET /api/dashboard/monthly-trend
 * 월별 매출 추이 조회 (전체 기간 월별 총매출)
 * @returns MonthlyTrendRow[] — { month, total_sales }
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
