import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from "@/lib/api-auth";

export const revalidate = 300;

/**
 * GET /api/dashboard/top-titles
 * 매출 상위 작품 목록 조회 (작품명, 채널, 총매출, 매출일수)
 * @param limit — 조회 수 (기본 20)
 * @param month — 특정 월 필터 (YYYY-MM, 선택)
 * @returns TopTitleRow[] — { title_jp, title_kr, channels, total_sales, day_count }
 * @cache revalidate 300초 (5분)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const p_limit = parseInt(searchParams.get('limit') || '20', 10);
  const p_month = searchParams.get('month') || undefined;

  const { data, error } = await supabaseServer.rpc('get_top_titles', {
    p_limit,
    p_month: p_month ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
