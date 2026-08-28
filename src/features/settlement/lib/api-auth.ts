import { NextResponse } from "next/server";

import { requireApiAuth, readCookie, LEGACY_REFRESH_COOKIE } from "@/lib/api-auth";
import { tempLoginEnabled } from "@/lib/session";

const TEMP_REFRESH_TOKEN = "rvjp-temporary-mock-refresh-token";

/**
 * Auth gate for /api/settlement/*.
 *
 * The signature is unchanged so the twelve call sites keep reading the same
 * way, but the check itself now delegates to the shared session verifier.
 * These routes use the Supabase service role, so this is the only thing
 * standing in front of the raw settlement data.
 *
 * The fixed legacy cookie is only honoured while ALLOW_TEMP_LOGIN is set, so in
 * production a valid ADMIN session is the sole way in. Delete the fallback once
 * the temporary login itself is gone.
 */
export async function requireSettlementApiAuth(
  request: Request,
): Promise<NextResponse | null> {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN" });
  if (!unauthorized) return null;

  if (tempLoginEnabled()) {
    const legacy = readCookie(request.headers.get("cookie"), LEGACY_REFRESH_COOKIE);
    if (legacy === TEMP_REFRESH_TOKEN) return null;
  }

  return unauthorized;
}
