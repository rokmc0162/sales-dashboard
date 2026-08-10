import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';

export const revalidate = 300;

/**
 * GET /api/dashboard/title-detail
 * 특정 작품 상세 정보 조회 (총매출, 한국어명, 채널, 월별 추이, 플랫폼 비중, 최근 일별)
 * @param title_jp — 작품 일본어명 (필수)
 * @returns TitleDetailData — { total_sales, title_kr, channels, monthly_trend, platform_breakdown, daily_recent }
 * @cache revalidate 300초 (5분)
 */
export async function GET(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const titleJp = searchParams.get('title_jp');

  if (!titleJp) {
    return NextResponse.json({ error: 'title_jp parameter is required' }, { status: 400 });
  }

  const { data, error } = await supabaseServer.rpc('get_title_detail', {
    p_title_jp: titleJp,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
