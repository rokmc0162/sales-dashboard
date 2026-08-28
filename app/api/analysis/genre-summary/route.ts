import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiFailure } from '@/lib/api-utils';

export const revalidate = 300;

/**
 * GET /api/analysis/genre-summary
 * 장르별 매출 요약 조회 (장르코드, 장르명, 총매출, 작품 수, 일평균)
 * @param startDate — 조회 시작일 (YYYY-MM-DD, 선택)
 * @param endDate — 조회 종료일 (YYYY-MM-DD, 선택)
 * @returns GenreSalesRow[] — { genre_code, genre_kr, total_sales, title_count, avg_daily }
 * @cache revalidate 300초 (5분)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate') || undefined;
  const endDate = searchParams.get('endDate') || undefined;

  const { data, error } = await supabaseServer.rpc('get_genre_sales_summary', {
    p_start_date: startDate ?? null,
    p_end_date: endDate ?? null,
  });
  if (error) return apiFailure(error);
  return NextResponse.json(data);
}
