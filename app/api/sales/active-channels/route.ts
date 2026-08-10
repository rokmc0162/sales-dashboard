import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';

export const revalidate = 300;

/**
 * GET /api/sales/active-channels
 * daily_sales_v2에 실제 존재하는 channel 목록 (필터 UI용)
 * platforms 테이블 code와 실제 저장값이 달라 매칭 실패하는 문제 해결
 * @returns Array<{ channel: string; row_count: number }>
 */
export async function GET(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { data, error } = await supabaseServer
    .from('active_channels')
    .select('*');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
