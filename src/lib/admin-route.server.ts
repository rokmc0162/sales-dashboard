import 'server-only';

import { NextResponse } from 'next/server';

import { readBoundedJson } from '@/lib/auth-route.server';

const ADMIN_JSON_MAX_BYTES = 64 * 1024;

export async function readAdminJson(
  request: Request,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: NextResponse }
> {
  try {
    const value = await readBoundedJson(request, ADMIN_JSON_MAX_BYTES);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }),
      };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }),
    };
  }
}
