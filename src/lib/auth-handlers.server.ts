import "server-only";

import { createHash } from "node:crypto";

import type { AccessTokenVerifier } from "./auth-core";
import {
  isSameOriginMutation,
  REFRESH_TOKEN_COOKIE,
  uniqueCookieValue,
  verifySettlementAccessToken,
} from "./auth-core";
import {
  authJson,
  type AuthFetchDependencies,
  AuthUpstreamTimeoutError,
  discardUpstreamBody,
  fetchAuthUpstream,
  readBoundedJson,
  readBoundedUpstreamJson,
} from "./auth-route.server";
import {
  ACCESS_TOKEN_COOKIE,
  accessTokenMaxAge,
  clearAuthCookies,
  setAccessTokenCookie,
  setRefreshTokenCookie,
} from "./auth-session.server";
import {
  readAuth0VerifierConfig,
  verifyAuth0AccessToken,
} from "./auth-verifier.server";
import { supabaseServer } from "./supabase-server";

type Auth0TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
};

export type AuthHandlerDependencies = AuthFetchDependencies & {
  verifier?: AccessTokenVerifier;
  now?: () => number;
};

type ForgotPasswordDependencies = AuthFetchDependencies & {
  rateLimiter?: (key: string) => Promise<number | null>;
};

const FORGOT_PASSWORD_BODY_MAX_BYTES = 1_024;

function forgotPasswordLimiterKey(request: Request): string | null {
  const forwarded = request.headers.get("x-vercel-forwarded-for")
    ?? (process.env.NODE_ENV === "production"
      ? null
      : request.headers.get("x-real-ip") ?? request.headers.get("x-forwarded-for"));
  const address = forwarded?.split(",")[0]?.trim();
  if (!address) return null;
  return createHash("sha256").update(address).digest("hex");
}

async function consumeForgotPasswordRateLimit(key: string): Promise<number | null> {
  const { data, error } = await supabaseServer.rpc(
    "consume_forgot_password_rate_limit",
    { p_key: key, p_limit: 5, p_window_seconds: 600 },
  );
  if (error || (data !== null && !Number.isSafeInteger(data))) {
    throw new Error("rate limiter unavailable");
  }
  return data as number | null;
}

function auth0Config(options: { audience: boolean }) {
  let issuer: string;
  try {
    issuer = readAuth0VerifierConfig().issuer;
  } catch {
    return null;
  }

  const clientId = process.env.AUTH0_CLIENT_ID;
  const clientSecret = process.env.AUTH0_CLIENT_SECRET;
  const audience = process.env.AUTH0_AUDIENCE;
  if (
    !clientId ||
    !clientSecret ||
    (options.audience && !audience)
  ) {
    return null;
  }
  return { issuer, clientId, clientSecret, audience };
}

function validCredentials(
  value: unknown,
): value is { email: string; password: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { email, password } = value as Record<string, unknown>;
  return (
    typeof email === "string" &&
    email.length > 0 &&
    email.length <= 254 &&
    typeof password === "string" &&
    password.length > 0 &&
    password.length <= 1_024
  );
}

function validEmailBody(value: unknown): value is { email: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { email } = value as Record<string, unknown>;
  return (
    typeof email === "string" &&
    email.length > 0 &&
    email.length <= 254 &&
    !/[\r\n]/.test(email) &&
    email.includes("@")
  );
}

function validUserProfile(
  value: unknown,
): value is { email: string; name: string; picture?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { email, name, picture } = value as Record<string, unknown>;
  return (
    typeof email === "string" &&
    email.length > 0 &&
    email.length <= 254 &&
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 512 &&
    (picture === undefined ||
      (typeof picture === "string" && picture.length <= 2_048))
  );
}

function rejectedSession(status: 401 | 403 = 401) {
  const response = authJson(
    { error: status === 401 ? "Unauthorized" : "Forbidden" },
    { status },
  );
  clearAuthCookies(response);
  return response;
}

function transientFailure(status: 429 | 502 | 503) {
  return authJson({ error: "Authentication unavailable" }, { status });
}

function rejectCrossOriginMutation(request: Request): Response | null {
  return isSameOriginMutation(request)
    ? null
    : authJson({ error: "Forbidden" }, { status: 403 });
}

