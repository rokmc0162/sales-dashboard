import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';

export const revalidate = 300;

/**
 * GET /api/dashboard/platform-summary
 * 전체 플랫폼별 매출 요약 조회 (채널별 총매출, 작품 수, 일평균)
 * @returns PlatformSummaryRow[] — { channel, total_sales, title_count, avg_daily }
 * @cache revalidate 300초 (5분)
 */
export async function GET(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { data, error } = await supabaseServer.rpc('get_platform_sales_summary');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
