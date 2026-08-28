export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from "@/lib/api-auth";

function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

/**
 * GET /api/manage/titles
 * 작품 목록 페이지네이션 조회 (검색, 장르, 제작사, 상태, 포맷 필터 지원)
 * @param search — 작품명 검색 (JP/KR, 선택)
 * @param genre — 장르 ID 필터 (선택)
 * @param company — 제작사 ID 필터 (선택)
 * @param status — 연재 상태 필터 (선택)
 * @param format — 콘텐츠 포맷 필터 (선택)
 * @param active — 활성 여부 필터 (true/false, 선택)
 * @param sortBy — 정렬 컬럼 (기본 created_at)
 * @param sortDir — 정렬 방향 (기본 desc)
 * @param page — 페이지 번호 (기본 1)
 * @param pageSize — 페이지 크기 (기본 50, 최대 200)
 * @returns { rows: Title[], count: number }
 * @dynamic force-dynamic (캐시 없음)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN" });
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const search = searchParams.get('search') || '';
  const genre = searchParams.get('genre') || '';
  const company = searchParams.get('company') || '';
  const status = searchParams.get('status') || '';
  const format = searchParams.get('format') || '';
  const active = searchParams.get('active');
  const sortBy = searchParams.get('sortBy') || 'created_at';
  const sortDir = (searchParams.get('sortDir') || 'desc') as 'asc' | 'desc';
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(searchParams.get('pageSize') || '50', 10)));

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabaseServer
    .from('titles')
    .select(
      '*, genres(code, name_jp, name_kr), production_companies(name)',
      { count: 'exact' }
    );

  if (search) {
    query = query.or(`title_jp.ilike.%${escapeIlike(search)}%,title_kr.ilike.%${escapeIlike(search)}%`);
  }
  if (genre) query = query.eq('genre_id', genre);
  if (company) query = query.eq('production_company_id', company);
  if (status) query = query.eq('serial_status', status);
  if (format) query = query.eq('content_format', format);
  if (active === 'true') query = query.eq('is_active', true);
  if (active === 'false') query = query.eq('is_active', false);

  query = query.order(sortBy, { ascending: sortDir === 'asc' });
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data, count });
}

/**
 * POST /api/manage/titles
 * 작품 생성 (감사 로그 기록)
 * @body Title 필드 — { title_jp, title_kr, genre_id, production_company_id, ... }
 * @returns 생성된 작품 레코드 (201)
 */
export async function POST(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const body = await request.json();

  const { data, error } = await supabaseServer
    .from('titles')
    .insert(body)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabaseServer.from('audit_logs').insert({
    action: 'INSERT',
    table_name: 'titles',
    record_id: data.id,
    new_data: data,
  });

  return NextResponse.json(data, { status: 201 });
}

/**
 * PUT /api/manage/titles
 * 작품 정보 수정 (변경 전/후 감사 로그 기록)
 * @body { id, ...updates } — 수정할 필드
 * @returns 수정된 작품 레코드
 */
export async function PUT(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const body = await request.json();
  const { id, ...updates } = body;

  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const { data: oldData } = await supabaseServer
    .from('titles')
    .select('*')
    .eq('id', id)
    .single();

  const { data, error } = await supabaseServer
    .from('titles')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabaseServer.from('audit_logs').insert({
    action: 'UPDATE',
    table_name: 'titles',
    record_id: id,
    old_data: oldData,
    new_data: data,
  });

  return NextResponse.json(data);
}

/**
 * DELETE /api/manage/titles
 * 작품 삭제 (단건 또는 복수, 감사 로그 기록)
 * @body { id: string } 또는 { ids: string[] }
 * @returns { deleted: number }
 */
export async function DELETE(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const body = await request.json();
  const ids: string[] = body.ids || (body.id ? [body.id] : []);

  if (ids.length === 0) return NextResponse.json({ error: 'id or ids required' }, { status: 400 });

  const { data: oldRows } = await supabaseServer
    .from('titles')
    .select('*')
    .in('id', ids);

  const { error } = await supabaseServer
    .from('titles')
    .delete()
    .in('id', ids);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  for (const row of oldRows || []) {
    await supabaseServer.from('audit_logs').insert({
      action: 'DELETE',
      table_name: 'titles',
      record_id: row.id,
      old_data: row,
    });
  }

  return NextResponse.json({ deleted: ids.length });
}
