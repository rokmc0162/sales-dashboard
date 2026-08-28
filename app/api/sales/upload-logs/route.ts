import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from '@/lib/api-auth';
import { apiError, apiFailure } from '@/lib/api-utils';

export const dynamic = 'force-dynamic';

/**
 * GET /api/sales/upload-logs
 * 최근 업로드 이력 조회 (최신순 20건)
 * @returns UploadLog[] — 업로드 로그 배열
 * @dynamic force-dynamic (캐시 없음)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { data, error } = await supabaseServer
    .from('upload_logs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return apiFailure(error);
  return NextResponse.json(data);
}

/**
 * POST /api/sales/upload-logs
 * 업로드 이력 기록
 * @body { upload_type, source_file, row_count, status } — 업로드 정보
 * @returns 생성된 업로드 로그 레코드
 */
export async function POST(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const body = await request.json();
  const { upload_type, source_file, row_count, status } = body;

  const { data, error } = await supabaseServer
    .from('upload_logs')
    .insert({ upload_type, source_file, row_count, status })
    .select()
    .single();

  if (error) return apiFailure(error);
  return NextResponse.json(data);
}

/**
 * DELETE /api/sales/upload-logs?id=<uuid>
 * 개별 업로드 이력 삭제
 * @param id — 삭제할 로그 ID (필수)
 * @returns { ok: true }
 */
export async function DELETE(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN", mutating: true });
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  if (!id) return apiError('id is required', 400);

  const { error } = await supabaseServer
    .from('upload_logs')
    .delete()
    .eq('id', id);

  if (error) return apiFailure(error);
  return NextResponse.json({ ok: true });
}
