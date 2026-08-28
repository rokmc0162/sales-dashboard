import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiFailure } from '@/lib/api-utils';

export const revalidate = 300;

/**
 * GET /api/sales/title-master
 * 활성 작품 마스터 목록 조회 (제작사명 포함, is_active=true)
 * @returns TitleMasterRow[] — 활성 작품 목록
 * @cache revalidate 300초 (5분)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { data, error } = await supabaseServer
    .from('titles')
    .select('*, production_companies(name), genres(name_jp, name_kr)')
    .eq('is_active', true);

  if (error) return apiFailure(error);
  return NextResponse.json(data);
}
