import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiUnexpected } from '@/lib/api-utils';
import { cachedSupabaseRead } from '@/lib/api-cache';

/** 300초 캐시. 인증은 요청마다, 이 읽기만 공유된다. */
const read = cachedSupabaseRead('sales-active-channels', 300, () =>
  supabaseServer
    .from('active_channels')
    .select('*'),
);

/**
 * GET /api/sales/active-channels
 * daily_sales_v2에 실제 존재하는 channel 목록 (필터 UI용)
 * platforms 테이블 code와 실제 저장값이 달라 매칭 실패하는 문제 해결
 * @returns Array<{ channel: string; row_count: number }>
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
