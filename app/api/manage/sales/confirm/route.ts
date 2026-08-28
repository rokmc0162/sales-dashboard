export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiError, apiFailure } from '@/lib/api-utils';

/**
 * POST /api/manage/sales/confirm
 * 속보치(임시) 매출 데이터를 확정 처리 (is_preliminary = false)
 * @body { ids: number[] } — 확정할 레코드 ID 배열
 * @returns { confirmed: number } — 확정된 행 수
 * @dynamic force-dynamic (캐시 없음)
 */
export async function POST(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const body = await request.json();
  const { ids } = body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return apiError('ids array is required', 400);
  }

  const { data, error } = await supabaseServer
    .from('daily_sales_v2')
    .update({ is_preliminary: false })
    .in('id', ids)
    .select();

  if (error) return apiFailure(error);

  await supabaseServer.from('audit_logs').insert({
    action: 'UPDATE',
    table_name: 'daily_sales_v2',
    record_id: `confirm_${ids.length}`,
    new_data: { confirmed_ids: ids, count: ids.length },
  });

  return NextResponse.json({ confirmed: data?.length || 0 });
}
