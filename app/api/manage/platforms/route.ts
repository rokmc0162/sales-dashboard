export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';
import { readAdminJson } from '@/lib/admin-route.server';

/**
 * GET /api/manage/platforms
 * 플랫폼 목록 조회 (sort_order 순 정렬)
 * @returns Platform[] — { id, code, name_jp, name_kr, sort_order, ... }
 * @dynamic force-dynamic (캐시 없음)
 */
export async function GET(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { data, error } = await supabaseServer
    .from('platforms')
    .select('*')
    .order('sort_order', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

/**
 * POST /api/manage/platforms
 * 플랫폼 생성
 * @body { code, name_jp, name_kr, sort_order, ... } — 플랫폼 정보
 * @returns 생성된 플랫폼 레코드
 */
export async function POST(req: NextRequest) {
  const unauthorized = await requireGlobalAdminAuth(req);
  if (unauthorized) return unauthorized;
  const parsedBody = await readAdminJson(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;
  const { data, error } = await supabaseServer
    .from('platforms')
    .insert(body)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * PUT /api/manage/platforms
 * 플랫폼 정보 수정
 * @body { id, ...updates } — 수정할 필드
 * @returns 수정된 플랫폼 레코드
 */
export async function PUT(req: NextRequest) {
  const unauthorized = await requireGlobalAdminAuth(req);
  if (unauthorized) return unauthorized;
  const parsedBody = await readAdminJson(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;
  const { id, ...updates } = body;
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const { data, error } = await supabaseServer
    .from('platforms')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * DELETE /api/manage/platforms?id=<id>
 * 플랫폼 삭제
 * @param id — 삭제할 플랫폼 ID (필수)
 * @returns { ok: true }
 */
export async function DELETE(req: NextRequest) {
  const unauthorized = await requireGlobalAdminAuth(req);
  if (unauthorized) return unauthorized;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const { error } = await supabaseServer
    .from('platforms')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
