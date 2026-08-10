export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';
import { readAdminJson } from '@/lib/admin-route.server';

/**
 * GET /api/manage/titles/[id]/platforms
 * 특정 작품의 플랫폼 가용 정보 조회 (플랫폼 코드/이름 포함)
 * @param id — 작품 ID (URL 경로)
 * @returns TitlePlatformAvailability[] (platforms 조인 포함)
 * @dynamic force-dynamic (캐시 없음)
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireGlobalAdminAuth(_request);
  if (unauthorized) return unauthorized;

  const { id } = await params;

  const { data, error } = await supabaseServer
    .from('title_platform_availability')
    .select('*, platforms(code, name_jp, name_kr)')
    .eq('title_id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * POST /api/manage/titles/[id]/platforms
 * 작품에 플랫폼 가용 정보 추가
 * @param id — 작품 ID (URL 경로)
 * @body { platform_id, launch_date? } — 플랫폼 ID 및 런칭일
 * @returns 생성된 가용 정보 레코드 (201)
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const parsedBody = await readAdminJson(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;
  const { platform_id, launch_date } = body;

  if (!platform_id) return NextResponse.json({ error: 'platform_id is required' }, { status: 400 });

  const { data, error } = await supabaseServer
    .from('title_platform_availability')
    .insert({ title_id: id, platform_id, launch_date: launch_date || null })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabaseServer.from('audit_logs').insert({
    action: 'INSERT',
    table_name: 'title_platform_availability',
    record_id: `${id}_${platform_id}`,
    new_data: data,
  });

  return NextResponse.json(data, { status: 201 });
}

/**
 * DELETE /api/manage/titles/[id]/platforms
 * 작품의 특정 플랫폼 가용 정보 삭제
 * @param id — 작품 ID (URL 경로)
 * @body { platform_id } — 삭제할 플랫폼 ID
 * @returns { deleted: 1 }
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;
  const { id } = await params;
  const parsedBody = await readAdminJson(request);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value;
  const { platform_id } = body;

  if (!platform_id) return NextResponse.json({ error: 'platform_id is required' }, { status: 400 });

  const { data: oldData } = await supabaseServer
    .from('title_platform_availability')
    .select('*')
    .eq('title_id', id)
    .eq('platform_id', platform_id)
    .single();

  const { error } = await supabaseServer
    .from('title_platform_availability')
    .delete()
    .eq('title_id', id)
    .eq('platform_id', platform_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabaseServer.from('audit_logs').insert({
    action: 'DELETE',
    table_name: 'title_platform_availability',
    record_id: `${id}_${platform_id}`,
    old_data: oldData,
  });

  return NextResponse.json({ deleted: 1 });
}
