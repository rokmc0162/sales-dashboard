import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiError, apiFailure } from '@/lib/api-utils';

export const revalidate = 300;

/**
 * GET /api/analysis/title-rankings
 * 작품 랭킹 조회 (현재 기간 vs 이전 기간 비교, 순위 변동 포함)
 * @param currentStart — 현재 기간 시작일 (필수)
 * @param currentEnd — 현재 기간 종료일 (필수)
 * @param prevStart — 이전 기간 시작일 (필수)
 * @param prevEnd — 이전 기간 종료일 (필수)
 * @param limit — 결과 수 제한 (기본 50)
 * @returns TitleRankingRow[] — { title_jp, title_kr, channels, current_sales, prev_sales, rank_change }
 * @cache revalidate 300초 (5분)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const currentStart = searchParams.get('currentStart');
  const currentEnd = searchParams.get('currentEnd');
  const prevStart = searchParams.get('prevStart');
  const prevEnd = searchParams.get('prevEnd');
  const limit = searchParams.get('limit');

  if (!currentStart || !currentEnd || !prevStart || !prevEnd) {
    return apiError('currentStart, currentEnd, prevStart, prevEnd are required', 400);
  }

  const { data, error } = await supabaseServer.rpc('get_title_rankings', {
    p_current_start: currentStart,
    p_current_end: currentEnd,
    p_prev_start: prevStart,
    p_prev_end: prevEnd,
    p_limit: limit ? parseInt(limit, 10) : 50,
  });
  if (error) return apiFailure(error);
  return NextResponse.json(data);
}
