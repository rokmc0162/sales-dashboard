import { randomUUID } from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { readBoundedJson } from '@/lib/auth-route.server';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';
import { supabaseServer } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEBUG_BUCKET = 'upload-debug';
const MAX_DEBUG_FILE_BYTES = 100 * 1024 * 1024;

function isValidDebugStoragePath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || !path.startsWith('uploads/')) return false;
  const segments = path.split('/');
  return (
    segments[0] === 'uploads' &&
    segments.slice(1).every(
      (segment) =>
        segment.length > 0 &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes('\\') &&
        !segment.includes('\0'),
    )
  );
}

function preparePayload(value: unknown):
  | { ok: true; filename: string; sizeBytes: number }
  | { ok: false } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  const filename = typeof record.filename === 'string' ? record.filename.trim() : '';
  const sizeBytes = typeof record.size_bytes === 'number' ? record.size_bytes : Number.NaN;
  if (
    filename.length === 0 ||
    filename.length > 255 ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > MAX_DEBUG_FILE_BYTES
  ) {
    return { ok: false };
  }
  return { ok: true, filename, sizeBytes };
}

function buildStoragePath(filename: string): string {
  const extensionMatch = filename.match(/\.[A-Za-z0-9]{1,12}$/);
  const extension = extensionMatch?.[0].toLowerCase() ?? '';
  const base = filename
    .slice(0, extensionMatch ? -extension.length : undefined)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 50) || 'upload';
  return `uploads/${randomUUID()}_${base}${extension}`;
}

/** 관리자에게 upload-debug 버킷의 1회용 직접 업로드 권한을 발급합니다. */
export async function POST(request: NextRequest) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await readBoundedJson(request, 8_192);
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const payload = preparePayload(body);
  if (!payload.ok) {
    return NextResponse.json({ error: 'invalid upload metadata' }, { status: 400 });
  }

  const storagePath = buildStoragePath(payload.filename);
  const { data, error } = await supabaseServer.storage
    .from(DEBUG_BUCKET)
    .createSignedUploadUrl(storagePath);

  if (error || !data?.token) {
    return NextResponse.json({ error: 'upload session unavailable' }, { status: 503 });
  }

  return NextResponse.json({ path: storagePath, token: data.token });
}

/** 로그 기록 실패 시 방금 업로드한 debug 원본을 정리합니다. */
export async function DELETE(request: NextRequest) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await readBoundedJson(request, 1_024);
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const path =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).path
      : null;
  if (typeof path !== 'string' || !isValidDebugStoragePath(path)) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }

  const { error } = await supabaseServer.storage.from(DEBUG_BUCKET).remove([path]);
  if (error) {
    return NextResponse.json({ error: 'cleanup unavailable' }, { status: 503 });
  }
  return NextResponse.json({ ok: true });
}

/** 인증된 관리자에게 uploads/ 내부 파일의 단기 다운로드 URL을 발급합니다. */
export async function GET(request: NextRequest) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;

  const path = request.nextUrl.searchParams.get('path');
  if (!path || !isValidDebugStoragePath(path)) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }

  const { data } = await supabaseServer.storage
    .from(DEBUG_BUCKET)
    .createSignedUrl(path, 600);

  if (!data?.signedUrl) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  return NextResponse.json({ downloadUrl: data.signedUrl });
}
