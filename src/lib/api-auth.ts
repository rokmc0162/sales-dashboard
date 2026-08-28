/**
 * Shared authentication gate for API route handlers.
 *
 * Every route under /api except `auth/*` (the entry points themselves) and
 * `health` (hit by the Vercel cron in vercel.json) goes through this. The
 * middleware matcher deliberately excludes /api, so a route with no call to
 * `requireApiAuth` is fully public — and `src/lib/supabase-server.ts` prefers
 * the service-role key, which bypasses RLS. There is no second line of defence.
 *
 * Authentication travels in the `X-SESSION` cookie, so browser callers need no
 * changes: cookies are sent automatically. That is why this is a cookie and not
 * a bearer token — a bearer scheme would mean editing every client fetch site.
 */
import { NextResponse } from "next/server";

import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  hasAdminRole,
  sessionCookieOptions,
  signSession,
  verifySession,
  type SessionClaims,
  type SessionPayload,
} from "@/lib/session";

/** Cookie issued by the pre-session login flow; still honoured during B-1. */
export const LEGACY_REFRESH_COOKIE = "X-REFRESH-TOKEN";

export interface ApiAuthOptions {
  /** Require this role. Only "ADMIN" is meaningful today. */
  role?: "ADMIN";
  /**
   * Set on anything that writes. Adds an Origin check, because an HttpOnly
   * cookie is attached automatically to cross-site requests too and
   * SameSite=lax alone does not stop a cross-origin POST.
   */
  mutating?: boolean;
}

export function readCookie(header: string | null, name: string): string | null {
  const match = header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`) && part.length > name.length + 1);
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

function requestHost(request: Request): string | null {
  // Vercel terminates TLS upstream, so the original host arrives forwarded.
  const forwarded = request.headers.get("x-forwarded-host");
  if (forwarded) return forwarded.split(",")[0].trim().toLowerCase();
  const host = request.headers.get("host");
  return host ? host.trim().toLowerCase() : null;
}

/**
 * Browsers always send Origin on POST/PUT/PATCH/DELETE, so a missing Origin on
 * a write is not a browser we recognise — reject rather than wave it through.
 * No server-side or CLI caller hits these routes (scripts talk to Postgres
 * directly), so nothing legitimate is lost.
 */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = requestHost(request);
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

export interface AuthenticatedRequest {
  session: SessionPayload;
}

/**
 * Returns a response to send back when the request must be refused, or null
 * when it may proceed. Mirrors the existing `requireSettlementApiAuth` shape so
 * call sites read the same way:
 *
 *     const unauthorized = await requireApiAuth(request);
 *     if (unauthorized) return unauthorized;
 */
export async function requireApiAuth(
  request: Request,
  options: ApiAuthOptions = {},
): Promise<NextResponse | null> {
  if (options.mutating && !sameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  const session = await verifySession(token);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (options.role === "ADMIN" && !hasAdminRole(session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return null;
}

/**
 * Same checks, but hands back the session for routes that need the caller's
 * identity (audit logging). Returns either a refusal or the session.
 */
export async function authenticateApi(
  request: Request,
  options: ApiAuthOptions = {},
): Promise<{ response: NextResponse } | { session: SessionPayload }> {
  if (options.mutating && !sameOrigin(request)) {
    return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  const session = await verifySession(token);
  if (!session) {
    return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  if (options.role === "ADMIN" && !hasAdminRole(session)) {
    return { response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }

  return { session };
}

/**
 * Signs a session and attaches it to `response`.
 *
 * Stage note: if SESSION_SECRET is missing this logs loudly and leaves the
 * response without a session cookie rather than failing the login. While the
 * legacy X-REFRESH-TOKEN path still works, a missing secret degrades instead of
 * locking everyone out. Once the session is the only accepted credential this
 * must become a hard failure.
 */
export async function attachSessionCookie(
  response: NextResponse,
  claims: SessionClaims,
): Promise<boolean> {
  try {
    const token = await signSession(claims);
    response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(SESSION_TTL_SECONDS));
    return true;
  } catch (error) {
    console.error(
      "[auth] failed to issue session cookie — SESSION_SECRET is probably unset:",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** Clears both the session and the legacy refresh cookie with matching options. */
export function clearAuthCookies(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  response.cookies.set(LEGACY_REFRESH_COOKIE, "", sessionCookieOptions(0));
}
