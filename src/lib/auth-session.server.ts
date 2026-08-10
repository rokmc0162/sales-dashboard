import "server-only";

import type { NextResponse } from "next/server";

export { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "./auth-core";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "./auth-core";

const REFRESH_TOKEN_MAX_AGE = 60 * 60 * 24 * 7;
const ACCESS_TOKEN_MAX_AGE_LIMIT = REFRESH_TOKEN_MAX_AGE;

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict" as const,
    path: "/",
    maxAge,
  };
}

export function accessTokenMaxAge(
  expiresIn: unknown,
  tokenExp: unknown,
  nowSeconds: number = Math.floor(Date.now() / 1_000),
): number | null {
  if (
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    typeof tokenExp !== "number" ||
    !Number.isFinite(tokenExp) ||
    !Number.isFinite(nowSeconds)
  ) {
    return null;
  }
  const providerSeconds = Math.floor(expiresIn);
  const signedSeconds = Math.floor(tokenExp - nowSeconds);
  if (providerSeconds <= 0 || signedSeconds <= 0) return null;
  return Math.min(providerSeconds, signedSeconds, ACCESS_TOKEN_MAX_AGE_LIMIT);
}

export function setAccessTokenCookie(
  response: NextResponse,
  accessToken: string,
  maxAge: number,
) {
  response.cookies.set(
    ACCESS_TOKEN_COOKIE,
    accessToken,
    cookieOptions(maxAge),
  );
}

export function setRefreshTokenCookie(
  response: NextResponse,
  refreshToken: string,
) {
  response.cookies.set(
    REFRESH_TOKEN_COOKIE,
    refreshToken,
    cookieOptions(REFRESH_TOKEN_MAX_AGE),
  );
}

export function clearAuthCookies(response: NextResponse) {
  response.cookies.set(ACCESS_TOKEN_COOKIE, "", cookieOptions(0));
  response.cookies.set(REFRESH_TOKEN_COOKIE, "", cookieOptions(0));
}