export async function handleLogin(
  request: Request,
  dependencies: AuthHandlerDependencies = {},
) {
  const forbidden = rejectCrossOriginMutation(request);
  if (forbidden) return forbidden;

  let credentials: unknown;
  try {
    credentials = await readBoundedJson(request);
  } catch {
    return authJson({ error: "Invalid request" }, { status: 400 });
  }
  if (!validCredentials(credentials)) {
    return authJson({ error: "Invalid request" }, { status: 400 });
  }

  const config = auth0Config({ audience: true });
  if (!config) return transientFailure(503);

  let auth0Response: Response;
  try {
    auth0Response = await fetchAuthUpstream(
      new URL("oauth/token", config.issuer),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "password",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          audience: config.audience,
          scope: "openid profile email offline_access",
          username: credentials.email,
          password: credentials.password,
        }),
      },
      dependencies,
    );
  } catch (error) {
    return transientFailure(
      error instanceof AuthUpstreamTimeoutError ? 503 : 502,
    );
  }

  if (!auth0Response.ok) {
    await discardUpstreamBody(auth0Response);
    const status =
      auth0Response.status === 429
        ? 429
        : auth0Response.status >= 500
          ? 502
          : 401;
    return authJson(
      {
        error:
          status === 401
            ? "Authentication failed"
            : "Authentication unavailable",
      },
      { status },
    );
  }

  let data: Auth0TokenResponse;
  try {
    data = (await readBoundedUpstreamJson(
      auth0Response,
      dependencies,
    )) as Auth0TokenResponse;
  } catch (error) {
    return transientFailure(
      error instanceof AuthUpstreamTimeoutError ? 503 : 502,
    );
  }

  if (
    !data ||
    typeof data !== "object" ||
    typeof data.access_token !== "string" ||
    typeof data.refresh_token !== "string" ||
    data.refresh_token.length === 0
  ) {
    return transientFailure(502);
  }

  const nowSeconds = (dependencies.now ?? (() => Math.floor(Date.now() / 1_000)))();
  const verified = await verifySettlementAccessToken(
    data.access_token,
    dependencies.verifier ?? verifyAuth0AccessToken,
    () => nowSeconds,
  );
  if (!verified.ok) {
    return verified.status === 403
      ? rejectedSession(403)
      : transientFailure(502);
  }
  const maxAge = accessTokenMaxAge(data.expires_in, verified.payload.exp, nowSeconds);
  if (!maxAge) return transientFailure(502);

  const response = authJson({ expiresIn: maxAge });
  setAccessTokenCookie(response, data.access_token, maxAge);
  setRefreshTokenCookie(response, data.refresh_token);
  return response;
}

export async function handleRefresh(
  request: Request,
  dependencies: AuthHandlerDependencies = {},
) {
  const forbidden = rejectCrossOriginMutation(request);
  if (forbidden) return forbidden;

  const refreshToken = uniqueCookieValue(
    request.headers.get("cookie"),
    REFRESH_TOKEN_COOKIE,
  );
  if (!refreshToken) return rejectedSession();

  const config = auth0Config({ audience: false });
  if (!config) return transientFailure(503);

  let auth0Response: Response;
  try {
    auth0Response = await fetchAuthUpstream(
      new URL("oauth/token", config.issuer),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: refreshToken,
        }),
      },
      dependencies,
    );
  } catch (error) {
    return transientFailure(
      error instanceof AuthUpstreamTimeoutError ? 503 : 502,
    );
  }

  if (!auth0Response.ok) {
    await discardUpstreamBody(auth0Response);
    if ([400, 401, 403].includes(auth0Response.status)) {
      return rejectedSession();
    }
    return transientFailure(auth0Response.status === 429 ? 429 : 502);
  }

  let data: Auth0TokenResponse;
  try {
    data = (await readBoundedUpstreamJson(
      auth0Response,
      dependencies,
    )) as Auth0TokenResponse;
  } catch (error) {
    return transientFailure(
      error instanceof AuthUpstreamTimeoutError ? 503 : 502,
    );
  }

  if (
    !data ||
    typeof data !== "object" ||
    typeof data.access_token !== "string"
  ) {
    return transientFailure(502);
  }

  const nowSeconds = (dependencies.now ?? (() => Math.floor(Date.now() / 1_000)))();
  const verified = await verifySettlementAccessToken(
    data.access_token,
    dependencies.verifier ?? verifyAuth0AccessToken,
    () => nowSeconds,
  );
  if (!verified.ok) {
    return verified.status === 403
      ? rejectedSession(403)
      : transientFailure(502);
  }
  const maxAge = accessTokenMaxAge(data.expires_in, verified.payload.exp, nowSeconds);
  if (!maxAge) return transientFailure(502);

  const response = authJson({ expiresIn: maxAge });
  setAccessTokenCookie(response, data.access_token, maxAge);
  if (typeof data.refresh_token === "string" && data.refresh_token.length > 0) {
    setRefreshTokenCookie(response, data.refresh_token);
  }
  return response;
}

