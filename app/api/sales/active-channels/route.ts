import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiFailure } from '@/lib/api-utils';

export const revalidate = 300;

/**
 * GET /api/sales/active-channels
 * daily_sales_v2에 실제 존재하는 channel 목록 (필터 UI용)
 * platforms 테이블 code와 실제 저장값이 달라 매칭 실패하는 문제 해결
 * @returns Array<{ channel: string; row_count: number }>
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { data, error } = await supabaseServer
    .from('active_channels')
    .select('*');

  if (error) return apiFailure(error);
  return NextResponse.json(data);
}
