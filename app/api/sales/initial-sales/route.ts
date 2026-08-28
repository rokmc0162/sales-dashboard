import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiFailure } from '@/lib/api-utils';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sales/initial-sales
 * 초기 매출(런칭 후 D1~D8, W1~W12) 데이터 조회 (플랫폼/장르/런칭타입 필터)
 * @param platform — 플랫폼 코드 (선택)
 * @param genre — 장르 (선택)
 * @param launchType — 런칭 타입 (선택)
 * @returns InitialSale[] — 초기 매출 레코드 배열
 * @dynamic force-dynamic (캐시 없음)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const platform = searchParams.get('platform');
  const genre = searchParams.get('genre');
  const launchType = searchParams.get('launchType');

  let query = supabaseServer.from('initial_sales').select('*');

  if (platform) query = query.eq('platform', platform);
  if (genre) query = query.eq('genre', genre);
  if (launchType) query = query.eq('launch_type', launchType);

  const { data, error } = await query;
  if (error) return apiFailure(error);
  return NextResponse.json(data);
}
