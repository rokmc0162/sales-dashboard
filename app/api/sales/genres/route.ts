import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiFailure } from '@/lib/api-utils';

export const revalidate = 3600;

/**
 * GET /api/sales/genres
 * 장르 마스터 목록 조회 (매출 페이지용)
 * @returns Genre[] — 전체 장르 목록
 * @cache revalidate 3600초 (1시간)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { data, error } = await supabaseServer
    .from('genres')
    .select('*');

  if (error) return apiFailure(error);
  return NextResponse.json(data);
}
