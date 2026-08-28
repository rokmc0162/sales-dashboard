export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from "@/lib/api-auth";

/**
 * GET /api/manage/genres
 * 장르 목록 조회 (코드 순 정렬)
 * @returns Genre[] — { id, code, name_jp, name_kr }
 * @dynamic force-dynamic (캐시 없음)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN" });
  if (unauthorized) return unauthorized;

  const { data, error } = await supabaseServer
    .from('genres')
    .select('*')
    .order('code', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

/**
 * POST /api/manage/genres
 * 장르 생성
 * @body { code, name_jp, name_kr } — 장르 정보
 * @returns 생성된 장르 레코드
 */
export async function POST(req: NextRequest) {
  const unauthorized = await requireApiAuth(req, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const body = await req.json();
  const { data, error } = await supabaseServer
    .from('genres')
    .insert(body)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * PUT /api/manage/genres
 * 장르 정보 수정
 * @body { id, ...updates } — 수정할 필드
 * @returns 수정된 장르 레코드
 */
export async function PUT(req: NextRequest) {
  const unauthorized = await requireApiAuth(req, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const body = await req.json();
  const { id, ...updates } = body;
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const { data, error } = await supabaseServer
    .from('genres')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/**
 * DELETE /api/manage/genres?id=<id>
 * 장르 삭제
 * @param id — 삭제할 장르 ID (필수)
 * @returns { ok: true }
 */
export async function DELETE(req: NextRequest) {
  const unauthorized = await requireApiAuth(req, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const { error } = await supabaseServer
    .from('genres')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
