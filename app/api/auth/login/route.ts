import { NextRequest, NextResponse } from "next/server";

import { attachSessionCookie, LEGACY_REFRESH_COOKIE } from "@/lib/api-auth";
import { tempLoginEnabled } from "@/lib/session";

const ROLES_NAMESPACE = "https://api.riverse.net/roles";

/**
 * Reads claims out of an Auth0 access token WITHOUT verifying its signature.
 *
 * Only ever call this on a token that just came back from Auth0's own token
 * endpoint over TLS — that response is the trust boundary. Never call it on a
 * token supplied by a caller.
 */
function extractClaims(accessToken: string): { sub: string; roles: string[] } {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64url").toString(),
    );
    return {
      sub: typeof payload.sub === "string" ? payload.sub : "",
      roles: payload[ROLES_NAMESPACE] ?? [],
    };
  } catch {
    return { sub: "", roles: [] };
  }
}

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;
const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 7; // 7일
const TEMP_ACCESS_TOKEN = "rvjp-temporary-mock-access-token";
const TEMP_REFRESH_TOKEN = "rvjp-temporary-mock-refresh-token";

/**
 * Without these the fetch below would resolve "https://undefined/oauth/token"
 * and surface as an opaque 500. Name the cause instead: an unconfigured
 * deployment is the likeliest reason login breaks after the bypass is disabled.
 */
function auth0Configured(): boolean {
  return Boolean(AUTH0_DOMAIN && AUTH0_CLIENT_ID && AUTH0_CLIENT_SECRET && AUTH0_AUDIENCE);
}

/** A login that cannot mint a session is not a login — say so instead of pretending. */
function sessionUnavailable() {
  return NextResponse.json(
    { error: "서버 세션 설정이 완료되지 않았습니다. 관리자에게 문의하세요." },
    { status: 500 },
  );
}

export async function POST(request: NextRequest) {
  const { email, password } = (await request.json()) as {
    email: string;
    password: string;
  };

  // 임시 우회 로그인. ALLOW_TEMP_LOGIN=1 일 때만 동작하며 프로덕션에서는 미설정이므로 차단된다.
  // 운영 Auth0 이슈가 해결되면 이 블록을 통째로 삭제할 것.
  if (tempLoginEnabled() && /^\d+$/.test(String(password ?? ""))) {
    const response = NextResponse.json({
      accessToken: TEMP_ACCESS_TOKEN,
      expiresIn: REFRESH_TOKEN_MAX_AGE,
      user: {
        email: "temporary@riverse.local",
        name: "RIVERSE 임시 접속",
      },
    });

    response.cookies.set(LEGACY_REFRESH_COOKIE, TEMP_REFRESH_TOKEN, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: REFRESH_TOKEN_MAX_AGE,
    });

    // The temporary login grants full access today, so the session mirrors that
    // until the bypass is removed.
    const issued = await attachSessionCookie(response, {
      sub: "temporary|riverse",
      email: "temporary@riverse.local",
      roles: ["ADMIN"],
    });
    if (!issued) return sessionUnavailable();

    return response;
  }

  if (!auth0Configured()) {
    console.error("[auth] AUTH0_DOMAIN/CLIENT_ID/CLIENT_SECRET/AUDIENCE are not all set");
    return NextResponse.json(
      { error: "로그인 설정이 완료되지 않았습니다. 관리자에게 문의하세요." },
      { status: 500 },
    );
  }

  const auth0Res = await fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "password",
      client_id: AUTH0_CLIENT_ID,
      client_secret: AUTH0_CLIENT_SECRET,
      audience: AUTH0_AUDIENCE,
      scope: "openid profile email offline_access",
      username: email,
      password,
    }),
  });

  const data = await auth0Res.json();

  if (!auth0Res.ok) {
    return NextResponse.json(
      { error: data.error_description ?? data.error },
      { status: auth0Res.status },
    );
  }

  // ADMIN role 체크
  const { sub, roles } = extractClaims(data.access_token);
  if (!roles.includes("ADMIN")) {
    return NextResponse.json(
      { error: "관리자 권한이 없습니다. 관리자에게 문의하세요." },
      { status: 403 },
    );
  }

  const response = NextResponse.json({
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  });

  response.cookies.set(LEGACY_REFRESH_COOKIE, data.refresh_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: REFRESH_TOKEN_MAX_AGE,
  });

  if (!(await attachSessionCookie(response, { sub: sub || email, email, roles }))) {
    return sessionUnavailable();
  }

  return response;
}
