import { NextRequest, NextResponse } from 'next/server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';
import { supabaseServer } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

const SAFE_SELECT = [
  'id',
  'source_sheet',
  'source_row',
  'status',
  'title_jp',
  'title_kr',
  'management_type',
  'production_company',
  'distribution_company',
  'format',
  'artist',
  'artist_reading',
  'adaptation',
  'adaptation_reading',
  'original_author',
  'original_author_reading',
  'genre',
  'label',
  'weekday',
  'copyright',
  'synopsis',
  'distribution_scope',
  'non_exclusive_conversion_date',
  'service_planned_date',
  'notes',
].join(',');

function normalizeSearch(value: string | null): string {
  return (value ?? '').trim().toLocaleLowerCase();
}


/**
 * GET /api/content-master
 * 작품 마스터 목록 조회 (검색 / 필터 / 페이지네이션).
 * @param page — 페이지 번호 (기본 1)
 * @param pageSize — 페이지 크기 (기본 50, 최대 200)
 * @param q — 작품명(JP/KR) 검색 (선택)
 * @param status — 'service' | 'prep' (선택)
 * @param genre — ジャンル 필터 (선택)
 * @param label — レーベル 필터 (선택)
 * @param format — 形式 필터 (선택)
 * @returns { rows, count }
 */
export async function GET(request: NextRequest) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(searchParams.get('pageSize') || '50', 10)));
  const q = normalizeSearch(searchParams.get('q'));
  const status = searchParams.get('status');
  const genre = searchParams.get('genre');
  const label = searchParams.get('label');
  const format = searchParams.get('format');

  let query = supabaseServer.from('content_master').select(SAFE_SELECT, { count: 'exact' });

  query = query.eq('is_active', true);
  if (status) query = query.eq('status', status);
  if (genre) query = query.eq('genre', genre);
  if (label) query = query.eq('label', label);
  if (format) query = query.eq('format', format);

  query = query.order('status', { ascending: true }).order('source_sheet', { ascending: true }).order('source_row', { ascending: true });

  // Avoid raw PostgREST `.or()` interpolation for title search. The workbook
  // is small enough to search safely in-process after exact DB filters.
  if (q) {
    query = query.limit(5000);
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: 'content master unavailable' }, { status: 503 });

    const filtered = ((data ?? []) as unknown as Array<Record<string, unknown>>).filter((row) => {
      const titleJp = String(row.title_jp ?? '').toLocaleLowerCase();
      const titleKr = String(row.title_kr ?? '').toLocaleLowerCase();
      return titleJp.includes(q) || titleKr.includes(q);
    });
    const from = (page - 1) * pageSize;
    return NextResponse.json({ rows: filtered.slice(from, from + pageSize), count: filtered.length });
  }

  const from = (page - 1) * pageSize;
  query = query.range(from, from + pageSize - 1);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: 'content master unavailable' }, { status: 503 });
  return NextResponse.json({ rows: data, count });
}
