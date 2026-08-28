import { NextResponse } from "next/server";

import { requireApiAuth, readCookie, LEGACY_REFRESH_COOKIE } from "@/lib/api-auth";

const TEMP_REFRESH_TOKEN = "rvjp-temporary-mock-refresh-token";

/**
 * Auth gate for /api/settlement/*.
 *
 * The signature is unchanged so the twelve call sites keep reading the same
 * way, but the check itself now delegates to the shared session verifier.
 * These routes use the Supabase service role, so this is the only thing
 * standing in front of the raw settlement data.
 *
 * The fixed legacy cookie is still accepted so a browser that has not yet picked
 * up a session (it gets one on the next /api/auth/refresh) keeps working. The
 * follow-up change puts this fallback behind ALLOW_TEMP_LOGIN.
 */
export async function requireSettlementApiAuth(
  request: Request,
): Promise<NextResponse | null> {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN" });
  if (!unauthorized) return null;

  // TODO: remove with the temporary login — legacy compatibility only.
  const legacy = readCookie(request.headers.get("cookie"), LEGACY_REFRESH_COOKIE);
  if (legacy === TEMP_REFRESH_TOKEN) return null;

  return unauthorized;
}
