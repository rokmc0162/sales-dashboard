import { NextResponse } from 'next/server';

import { readBoundedJson } from '@/lib/auth-route.server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';
import { supabaseServer } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

const UPLOAD_TYPES = new Set([
  'weekly_report',
  'sokuhochi',
  'initial_sales',
  'content_registry',
  'manual',
]);
const UPLOAD_STATUSES = new Set(['processing', 'completed', 'failed', 'superseded']);
const SAFE_COLUMNS =
  'id,upload_type,source_file,row_count,platforms,status,error_message,storage_path,created_at';

function validStoragePath(value: unknown): value is string | null | undefined {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' &&
      value.length <= 500 &&
      /^uploads\/[A-Za-z0-9/._-]+$/.test(value) &&
      !/(^|\/)\.\.(\/|$)/.test(value))
  );
}

function validateUploadLog(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const uploadType = typeof body.upload_type === 'string' ? body.upload_type : '';
  const status = typeof body.status === 'string' ? body.status : '';
  const sourceFile = typeof body.source_file === 'string' ? body.source_file : '';
  const rowCount = body.row_count;
  const errorMessage = body.error_message;
  const platforms = body.platforms;
  if (
    !UPLOAD_TYPES.has(uploadType) ||
    !UPLOAD_STATUSES.has(status) ||
    sourceFile.length === 0 ||
    sourceFile.length > 255 ||
    !Number.isSafeInteger(rowCount) ||
    (rowCount as number) < 0 ||
    (errorMessage !== null && errorMessage !== undefined &&
      (typeof errorMessage !== 'string' || errorMessage.length > 1_000)) ||
    (platforms !== null && platforms !== undefined &&
      (!Array.isArray(platforms) || platforms.length > 20 ||
        platforms.some((item) => typeof item !== 'string' || item.length > 100))) ||
    !validStoragePath(body.storage_path)
  ) {
    return null;
  }
  return {
    upload_type: uploadType,
    source_file: sourceFile,
    row_count: rowCount as number,
    status,
    error_message: errorMessage ?? null,
    platforms: platforms ?? null,
    storage_path: body.storage_path ?? null,
  };
}

/** 최근 업로드 이력을 Auth0 ADMIN에게만 반환합니다. */
export async function GET(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { data, error } = await supabaseServer
    .from('upload_logs')
    .select(SAFE_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/** 검증된 업로드 이력을 기록합니다. */
export async function POST(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await readBoundedJson(request, 8_192);
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const uploadLog = validateUploadLog(body);
  if (!uploadLog) {
    return NextResponse.json({ error: 'invalid upload log' }, { status: 400 });
  }

  const { data, error } = await supabaseServer
    .from('upload_logs')
    .insert(uploadLog)
    .select(SAFE_COLUMNS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

/** 개별 또는 전체 업로드 이력을 삭제합니다. */
export async function DELETE(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;
  const { searchParams } = new URL(request.url);
  if (searchParams.get('all') === 'true') {
    const { error } = await supabaseServer
      .from('upload_logs')
      .delete()
      .gte('created_at', '2000-01-01');
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }
  const id = searchParams.get('id');
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  const { error } = await supabaseServer
    .from('upload_logs')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
