import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';

export const dynamic = 'force-dynamic';

function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/**
 * GET /api/sales/paginated
 * 매출 데이터 페이지네이션 조회 (플랫폼, 작품명, 날짜 범위 필터 지원)
 * @param page — 페이지 번호 (기본 1)
 * @param pageSize — 페이지 크기 (기본 50, 최대 200)
 * @param platform — 플랫폼 채널 필터 (선택)
 * @param titleSearch — 작품명 검색 (선택)
 * @param startDate — 시작일 (선택)
 * @param endDate — 종료일 (선택)
 * @param sortBy — 정렬 컬럼 (기본 sale_date)
 * @param sortDir — 정렬 방향 (기본 desc)
 * @returns { rows: DailySale[], count: number }
 * @dynamic force-dynamic (캐시 없음)
 */
export async function GET(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(searchParams.get('pageSize') || '50', 10)));
  const platform = searchParams.get('platform');
  const titleSearch = searchParams.get('titleSearch');
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');
  const sortBy = searchParams.get('sortBy') || 'sale_date';
  const sortDir = searchParams.get('sortDir') === 'asc';

  let query = supabaseServer
    .from('daily_sales_v2')
    .select('*', { count: 'exact' });

  if (platform) query = query.eq('channel', platform);
  if (titleSearch) query = query.ilike('title_jp', `%${escapeIlike(titleSearch)}%`);
  if (startDate) query = query.gte('sale_date', startDate);
  if (endDate) query = query.lte('sale_date', endDate);

  query = query.order(sortBy, { ascending: sortDir });

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data, count });
}
