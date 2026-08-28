export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from "@/lib/api-auth";

/**
 * PUT /api/manage/sales
 * 개별 매출 레코드 수정 (변경 전/후 감사 로그 기록)
 * @body { id, ...updates } — 수정할 필드
 * @returns 수정된 매출 레코드
 * @dynamic force-dynamic (캐시 없음)
 */
export async function PUT(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const body = await request.json();
  const { id, ...updates } = body;

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const { data: oldData } = await supabaseServer
    .from('daily_sales_v2')
    .select('*')
    .eq('id', id)
    .single();

  const { data, error } = await supabaseServer
    .from('daily_sales_v2')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabaseServer.from('audit_logs').insert({
    action: 'UPDATE',
    table_name: 'daily_sales_v2',
    record_id: String(id),
    old_data: oldData,
    new_data: data,
  });

  return NextResponse.json(data);
}

/**
 * DELETE /api/manage/sales
 * 매출 레코드 삭제 (단건 또는 복수, 감사 로그 기록)
 * @body { id: number } 또는 { ids: number[] }
 * @returns { deleted: number }
 */
export async function DELETE(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const body = await request.json();
  const ids: number[] = body.ids || (body.id ? [body.id] : []);

  if (ids.length === 0) return NextResponse.json({ error: 'id or ids required' }, { status: 400 });

  const { data: oldRows } = await supabaseServer
    .from('daily_sales_v2')
    .select('*')
    .in('id', ids);

  const { error } = await supabaseServer
    .from('daily_sales_v2')
    .delete()
    .in('id', ids);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  for (const row of oldRows || []) {
    await supabaseServer.from('audit_logs').insert({
      action: 'DELETE',
      table_name: 'daily_sales_v2',
      record_id: String(row.id),
      old_data: row,
    });
  }

  return NextResponse.json({ deleted: ids.length });
}
