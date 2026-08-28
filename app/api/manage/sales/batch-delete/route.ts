export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from "@/lib/api-auth";

/**
 * POST /api/manage/sales/batch-delete
 * 매출 데이터 일괄 삭제 (필터 조건에 해당하는 레코드를 500건씩 배치 삭제)
 * @body { startDate, endDate, dataSource, channel } — 최소 1개 필터 필수
 * @returns { deleted: number } — 삭제된 행 수
 * @dynamic force-dynamic (캐시 없음)
 */
export async function POST(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const body = await request.json();
  const { startDate, endDate, dataSource, channel } = body;

  if (!startDate && !endDate && !dataSource && !channel) {
    return NextResponse.json({ error: 'At least one filter condition is required' }, { status: 400 });
  }

  // Find matching rows
  let query = supabaseServer.from('daily_sales_v2').select('id, title_jp, channel, sale_date, sales_amount');
  if (startDate) query = query.gte('sale_date', startDate);
  if (endDate) query = query.lte('sale_date', endDate);
  if (dataSource) query = query.eq('data_source', dataSource);
  if (channel) query = query.eq('channel', channel);

  const { data: rows, error: findError } = await query;
  if (findError) return NextResponse.json({ error: findError.message }, { status: 500 });
  if (!rows || rows.length === 0) return NextResponse.json({ deleted: 0 });

  const ids = rows.map((r: { id: number }) => r.id);

  // Delete in batches of 500
  const batchSize = 500;
  let totalDeleted = 0;

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const { error } = await supabaseServer
      .from('daily_sales_v2')
      .delete()
      .in('id', batch);

    if (error) {
      return NextResponse.json(
        { error: error.message, deletedSoFar: totalDeleted },
        { status: 500 }
      );
    }
    totalDeleted += batch.length;
  }

  await supabaseServer.from('audit_logs').insert({
    action: 'DELETE',
    table_name: 'daily_sales_v2',
    record_id: `batch_${ids.length}`,
    old_data: { count: ids.length, filter: { startDate, endDate, dataSource, channel } },
  });

  return NextResponse.json({ deleted: totalDeleted });
}
