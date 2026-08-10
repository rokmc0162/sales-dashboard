import { NextRequest, NextResponse } from 'next/server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';
import { supabaseServer } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';


/**
 * GET /api/content-master/stats
 * 작품 마스터 경량 통계 — 상태/장르/레이블/형식 분포 및 총계.
 * (전체 행 덤프가 아닌 집계값만 반환)
 * @returns { total, active, byStatus, byGenre, byLabel, byFormat }
 */
export async function GET(request: NextRequest) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  // 활성 행만 대상으로 분류 필드를 조회해 애플리케이션 단에서 집계한다.
  // (테이블 규모가 수백 건 수준이라 별도 RPC 없이 충분히 가볍다.)
  const { data, error, count } = await supabaseServer
    .from('content_master')
    .select('status, genre, label, format', { count: 'exact' })
    .eq('is_active', true);

  if (error) return NextResponse.json({ error: 'content master unavailable' }, { status: 503 });

  const rows = data ?? [];
  const tally = (key: 'status' | 'genre' | 'label' | 'format') => {
    const map = new Map<string, number>();
    for (const r of rows) {
      const v = (r[key] as string | null) ?? '(미지정)';
      map.set(v, (map.get(v) ?? 0) + 1);
    }
    return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
  };

  return NextResponse.json({
    total: count ?? rows.length,
    active: rows.length,
    byStatus: tally('status'),
    byGenre: tally('genre'),
    byLabel: tally('label'),
    byFormat: tally('format'),
  });
}
