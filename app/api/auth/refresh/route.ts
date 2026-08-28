import { NextRequest, NextResponse } from "next/server";

import { attachSessionCookie, clearAuthCookies, LEGACY_REFRESH_COOKIE } from "@/lib/api-auth";
import { tempLoginEnabled } from "@/lib/session";
import { apiError } from "@/lib/api-utils";

const ROLES_NAMESPACE = "https://api.riverse.net/roles";

/**
 * Reads claims out of an Auth0 access token WITHOUT verifying its signature.
 * Only valid on a token that just came back from Auth0's token endpoint.
 */
function extractClaims(accessToken: string): {
  sub: string;
  email: string;
  roles: string[];
} {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64url").toString(),
    );
    return {
      sub: typeof payload.sub === "string" ? payload.sub : "",
      email: typeof payload.email === "string" ? payload.email : "",
      roles: payload[ROLES_NAMESPACE] ?? [],
    };
  } catch {
    return { sub: "", email: "", roles: [] };
  }
}

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET;
const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 7;
const TEMP_ACCESS_TOKEN = "rvjp-temporary-mock-access-token";
const TEMP_REFRESH_TOKEN = "rvjp-temporary-mock-refresh-token";

export async function POST(request: NextRequest) {
  const refreshToken = request.cookies.get(LEGACY_REFRESH_COOKIE)?.value;
  if (!refreshToken) {
    return apiError("No refresh token", 401);
  }

  // 임시 우회 세션. ALLOW_TEMP_LOGIN=1 일 때만 갱신되고, 그 외에는 아래 Auth0 경로로
  // 내려가 실패하면서 쿠키가 정리된다.
  if (tempLoginEnabled() && refreshToken === TEMP_REFRESH_TOKEN) {
    const response = NextResponse.json({
      accessToken: TEMP_ACCESS_TOKEN,
      expiresIn: REFRESH_TOKEN_MAX_AGE,
    });
    const issued = await attachSessionCookie(response, {
      sub: "temporary|riverse",
      email: "temporary@riverse.local",
      roles: ["ADMIN"],
    });
    if (!issued) {
      const failed = NextResponse.json({ error: "Session unavailable" }, { status: 500 });
      clearAuthCookies(failed);
      return failed;
    }
    return response;
  }

  if (!AUTH0_DOMAIN || !AUTH0_CLIENT_ID || !AUTH0_CLIENT_SECRET) {
    console.error("[auth] Auth0 env vars missing — cannot refresh");
    const failed = NextResponse.json({ error: "Refresh unavailable" }, { status: 500 });
    clearAuthCookies(failed);
    return failed;
  }

  const auth0Res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: AUTH0_CLIENT_ID,
      client_secret: AUTH0_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });

  const data = await auth0Res.json();

  if (!auth0Res.ok) {
    const response = NextResponse.json({ error: "Refresh failed" }, { status: 401 });
    clearAuthCookies(response);
    return response;
  }

  // ADMIN role 체크 — role이 제거된 사용자는 refresh 시 차단.
  // 세션은 stateless이므로 이 재검사가 상류 권한 변경을 반영하는 유일한 지점이다.
  const { sub, email, roles } = extractClaims(data.access_token);
  if (!roles.includes("ADMIN")) {
    const forbidden = NextResponse.json(
      { error: "관리자 권한이 없습니다." },
      { status: 403 },
    );
    clearAuthCookies(forbidden);
    return forbidden;
  }

  const response = NextResponse.json({
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  });

  // Refresh Token Rotation
  if (data.refresh_token) {
    response.cookies.set(LEGACY_REFRESH_COOKIE, data.refresh_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: REFRESH_TOKEN_MAX_AGE,
    });
  }

  // This is also the migration path: a user who still holds only the legacy
  // refresh cookie picks up a session here on the app's first refresh call.
  if (!(await attachSessionCookie(response, { sub: sub || "auth0", email, roles }))) {
    const failed = NextResponse.json({ error: "Session unavailable" }, { status: 500 });
    clearAuthCookies(failed);
    return failed;
  }

  return response;
}
