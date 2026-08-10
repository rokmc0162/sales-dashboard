import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';

export const revalidate = 300;

/**
 * GET /api/analysis/platform-genre-matrix
 * 플랫폼x장르 매트릭스 데이터 조회 (각 플랫폼-장르 조합별 총매출)
 * @param startDate — 조회 시작일 (YYYY-MM-DD, 선택)
 * @param endDate — 조회 종료일 (YYYY-MM-DD, 선택)
 * @returns PlatformGenreMatrixRow[] — { channel, genre_kr, total_sales }
 * @cache revalidate 300초 (5분)
 */
export async function GET(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get('startDate');
  const endDate = searchParams.get('endDate');

  try {
    // Query daily_sales joined with titles for genre info
    let query = supabaseServer
      .from('daily_sales')
      .select('channel, sales_amount, title_jp');

    if (startDate) query = query.gte('sale_date', startDate);
    if (endDate) query = query.lte('sale_date', endDate);

    const { data: salesData, error: salesError } = await query;
    if (salesError) throw salesError;

    // Get title-genre mapping from titles table
    const { data: titlesData, error: titlesError } = await supabaseServer
      .from('titles')
      .select('title_jp, genre_kr');
    if (titlesError) throw titlesError;

    const genreMap = new Map<string, string>();
    for (const t of titlesData ?? []) {
      if (t.genre_kr) genreMap.set(t.title_jp, t.genre_kr);
    }

    // Aggregate by channel + genre
    const map = new Map<string, number>();
    for (const row of salesData ?? []) {
      const genre = genreMap.get(row.title_jp);
      if (!genre) continue;
      const key = `${row.channel}|||${genre}`;
      map.set(key, (map.get(key) ?? 0) + row.sales_amount);
    }

    const result = Array.from(map.entries()).map(([key, total_sales]) => {
      const [channel, genre_kr] = key.split('|||');
      return { channel, genre_kr, total_sales };
    });

    return NextResponse.json(result);
  } catch (err) {
    console.error('platform-genre-matrix error:', err);
    return NextResponse.json([]);
  }
}
