import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiUnexpected } from '@/lib/api-utils';
import { cachedSupabaseRead } from '@/lib/api-cache';

/** 3600초 캐시. 인증은 요청마다, 이 읽기만 공유된다. */
const read = cachedSupabaseRead('sales-genres', 3600, () =>
  supabaseServer
    .from('genres')
    .select('*'),
);

/**
 * GET /api/sales/genres
 * 장르 마스터 목록 조회 (매출 페이지용)
 * @returns Genre[] — 전체 장르 목록
 * @cache 3600초 — 라우트가 아니라 아래 read()에 걸린다
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