export async function handleProfile(
  request: Request,
  dependencies: AuthHandlerDependencies = {},
) {
  const token = uniqueCookieValue(
    request.headers.get("cookie"),
    ACCESS_TOKEN_COOKIE,
  );
  if (!token) return authJson({ error: "Unauthorized" }, { status: 401 });

  const verified = await verifySettlementAccessToken(
    token,
    dependencies.verifier ?? verifyAuth0AccessToken,
    dependencies.now,
  );
  if (!verified.ok) {
    return rejectedSession(verified.status);
  }

  const config = auth0Config({ audience: false });
  if (!config) return transientFailure(503);

  let auth0Response: Response;
  try {
    auth0Response = await fetchAuthUpstream(
      new URL("userinfo", config.issuer),
      { headers: { Authorization: `Bearer ${token}` } },
      dependencies,
    );
  } catch (error) {
    return transientFailure(
      error instanceof AuthUpstreamTimeoutError ? 503 : 502,
    );
  }

  if (!auth0Response.ok) {
    await discardUpstreamBody(auth0Response);
    const status =
      auth0Response.status === 429
        ? 429
        : [400, 401, 403].includes(auth0Response.status)
          ? 401
          : 502;
    if (status === 401) return rejectedSession();
    return transientFailure(status);
  }

  let profile: unknown;
  try {
    profile = await readBoundedUpstreamJson(auth0Response, dependencies);
  } catch (error) {
    return transientFailure(
      error instanceof AuthUpstreamTimeoutError ? 503 : 502,
    );
  }
  if (!validUserProfile(profile)) return transientFailure(502);

  return authJson({
    email: profile.email,
    name: profile.name,
    ...(profile.picture === undefined ? {} : { picture: profile.picture }),
  });
}

export async function handleLogout(
  request: Request,
  dependencies: AuthFetchDependencies = {},
) {
  const forbidden = rejectCrossOriginMutation(request);
  if (forbidden) return forbidden;

  const refreshToken = uniqueCookieValue(
    request.headers.get("cookie"),
    REFRESH_TOKEN_COOKIE,
  );
  const config = auth0Config({ audience: false });

  if (refreshToken && config) {
    try {
      const auth0Response = await fetchAuthUpstream(
        new URL("oauth/revoke", config.issuer),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            token: refreshToken,
          }),
        },
        dependencies,
      );
      await discardUpstreamBody(auth0Response);
    } catch {
      // Provider revocation is best-effort; local logout must always complete.
    }
  }

  const response = authJson({ success: true });
  clearAuthCookies(response);
  return response;
}

export async function handleForgotPassword(
  request: Request,
  dependencies: ForgotPasswordDependencies = {},
) {
  const forbidden = rejectCrossOriginMutation(request);
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await readBoundedJson(request, FORGOT_PASSWORD_BODY_MAX_BYTES);
  } catch {
    return authJson({ error: "Invalid request" }, { status: 400 });
  }
  if (!validEmailBody(body)) {
    return authJson({ error: "Invalid request" }, { status: 400 });
  }

  const limiterKey = forgotPasswordLimiterKey(request);
  if (!limiterKey) {
    return authJson({ error: "Authentication unavailable" }, { status: 503 });
  }
  let retryAfter: number | null;
  try {
    retryAfter = await (dependencies.rateLimiter ?? consumeForgotPasswordRateLimit)(limiterKey);
  } catch {
    return authJson({ error: "Authentication unavailable" }, { status: 503 });
  }
  if (retryAfter !== null) {
    return authJson(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  const config = auth0Config({ audience: false });
  if (config) {
    try {
      const auth0Response = await fetchAuthUpstream(
        new URL("dbconnections/change_password", config.issuer),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: config.clientId,
            email: body.email,
            connection: "Username-Password-Authentication",
          }),
        },
        dependencies,
      );
      await discardUpstreamBody(auth0Response);
    } catch {
      // Always return the same result so account/provider state is not exposed.
    }
  }

  return authJson({ success: true });
}
