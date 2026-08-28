import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = 'force-dynamic';

/**
 * GET /api/dashboard/platform-detail?channel=X&start=YYYY-MM-DD&end=YYYY-MM-DD
 * 특정 플랫폼 상세 정보 조회 (기간 필터 지원)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const channel = searchParams.get('channel');
  const start = searchParams.get('start');
  const end = searchParams.get('end');

  if (!channel) {
    return NextResponse.json({ error: 'channel parameter is required' }, { status: 400 });
  }

  // 3인자 오버로드로 명시 호출 (1인자 함수와 중복되어 있어 파라미터 이름 기반 매칭 강제)
  const params = {
    p_channel: channel,
    p_start_date: start ?? null,
    p_end_date: end ?? null,
  };

  const { data, error } = await supabaseServer.rpc('get_platform_detail', params);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
