export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from "@/lib/api-auth";

/**
 * PUT /api/manage/titles/batch
 * 작품 일괄 수정 (여러 작품에 동일 필드 업데이트, 감사 로그 기록)
 * @body { ids: string[], updates: object } — 대상 ID 배열 및 수정 값
 * @returns { updated: number }
 * @dynamic force-dynamic (캐시 없음)
 */
export async function PUT(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const body = await request.json();
  const { ids, updates } = body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: 'ids array is required' }, { status: 400 });
  }
  if (!updates || Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'updates object is required' }, { status: 400 });
  }

  const { data: oldRows } = await supabaseServer
    .from('titles')
    .select('*')
    .in('id', ids);

  const { data, error } = await supabaseServer
    .from('titles')
    .update(updates)
    .in('id', ids)
    .select();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  for (const row of oldRows || []) {
    const newRow = data?.find((d: Record<string, unknown>) => d.id === row.id);
    await supabaseServer.from('audit_logs').insert({
      action: 'UPDATE',
      table_name: 'titles',
      record_id: row.id,
      old_data: row,
      new_data: newRow,
    });
  }

  return NextResponse.json({ updated: data?.length || 0 });
}
