export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';
import { readAdminJson } from '@/lib/admin-route.server';

/**
 * GET /api/manage/companies
 * 제작사 목록 조회 (이름순 정렬, 각 제작사의 작품 수 포함)
 * @returns { id, name, title_count }[]
 * @dynamic force-dynamic (캐시 없음)
 */
export async function GET(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { data, error } = await supabaseServer
    .from('production_companies')
    .select('*, titles(count)')
    .order('name', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const result = (data ?? []).map((c: Record<string, unknown>) => ({
    id: c.id,
    name: c.name,
    title_count: Array.isArray(c.titles) ? ((c.titles as Record<string, number>[])[0]?.count ?? 0) : 0,
  }));

  return NextResponse.json(result);
}

/**
 * POST /api/manage/companies
 * 제작사 생성 또는 병합. action='merge'이면 sourceId의 작품을 targetId로 이전 후 삭제
 * @body { name } — 신규 생성 / { action: 'merge', sourceId, targetId } — 병합
 * @returns 생성된 제작사 또는 { ok: true }
 */
export async function POST(req: NextRequest) {
  const unauthorized = await requireGlobalAdminAuth(req);
  if (unauthorized) return unauthorized;
  const parsedBody = await readAdminJson(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;

  if (body.action === 'merge') {
    const { sourceId, targetId } = body;
    if (!sourceId || !targetId) {
      return NextResponse.json({ error: 'sourceId and targetId are required' }, { status: 400 });
    }

    const { error: updateError } = await supabaseServer
      .from('titles')
      .update({ production_company_id: targetId })
      .eq('production_company_id', sourceId);

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    const { error: deleteError } = await supabaseServer
      .from('production_companies')
      .delete()
      .eq('id', sourceId);

    if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  }

  const { data, error } = await supabaseServer
    .from('production_companies')
    .insert({ name: body.name })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * PUT /api/manage/companies
 * 제작사 정보 수정
 * @body { id, ...updates } — 수정할 필드
 * @returns 수정된 제작사 레코드
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
    .from('production_companies')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * DELETE /api/manage/companies?id=<id>
 * 제작사 삭제
 * @param id — 삭제할 제작사 ID (필수)
 * @returns { ok: true }
 */
export async function DELETE(req: NextRequest) {
  const unauthorized = await requireGlobalAdminAuth(req);
  if (unauthorized) return unauthorized;
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const { error } = await supabaseServer
    .from('production_companies')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
