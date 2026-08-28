import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiUnexpected } from '@/lib/api-utils';
import { cachedSupabaseRead } from '@/lib/api-cache';

/** 300초 캐시. 인증은 요청마다, 이 읽기만 공유된다. */
const read = cachedSupabaseRead('sales-title-master', 300, () =>
  supabaseServer
    .from('titles')
    .select('*, production_companies(name), genres(name_jp, name_kr)')
    .eq('is_active', true),
);

/**
 * GET /api/sales/title-master
 * 활성 작품 마스터 목록 조회 (제작사명 포함, is_active=true)
 * @returns TitleMasterRow[] — 활성 작품 목록
 * @cache 300초 — 라우트가 아니라 아래 read()에 걸린다
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
