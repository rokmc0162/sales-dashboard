import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiUnexpected } from '@/lib/api-utils';
import { cachedSupabaseRead } from '@/lib/api-cache';

/** 300초 캐시. 인증은 요청마다, 이 읽기만 공유된다. */
const read = cachedSupabaseRead('dashboard-platform-summary', 300, () =>
  supabaseServer.rpc('get_platform_sales_summary'),
);

/**
 * GET /api/dashboard/platform-summary
 * 전체 플랫폼별 매출 요약 조회 (채널별 총매출, 작품 수, 일평균)
 * @returns PlatformSummaryRow[] — { channel, total_sales, title_count, avg_daily }
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
