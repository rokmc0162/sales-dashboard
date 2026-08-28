import { NextRequest, NextResponse } from "next/server";

import { clearAuthCookies, LEGACY_REFRESH_COOKIE } from "@/lib/api-auth";

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN!;
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID!;
const AUTH0_CLIENT_SECRET = process.env.AUTH0_CLIENT_SECRET!;

export async function POST(request: NextRequest) {
  const refreshToken = request.cookies.get(LEGACY_REFRESH_COOKIE)?.value;

  // Auth0에서 refresh token 무효화
  if (refreshToken) {
    await fetch(`https://${AUTH0_DOMAIN}/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: AUTH0_CLIENT_ID,
        client_secret: AUTH0_CLIENT_SECRET,
        token: refreshToken,
      }),
    }).catch(() => {});
  }

  const response = NextResponse.json({ success: true });
  // The session cookie is stateless: deleting it ends this browser's session,
  // but a copy taken beforehand stays valid until it expires (SESSION_TTL).
  clearAuthCookies(response);

  return response;
}
