import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiUnexpected } from '@/lib/api-utils';
import { cachedSupabaseRead } from '@/lib/api-cache';

/** 300초 캐시. 인증은 요청마다, 이 읽기만 공유된다. */
const read = cachedSupabaseRead('dashboard-kpis', 300, () =>
  supabaseServer.rpc('get_dashboard_kpis'),
);

/**
 * GET /api/dashboard/kpis
 * 대시보드 KPI 데이터 조회 (총매출, 이번달, 전월대비, 활성 작품/플랫폼 수)
 * @returns KPIData — { total_sales, this_month_sales, last_month_sales, mom_change, active_titles, active_platforms }
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
