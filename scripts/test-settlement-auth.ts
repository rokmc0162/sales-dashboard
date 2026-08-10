import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { NextRequest } from "next/server";

import * as forgotPasswordRoute from "../app/api/auth/forgot-password/route";
import * as loginRouteModule from "../app/api/auth/login/route";
import * as logoutRouteModule from "../app/api/auth/logout/route";
import * as profileRoute from "../app/api/auth/profile/route";
import * as refreshRouteModule from "../app/api/auth/refresh/route";
import { GET as getContentMaster } from "../app/api/content-master/route";
import { GET as getContentMasterStats } from "../app/api/content-master/stats/route";
import {
  handleForgotPassword,
  handleLogin,
  handleLogout,
  handleProfile,
  handleRefresh,
} from "../src/lib/auth-handlers.server";
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  ROLES_CLAIM,
} from "../src/lib/auth-core";
import {
  authorizeSettlementRequest,
  type SettlementAccessTokenVerifier,
  type SettlementRole,
} from "../src/features/settlement/lib/auth/core";
import {
  createAuth0AccessTokenVerifier,
  readAuth0VerifierConfig,
  requireSettlementAuth,
} from "../src/features/settlement/lib/auth/server";
import {
  refreshDelayMs,
  refreshRetryDelayMs,
  shouldClearAuthState,
} from "../src/providers/auth-core";
import { requireGlobalAdminAuth } from "../src/lib/global-admin-auth.server";
import { accessTokenMaxAge } from "../src/lib/auth-session.server";

const NOW_SECONDS = 2_000_000_000;
const ISSUER = "https://tenant.example.auth0.com/";
const AUDIENCE = "https://test-api.example";
const JWT_SHAPED_TOKEN =
  "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature";

function request(
  method: string,
  options: { cookie?: string; origin?: string; secFetchSite?: string } = {},
) {
  const headers = new Headers();
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.origin) headers.set("origin", options.origin);
  if (options.secFetchSite) headers.set("sec-fetch-site", options.secFetchSite);
  return new Request("https://dashboard.example/api/settlement/jobs", {
    method,
    headers,
  });
}

function nextRequest(
  path: string,
  init: ConstructorParameters<typeof NextRequest>[1] = {},
) {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (path.startsWith("/api/auth/") && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    if (!headers.has("origin")) headers.set("origin", "https://dashboard.example");
    if (!headers.has("sec-fetch-site")) headers.set("sec-fetch-site", "same-origin");
  }
  if (path === "/api/auth/forgot-password" && !headers.has("x-vercel-forwarded-for")) {
    headers.set("x-vercel-forwarded-for", "192.0.2.1");
  }
  return new NextRequest(`https://dashboard.example${path}`, { ...init, headers });
}

function loginRequest(body: unknown, headers: HeadersInit = {}) {
  return nextRequest("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function verifierFor(roles: unknown, overrides: Record<string, unknown> = {}) {
  const verifier: SettlementAccessTokenVerifier = async () => ({
    sub: "auth0|operator",
    exp: NOW_SECONDS + 60,
    [ROLES_CLAIM]: roles,
    ...overrides,
  });
  return verifier;
}

async function expectGuardStatus(
  req: Request,
  minimumRole: SettlementRole,
  verifier: SettlementAccessTokenVerifier,
  expectedStatus: number,
) {
  const response = await requireSettlementAuth(req, minimumRole, {
    verifier,
    now: () => NOW_SECONDS,
  });
  assert.ok(response instanceof Response);
  assert.equal(response.status, expectedStatus);
  assert.deepEqual(await response.json(), {
    error: expectedStatus === 401 ? "Unauthorized" : "Forbidden",
  });
}

async function testRoleMatrix() {
  const authRequest = request("GET", {
    cookie: `${ACCESS_TOKEN_COOKIE}=${JWT_SHAPED_TOKEN}`,
  });
  const cases: Array<{
    providerRole: string;
    expectedRole: SettlementRole;
    operator: boolean;
    admin: boolean;
  }> = [
    { providerRole: "ADMIN", expectedRole: "admin", operator: true, admin: true },
    {
      providerRole: "settlement_admin",
      expectedRole: "admin",
      operator: true,
      admin: true,
    },
    {
      providerRole: "settlement_operator",
      expectedRole: "operator",
      operator: true,
      admin: false,
    },
  ];

  for (const roleCase of cases) {
    const verifier = verifierFor([roleCase.providerRole]);
    const result = await authorizeSettlementRequest(
      authRequest,
      "operator",
      verifier,
      () => NOW_SECONDS,
    );
    assert.equal(result.ok, roleCase.operator);
    if (result.ok) assert.equal(result.principal.role, roleCase.expectedRole);

    const adminResult = await authorizeSettlementRequest(
      authRequest,
      "admin",
      verifier,
      () => NOW_SECONDS,
    );
    assert.equal(adminResult.ok, roleCase.admin);
    if (!adminResult.ok) assert.equal(adminResult.status, 403);
  }
}

async function testGuardFailuresAndDuplicateCookies() {
  const authenticated = request("GET", {
    cookie: `${ACCESS_TOKEN_COOKIE}=${JWT_SHAPED_TOKEN}`,
  });
  for (const malformedRoles of [
    undefined,
    null,
    "ADMIN",
    ["ADMIN", 7],
    [],
    ["unknown"],
  ]) {
    await expectGuardStatus(
      authenticated,
      "operator",
      verifierFor(malformedRoles),
      403,
    );
  }

  for (const verifier of [
    verifierFor(["ADMIN"], { exp: undefined }),
    verifierFor(["ADMIN"], { exp: "later" }),
    verifierFor(["ADMIN"], { exp: NOW_SECONDS }),
    (async () => {
      throw new Error("provider-secret invalid token-secret");
    }) satisfies SettlementAccessTokenVerifier,
  ]) {
    await expectGuardStatus(authenticated, "operator", verifier, 401);
  }

  await expectGuardStatus(request("GET"), "operator", verifierFor(["ADMIN"]), 401);
  let opaqueVerifierCalls = 0;
  const opaqueCredential = await requireSettlementAuth(
    request("GET", {
      cookie: `${ACCESS_TOKEN_COOKIE}=retired-session-credential`,
    }),
    "operator",
    {
      verifier: async () => {
        opaqueVerifierCalls += 1;
        return verifierFor(["ADMIN"])(JWT_SHAPED_TOKEN);
      },
    },
  );
  assert.equal(opaqueCredential?.status, 401);
  assert.equal(opaqueVerifierCalls, 0, "opaque legacy credentials must fail before verification");
  await expectGuardStatus(
    request("GET", {
      cookie: `${ACCESS_TOKEN_COOKIE}=${JWT_SHAPED_TOKEN}; ${ACCESS_TOKEN_COOKIE}=attacker.value.signature`,
    }),
    "operator",
    verifierFor(["ADMIN"]),
    401,
  );
}

async function testSameOriginGuard() {
  const cookie = `${ACCESS_TOKEN_COOKIE}=${JWT_SHAPED_TOKEN}`;
  const verifier = verifierFor(["settlement_operator"]);

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(
      await requireSettlementAuth(
        request(method, {
          cookie,
          origin: "https://dashboard.example",
          secFetchSite: "same-origin",
        }),
        "operator",
        { verifier, now: () => NOW_SECONDS },
      ),
      null,
    );
    await expectGuardStatus(request(method, { cookie }), "operator", verifier, 403);
    await expectGuardStatus(
      request(method, { cookie, origin: "https://other.example" }),
      "operator",
      verifier,
      403,
    );
    await expectGuardStatus(
      request(method, {
        cookie,
        origin: "https://dashboard.example",
        secFetchSite: "cross-site",
      }),
      "operator",
      verifier,
      403,
    );
  }

  assert.equal(
    await requireSettlementAuth(request("GET", { cookie }), "operator", {
      verifier,
      now: () => NOW_SECONDS,
    }),
    null,
  );
}

function testVerifierConfiguration() {
  assert.deepEqual(
    readAuth0VerifierConfig({
      AUTH0_DOMAIN: "tenant.example.auth0.com",
      AUTH0_AUDIENCE: AUDIENCE,
    }),
    {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: new URL(`${ISSUER}.well-known/jwks.json`),
    },
  );

  for (const env of [
    {},
    { AUTH0_DOMAIN: "https://secret.example", AUTH0_AUDIENCE: "audience-secret" },
    { AUTH0_DOMAIN: "tenant.example.auth0.com", AUTH0_AUDIENCE: " secret-audience" },
  ]) {
    assert.throws(() => readAuth0VerifierConfig(env), {
      message: "Auth configuration unavailable",
    });
  }
}

async function cryptographicFixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "local-test-key";
  publicJwk.alg = "RS256";
  const verifier = createAuth0AccessTokenVerifier(
    { issuer: ISSUER, audience: AUDIENCE },
    createLocalJWKSet({ keys: [publicJwk] }),
  );
  const sign = (role: string) =>
    new SignJWT({ [ROLES_CLAIM]: [role] })
      .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject("auth0|route-test")
      .setIssuedAt(NOW_SECONDS)
      .setExpirationTime(NOW_SECONDS + 3_600)
      .sign(privateKey);
  return { verifier, sign };
}

function tokenFetch(accessToken: string, status = 200): typeof fetch {
  return async () =>
    Response.json(
      {
        access_token: accessToken,
        refresh_token: "rotating-refresh-token",
        expires_in: 1_200,
      },
      { status },
    );
}

function getSetCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function assertNoStore(response: Response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
}

function assertCookie(
  response: Response,
  name: string,
  expectedMaxAge: number,
) {
  const cookie = getSetCookies(response).find((value) =>
    value.startsWith(`${name}=`),
  );
  assert.ok(cookie, `missing ${name} cookie`);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\//i);
  assert.match(cookie, new RegExp(`Max-Age=${expectedMaxAge}(?:;|$)`, "i"));
}

function assertNoCookieMutation(response: Response) {
  assert.deepEqual(getSetCookies(response), []);
}

async function testRouteRolesWithRealCrypto() {
  const { verifier, sign } = await cryptographicFixture();
  for (const role of ["ADMIN", "settlement_admin", "settlement_operator"]) {
    const accessToken = await sign(role);
    const loginResponse = await handleLogin(loginRequest({
      email: "operator@example.com",
      password: "correct-password",
    }), { fetch: tokenFetch(accessToken), verifier, now: () => NOW_SECONDS });
    assert.equal(loginResponse.status, 200, `login role ${role}`);
    assertNoStore(loginResponse);
    assert.deepEqual(await loginResponse.json(), { expiresIn: 1_200 });
    assertCookie(loginResponse, ACCESS_TOKEN_COOKIE, 1_200);
    assertCookie(loginResponse, REFRESH_TOKEN_COOKIE, 604_800);

    const refreshResponse = await handleRefresh(
      nextRequest("/api/auth/refresh", {
        method: "POST",
        headers: { cookie: `${REFRESH_TOKEN_COOKIE}=valid-refresh-token` },
      }),
      { fetch: tokenFetch(accessToken), verifier, now: () => NOW_SECONDS },
    );
    assert.equal(refreshResponse.status, 200, `refresh role ${role}`);
    assertNoStore(refreshResponse);
    assert.deepEqual(await refreshResponse.json(), { expiresIn: 1_200 });
    assertCookie(refreshResponse, ACCESS_TOKEN_COOKIE, 1_200);
  }
}

async function testUnsignedAndTamperedRejection() {
  const { verifier, sign } = await cryptographicFixture();
  const signed = await sign("ADMIN");
  const parts = signed.split(".");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<
    string,
    unknown
  >;
  payload[ROLES_CLAIM] = ["settlement_operator"];
  const tampered = `${parts[0]}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${parts[2]}`;
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${parts[1]}.unsigned`;

  for (const token of [tampered, unsigned]) {
    const loginResponse = await handleLogin(
      loginRequest({ email: "operator@example.com", password: "password" }),
      { fetch: tokenFetch(token), verifier, now: () => NOW_SECONDS },
    );
    assert.equal(loginResponse.status, 502);
    assertNoStore(loginResponse);
    assertNoCookieMutation(loginResponse);

    const refreshResponse = await handleRefresh(
      nextRequest("/api/auth/refresh", {
        method: "POST",
        headers: { cookie: `${REFRESH_TOKEN_COOKIE}=still-valid` },
      }),
      { fetch: tokenFetch(token), verifier, now: () => NOW_SECONDS },
    );
    assert.equal(refreshResponse.status, 502);
    assertNoCookieMutation(refreshResponse);
  }
}

async function testLoginInputBounds() {
  let fetchCalls = 0;
  const fetchStub: typeof fetch = async () => {
    fetchCalls += 1;
    throw new Error("must not call provider");
  };
  const cases = [
    loginRequest(null),
    loginRequest([]),
    loginRequest("{"),
    loginRequest({ email: "x".repeat(255), password: "password" }),
    loginRequest({ email: "a@example.com", password: "x".repeat(1_025) }),
    nextRequest("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }),
    loginRequest(
      { email: "a@example.com", password: "password" },
      { "content-length": "4097" },
    ),
    nextRequest("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"email":"a@example.com","password":"${"x".repeat(5_000)}"}`,
    }),
  ];

  for (const malformed of cases) {
    const response = await handleLogin(malformed, {
      fetch: fetchStub,
      verifier: verifierFor(["ADMIN"]),
    });
    assert.equal(response.status, 400);
    assertNoStore(response);
    assert.deepEqual(await response.json(), { error: "Invalid request" });
  }
  assert.equal(fetchCalls, 0);
}

function errorResponse(status: number, onCancel?: () => void) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("provider-secret"));
      },
      cancel() {
        onCancel?.();
      },
    }),
    { status },
  );
}

function openSuccessResponse(
  chunk: string,
  onCancel: () => void,
  close = false,
) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk));
        if (close) controller.close();
      },
      cancel() {
        onCancel();
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function abortingFetch(): typeof fetch {
  return async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      assert.ok(init?.signal, "provider fetch requires an AbortSignal");
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      });
    });
}

async function testLoginProviderFailures() {
  const credentials = () =>
    loginRequest({ email: "operator@example.com", password: "password" });

  for (const [providerStatus, expectedStatus] of [
    [400, 401],
    [401, 401],
    [403, 401],
    [429, 429],
    [500, 502],
    [503, 502],
  ] as const) {
    let canceled = false;
    const response = await handleLogin(credentials(), {
      fetch: async () =>
        errorResponse(providerStatus, () => (canceled = true)),
    });
    assert.equal(response.status, expectedStatus);
    assert.equal(canceled, true);
    assertNoCookieMutation(response);
    assertNoStore(response);
    assert.equal((await response.text()).includes("provider-secret"), false);
  }

  const malformed = await handleLogin(credentials(), {
    fetch: async () => new Response("not-json", { status: 200 }),
  });
  assert.equal(malformed.status, 502);
  assertNoCookieMutation(malformed);

  const timeout = await handleLogin(credentials(), {
    fetch: abortingFetch(),
    timeoutMs: 5,
  });
  assert.equal(timeout.status, 503);
  assertNoCookieMutation(timeout);
}

async function testRefreshProviderFailures() {
  const requestWithCookie = () =>
    nextRequest("/api/auth/refresh", {
      method: "POST",
      headers: { cookie: `${REFRESH_TOKEN_COOKIE}=valid-refresh-token` },
    });

  for (const status of [400, 401, 403]) {
    let canceled = false;
    const response = await handleRefresh(requestWithCookie(), {
      fetch: async () => errorResponse(status, () => (canceled = true)),
    });
    assert.equal(response.status, 401);
    assert.equal(canceled, true);
    assertCookie(response, ACCESS_TOKEN_COOKIE, 0);
    assertCookie(response, REFRESH_TOKEN_COOKIE, 0);
    assertNoStore(response);
  }

  for (const status of [429, 500, 503]) {
    let canceled = false;
    const response = await handleRefresh(requestWithCookie(), {
      fetch: async () => errorResponse(status, () => (canceled = true)),
    });
    assert.equal(response.status, status === 429 ? 429 : 502);
    assert.equal(canceled, true);
    assertNoCookieMutation(response);
    assertNoStore(response);
  }

  const malformed = await handleRefresh(requestWithCookie(), {
    fetch: async () => new Response("not-json", { status: 200 }),
  });
  assert.equal(malformed.status, 502);
  assertNoCookieMutation(malformed);

  const timeout = await handleRefresh(requestWithCookie(), {
    fetch: abortingFetch(),
    timeoutMs: 5,
  });
  assert.equal(timeout.status, 503);
  assertNoCookieMutation(timeout);

  let duplicateFetchCalls = 0;
  const duplicate = await handleRefresh(
    nextRequest("/api/auth/refresh", {
      method: "POST",
      headers: {
        cookie: `${REFRESH_TOKEN_COOKIE}=legitimate; ${REFRESH_TOKEN_COOKIE}=attacker`,
      },
    }),
    { fetch: async () => (duplicateFetchCalls += 1, Response.json({})) },
  );
  assert.equal(duplicate.status, 401);
  assert.equal(duplicateFetchCalls, 0);
  assertCookie(duplicate, REFRESH_TOKEN_COOKIE, 0);
}

async function testSuccessfulProviderBodyLimits() {
  let loginCanceled = false;
  const oversizedLogin = await handleLogin(
    loginRequest({ email: "operator@example.com", password: "password" }),
    {
      fetch: async () =>
        openSuccessResponse(
          JSON.stringify({ padding: "x".repeat(256) }),
          () => (loginCanceled = true),
        ),
      responseMaxBytes: 128,
    },
  );
  assert.equal(oversizedLogin.status, 502);
  assert.equal(loginCanceled, true, "oversized successful login body must be canceled");

  let refreshCanceled = false;
  const timedRefresh = await handleRefresh(
    nextRequest("/api/auth/refresh", {
      method: "POST",
      headers: { cookie: `${REFRESH_TOKEN_COOKIE}=rotating-session-credential` },
    }),
    {
      fetch: async () =>
        openSuccessResponse("{", () => (refreshCanceled = true)),
      bodyTimeoutMs: 5,
    },
  );
  assert.equal(timedRefresh.status, 503);
  assert.equal(refreshCanceled, true, "timed-out successful refresh body must be canceled");

  let profileCanceled = false;
  const boundedProfile = await handleProfile(
    nextRequest("/api/auth/profile", {
      headers: { cookie: `${ACCESS_TOKEN_COOKIE}=${JWT_SHAPED_TOKEN}` },
    }),
    {
      verifier: verifierFor(["ADMIN"]),
      now: () => NOW_SECONDS,
      fetch: async () =>
        openSuccessResponse(
          JSON.stringify({ padding: "x".repeat(256) }),
          () => (profileCanceled = true),
        ),
      responseMaxBytes: 128,
    },
  );
  assert.equal(boundedProfile.status, 502);
  assert.equal(profileCanceled, true, "oversized successful profile body must be canceled");
}

async function testProfileAndLogoutLifecycle() {
  assert.equal("PATCH" in profileRoute, false, "profile PATCH export must not exist");

  const profile = await handleProfile(
    nextRequest("/api/auth/profile", {
      headers: { cookie: `${ACCESS_TOKEN_COOKIE}=${JWT_SHAPED_TOKEN}` },
    }),
    {
      verifier: verifierFor(["settlement_operator"]),
      now: () => NOW_SECONDS,
      fetch: async (_input, init) => {
        assert.ok(init?.signal);
        assert.equal(
          new Headers(init.headers).get("authorization"),
          `Bearer ${JWT_SHAPED_TOKEN}`,
        );
        return Response.json({
          sub: "must-not-be-forwarded",
          email: "operator@example.com",
          name: "Operator",
          picture: "https://images.example/avatar.png",
          arbitrary: "must-not-be-forwarded",
        });
      },
    },
  );
  assert.equal(profile.status, 200);
  assertNoStore(profile);
  assert.deepEqual(await profile.json(), {
    email: "operator@example.com",
    name: "Operator",
    picture: "https://images.example/avatar.png",
  });

  let ignoredHeaderVerifierCalls = 0;
  let ignoredHeaderFetchCalls = 0;
  const browserBearerOnly = await handleProfile(
    nextRequest("/api/auth/profile", {
      headers: { authorization: "Bearer signed.access.token" },
    }),
    {
      verifier: async () => {
        ignoredHeaderVerifierCalls += 1;
        return verifierFor(["ADMIN"])(JWT_SHAPED_TOKEN);
      },
      fetch: async () => {
        ignoredHeaderFetchCalls += 1;
        return Response.json({});
      },
    },
  );
  assert.equal(browserBearerOnly.status, 401);
  assert.equal(ignoredHeaderVerifierCalls, 0);
  assert.equal(ignoredHeaderFetchCalls, 0);

  const profileTimeout = await handleProfile(
    nextRequest("/api/auth/profile", {
      headers: { cookie: `${ACCESS_TOKEN_COOKIE}=${JWT_SHAPED_TOKEN}` },
    }),
    {
      verifier: verifierFor(["ADMIN"]),
      now: () => NOW_SECONDS,
      fetch: abortingFetch(),
      timeoutMs: 5,
    },
  );
  assert.equal(profileTimeout.status, 503);
  assertNoStore(profileTimeout);

  const logout = await handleLogout(
    nextRequest("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${REFRESH_TOKEN_COOKIE}=valid-refresh-token` },
    }),
    { fetch: abortingFetch(), timeoutMs: 5 },
  );
  assert.equal(logout.status, 200);
  assertNoStore(logout);
  assertCookie(logout, ACCESS_TOKEN_COOKIE, 0);
  assertCookie(logout, REFRESH_TOKEN_COOKIE, 0);

  for (const status of [200, 400]) {
    let canceled = false;
    const canceledLogout = await handleLogout(
      nextRequest("/api/auth/logout", {
        method: "POST",
        headers: { cookie: `${REFRESH_TOKEN_COOKIE}=revocable-session` },
      }),
      {
        fetch: async () => errorResponse(status, () => (canceled = true)),
      },
    );
    assert.equal(canceledLogout.status, 200);
    assert.equal(canceled, true, `logout provider body must be canceled for ${status}`);
  }

  let revokeCalls = 0;
  const duplicateLogout = await handleLogout(
    nextRequest("/api/auth/logout", {
      method: "POST",
      headers: {
        cookie: `${REFRESH_TOKEN_COOKIE}=legitimate; ${REFRESH_TOKEN_COOKIE}=attacker`,
      },
    }),
    { fetch: async () => (revokeCalls += 1, Response.json({})) },
  );
  assert.equal(duplicateLogout.status, 200);
  assert.equal(revokeCalls, 0);
  assertCookie(duplicateLogout, REFRESH_TOKEN_COOKIE, 0);
}

async function testForgotPasswordLifecycle() {
  let invalidFetchCalls = 0;
  for (const invalid of [
    loginRequest(null),
    loginRequest({ email: "missing-at-sign" }),
    loginRequest({ email: `${"x".repeat(250)}@mail.example` }),
    nextRequest("/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1025" },
      body: "{}",
    }),
  ]) {
    const response = await handleForgotPassword(invalid, {
      fetch: async () => {
        invalidFetchCalls += 1;
        return Response.json({});
      },
    });
    assert.equal(response.status, 400);
    assertNoStore(response);
  }
  assert.equal(invalidFetchCalls, 0);

  for (const providerStatus of [200, 400, 500]) {
    let canceled = false;
    const response = await handleForgotPassword(
      nextRequest("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "person@example.com" }),
      }),
      {
        rateLimiter: async () => null,
        fetch: async (_input, init) => {
          assert.ok(init?.signal, "forgot-password provider call requires timeout signal");
          return errorResponse(providerStatus, () => (canceled = true));
        },
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
    assertNoStore(response);
    assert.equal(canceled, true);
  }

  const timeout = await handleForgotPassword(
    nextRequest("/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.com" }),
    }),
    { fetch: abortingFetch(), timeoutMs: 5, rateLimiter: async () => null },
  );
  assert.equal(timeout.status, 200);
  assertNoStore(timeout);
}

async function testStaticAndFunctionalUiContracts() {
  assert.equal(shouldClearAuthState(401), true);
  assert.equal(shouldClearAuthState(403), true);
  assert.equal(shouldClearAuthState(429), false);
  assert.equal(shouldClearAuthState(502), false);
  assert.equal(refreshDelayMs(1_000), 800_000);
  assert.equal(refreshDelayMs(null), null);
  assert.equal(refreshRetryDelayMs(), 30_000);
  assert.equal(refreshRetryDelayMs(502), 30_000);
  assert.equal(refreshRetryDelayMs(401), null);
  assert.equal(refreshRetryDelayMs(403), null);

  const [
    loginRoute,
    refreshRoute,
    profileSource,
    logoutRoute,
    forgotRoute,
    handlers,
    loginPage,
    provider,
    contentMaster,
    contentRoute,
    contentStats,
    envExample,
  ] =
    await Promise.all([
      readFile("app/api/auth/login/route.ts", "utf8"),
      readFile("app/api/auth/refresh/route.ts", "utf8"),
      readFile("app/api/auth/profile/route.ts", "utf8"),
      readFile("app/api/auth/logout/route.ts", "utf8"),
      readFile("app/api/auth/forgot-password/route.ts", "utf8"),
      readFile("src/lib/auth-handlers.server.ts", "utf8"),
      readFile("app/(public)/login/page.tsx", "utf8"),
      readFile("src/providers/AuthProvider.tsx", "utf8"),
      readFile("src/components/data/ContentMasterTab.tsx", "utf8"),
      readFile("app/api/content-master/route.ts", "utf8"),
      readFile("app/api/content-master/stats/route.ts", "utf8"),
      readFile(".env.example", "utf8"),
    ]);
  const routeSources = {
    login: loginRoute,
    refresh: refreshRoute,
    profile: profileSource,
    logout: logoutRoute,
    forgotPassword: forgotRoute,
  };
  const allowedRouteExports: Record<keyof typeof routeSources, string[]> = {
    login: ["POST"],
    refresh: ["POST"],
    profile: ["GET"],
    logout: ["POST"],
    forgotPassword: ["POST"],
  };
  for (const [name, source] of Object.entries(routeSources)) {
    const exports = Array.from(
      source.matchAll(
        /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g,
      ),
      (match) => match[1],
    );
    assert.deepEqual(
      exports,
      allowedRouteExports[name as keyof typeof routeSources],
      `${name} route may only expose supported Next route exports`,
    );
    assert.doesNotMatch(source, /dependencies|verifier|handle\w+\s*\([^)]*,/);
  }
  assert.deepEqual(Object.keys(loginRouteModule), ["POST"]);
  assert.deepEqual(Object.keys(refreshRouteModule), ["POST"]);
  assert.deepEqual(Object.keys(profileRoute), ["GET"]);
  assert.deepEqual(Object.keys(logoutRouteModule), ["POST"]);
  assert.deepEqual(Object.keys(forgotPasswordRoute), ["POST"]);
  assert.equal(loginRouteModule.POST.length, 1);
  assert.equal(refreshRouteModule.POST.length, 1);
  assert.equal(profileRoute.GET.length, 1);

  assert.doesNotMatch(profileSource, /export\s+(?:async\s+)?function\s+PATCH|M2M|client_credentials|api\/v2\/users/);
  assert.equal(
    (handlers.match(/readBoundedUpstreamJson\(/g) ?? []).length,
    3,
    "login, refresh, and profile must use the bounded provider reader",
  );
  assert.doesNotMatch(handlers, /\.json\(\)/);
  assert.match(loginPage, /name=["']email["']/);
  assert.match(loginPage, /maxLength=\{254\}/);
  assert.match(loginPage, /maxLength=\{1024\}/);
  assert.doesNotMatch(loginPage, /임시 접속|아무 숫자|inputMode=["']numeric/);
  assert.doesNotMatch(provider, /localStorage|sessionStorage/);
  assert.doesNotMatch(provider + contentMaster, /\baccessToken\b|Bearer\s/);
  assert.match(provider, /finally\s*\{/);
  assert.match(provider, /window\.setTimeout/);
  assert.match(provider, /window\.clearTimeout/);
  assert.match(provider, /shouldClearAuthState\(res\.status\)/);
  assert.match(provider, /scheduleTransientRetry\(\)/);
  assert.match(contentMaster, /const \{ user, isReady \} = useAuth\(\)/);
  assert.doesNotMatch(contentMaster, /headers\s*:/);
  for (const source of [contentRoute, contentStats]) {
    assert.match(source, /await requireGlobalAdminAuth\(request\)/);
    assert.doesNotMatch(source, /userinfo|authorization/i);
  }
  assert.doesNotMatch(envExample, /AUTH0_M2M_/);

  for (const handler of [getContentMaster, getContentMasterStats]) {
    const response = await handler(
      nextRequest("/api/content-master"),
    );
    assert.equal(response.status, 401, "ContentMaster auth must run before DB access");
  }
}

async function testSettlementRouteInventory() {
  const entries = await readdir("app/api/settlement", { recursive: true });
  const routePaths = entries
    .filter((entry) => entry.endsWith("route.ts"))
    .map((entry) => `app/api/settlement/${entry}`);
  assert.ok(routePaths.length > 0);

  for (const path of routePaths) {
    const source = await readFile(path, "utf8");
    const guardCalls = source.match(/requireSettlementApiAuth\(request/g) ?? [];
    const awaitedGuardCalls =
      source.match(/await requireSettlementApiAuth\(request/g) ?? [];
    assert.equal(
      awaitedGuardCalls.length,
      guardCalls.length,
      `${path} must await every settlement guard call`,
    );
    if (/export async function (?:POST|PUT|PATCH|DELETE)\b/.test(source)) {
      assert.ok(
        awaitedGuardCalls.length > 0,
        `${path} mutation must authenticate before side effects`,
      );
    }
  }

  const currentData = await readFile(
    "src/features/settlement/lib/current-data-routes.ts",
    "utf8",
  );
  assert.match(currentData, /dependencies\.auth \?\? requireSettlementApiAuth/);
  assert.equal((currentData.match(/const unauthorized = await/g) ?? []).length, 2);

  const resetRoute = await readFile(
    "app/api/settlement/reset/[month]/route.ts",
    "utf8",
  );
  assert.match(resetRoute, /await requireSettlementApiAuth\(request, "admin"\)/);

  const runtimeAndTestFiles = (
    await Promise.all(
      ["app", "src", "scripts"].map(async (root) =>
        (await readdir(root, { recursive: true }))
          .filter((entry) => /\.(?:ts|tsx|js|mjs)$/.test(entry))
          .filter((entry) => root !== "scripts" || entry.startsWith("test-"))
          .map((entry) => `${root}/${entry}`),
      ),
    )
  ).flat();
  const forbiddenCredential = new RegExp(
    ["rvjp", "temporary", "mock"].join("-"),
    "i",
  );
  for (const path of runtimeAndTestFiles) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, forbiddenCredential, `${path} contains a retired credential`);
  }
}

async function testGlobalAdminAndSessionLifetime() {
  const cookie = `${ACCESS_TOKEN_COOKIE}=${JWT_SHAPED_TOKEN}`;
  const sameOrigin = {
    cookie,
    origin: "https://dashboard.example",
    secFetchSite: "same-origin",
  };

  assert.equal(
    await requireGlobalAdminAuth(request("POST", sameOrigin), {
      verifier: verifierFor(["ADMIN"]),
      now: () => NOW_SECONDS,
    }),
    null,
  );
  const settlementOnly = await requireGlobalAdminAuth(request("POST", sameOrigin), {
    verifier: verifierFor(["settlement_admin"]),
    now: () => NOW_SECONDS,
  });
  assert.equal(settlementOnly?.status, 403);
  const crossOrigin = await requireGlobalAdminAuth(
    request("POST", {
      cookie,
      origin: "https://evil.example",
      secFetchSite: "cross-site",
    }),
    { verifier: verifierFor(["ADMIN"]), now: () => NOW_SECONDS },
  );
  assert.equal(crossOrigin?.status, 403);

  assert.equal(accessTokenMaxAge(1_200, NOW_SECONDS + 300, NOW_SECONDS), 300);
  assert.equal(accessTokenMaxAge(120, NOW_SECONDS + 300, NOW_SECONDS), 120);
  assert.equal(accessTokenMaxAge(120, NOW_SECONDS, NOW_SECONDS), null);

  const globalAdminRouteRoots = [
    "app/api/analysis",
    "app/api/dashboard",
    "app/api/manage",
    "app/api/sales",
    "app/api/content-master",
  ];
  const privilegedRoutes = (
    await Promise.all(
      globalAdminRouteRoots.map(async (root) =>
        (await readdir(root, { recursive: true }))
          .filter((entry) => entry.endsWith("route.ts"))
          .map((entry) => `${root}/${entry}`),
      ),
    )
  ).flat();
  privilegedRoutes.push("app/api/upload-debug/route.ts");

  for (const path of privilegedRoutes) {
    const source = await readFile(path, "utf8");
    const handlers = [
      ...source.matchAll(/export async function (?:GET|POST|PUT|PATCH|DELETE)\b/g),
    ];
    for (let index = 0; index < handlers.length; index += 1) {
      const start = handlers[index].index ?? 0;
      const end = handlers[index + 1]?.index ?? source.length;
      const handlerSource = source.slice(start, end);
      assert.match(
        handlerSource,
        /await requireGlobalAdminAuth\([A-Za-z_$][\w$]*\)/,
        `${path} handler ${handlers[index][0]} must enforce global ADMIN`,
      );
    }
  }

  const runtimeSources = await Promise.all(
    ["app", "src"].map(async (root) =>
      Promise.all(
        (await readdir(root, { recursive: true }))
          .filter((entry) => /\.(?:ts|tsx)$/.test(entry))
          .map((entry) => readFile(`${root}/${entry}`, "utf8")),
      ),
    ),
  );
  const retiredFixedPasswordLiteral = /(?:'CLINK'|"CLINK")/;
  assert.equal(runtimeSources.flat().some((source) => retiredFixedPasswordLiteral.test(source)), false);

  const loginPage = await readFile("app/(public)/login/page.tsx", "utf8");
  assert.match(loginPage, /비밀번호를 잊으셨나요\?/);
  assert.match(loginPage, /\/api\/auth\/forgot-password/);
  const verifierSource = await readFile("src/lib/auth-verifier.server.ts", "utf8");
  assert.match(verifierSource, /customFetch/);
  assert.match(verifierSource, /readBoundedUpstreamJson/);

  const settlementUpload = await readFile("app/api/settlement/upload/route.ts", "utf8");
  const replaceGate = settlementUpload.indexOf("if (replaceMonth)");
  const replaceAdmin = settlementUpload.indexOf(
    'requireSettlementApiAuth(request, "admin")',
    replaceGate,
  );
  const replaceDisabled = settlementUpload.indexOf("automatic month replacement is disabled", replaceAdmin);
  assert.ok(replaceGate >= 0 && replaceAdmin > replaceGate && replaceDisabled > replaceAdmin);
  assert.doesNotMatch(settlementUpload, /\.from\(["']sales_records["']\)[\s\S]{0,120}\.delete\(\)/);

  const debugUpload = await readFile("app/api/upload-debug/route.ts", "utf8");
  const debugGet = debugUpload.indexOf("export async function GET");
  assert.ok(debugGet >= 0);
  assert.ok(debugUpload.indexOf("requireGlobalAdminAuth(request)", debugGet) > debugGet);
  assert.match(debugUpload, /path\.startsWith\('uploads\/'\)/);
  assert.match(debugUpload, /createSignedUploadUrl/);

  const uploadPage = await readFile("app/(protected)/upload/page.tsx", "utf8");
  assert.match(uploadPage, /uploadToSignedUrl/);
  assert.doesNotMatch(uploadPage, /\.from\('upload_logs'\)/);
  assert.doesNotMatch(uploadPage, /\.from\('upload-debug'\)\.list/);
  assert.doesNotMatch(uploadPage, /\.createSignedUrl\(/);

  const initialSalesPage = await readFile("app/(protected)/initial-sales/page.tsx", "utf8");
  assert.doesNotMatch(initialSalesPage, /supabase\.rpc\(/);
  assert.match(initialSalesPage, /fetchTitleSummaries\(/);
  assert.match(initialSalesPage, /fetchTitleDailySales\(/);

  const additiveMigration = await readFile(
    "supabase/migrations/025_add_upload_log_storage_path.sql",
    "utf8",
  );
  assert.match(additiveMigration, /add column if not exists storage_path/);
  assert.match(additiveMigration, /file_size_limit\s*=\s*104857600/i);
  assert.doesNotMatch(additiveMigration, /revoke|drop policy/i);

  const lockdownMigration = await readFile(
    "supabase/migrations/027_revoke_direct_client_access.sql",
    "utf8",
  );
  assert.match(lockdownMigration, /revoke all privileges on all tables in schema public from public, anon, authenticated/i);
  assert.match(lockdownMigration, /revoke all privileges on all sequences in schema public from public, anon, authenticated/i);
  assert.match(lockdownMigration, /revoke execute on all functions in schema public from public, anon, authenticated/i);
  assert.match(lockdownMigration, /'public' = any\(roles\)/i);
  assert.match(lockdownMigration, /schemaname = 'storage'[\s\S]+tablename = 'objects'/i);

  const rateLimitMigration = await readFile(
    "supabase/migrations/026_shared_forgot_password_rate_limit.sql",
    "utf8",
  );
  assert.match(rateLimitMigration, /consume_forgot_password_rate_limit/);
  assert.match(rateLimitMigration, /security definer/i);
  assert.match(rateLimitMigration, /grant execute[\s\S]+to service_role/i);

  const authHandlers = await readFile("src/lib/auth-handlers.server.ts", "utf8");
  assert.match(authHandlers, /consumeForgotPasswordRateLimit/);
  assert.doesNotMatch(authHandlers, /forgotPasswordAttempts|new Map<string, \{ count/);

  const serverClient = await readFile("src/lib/supabase-server.ts", "utf8");
  assert.match(serverClient, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(serverClient, /\|\| process\.env\.NEXT_PUBLIC_SUPABASE_ANON_KEY/);

  for (const contentMasterPath of [
    "app/api/content-master/route.ts",
    "app/api/content-master/stats/route.ts",
  ]) {
    const contentMasterSource = await readFile(contentMasterPath, "utf8");
    assert.match(contentMasterSource, /supabaseServer/);
    assert.doesNotMatch(contentMasterSource, /NEXT_PUBLIC_SUPABASE_ANON_KEY|content_master_public/);
  }

}

async function testAuthMutationSameOrigin() {
  const crossSiteHeaders = {
    origin: "https://evil.example",
    "sec-fetch-site": "cross-site",
    "content-type": "application/json",
  };
  const neverFetch = async () => {
    throw new Error("cross-origin request reached provider");
  };
  const cases = [
    handleLogin(
      new Request("https://dashboard.example/api/auth/login", {
        method: "POST",
        headers: crossSiteHeaders,
        body: JSON.stringify({ email: "user@example.com", password: "password" }),
      }),
      { fetch: neverFetch },
    ),
    handleRefresh(
      new Request("https://dashboard.example/api/auth/refresh", {
        method: "POST",
        headers: { ...crossSiteHeaders, cookie: `${REFRESH_TOKEN_COOKIE}=refresh` },
      }),
      { fetch: neverFetch },
    ),
    handleLogout(
      new Request("https://dashboard.example/api/auth/logout", {
        method: "POST",
        headers: crossSiteHeaders,
      }),
      { fetch: neverFetch },
    ),
    handleForgotPassword(
      new Request("https://dashboard.example/api/auth/forgot-password", {
        method: "POST",
        headers: crossSiteHeaders,
        body: JSON.stringify({ email: "user@example.com" }),
      }),
      { fetch: neverFetch },
    ),
  ];
  for (const pending of cases) assert.equal((await pending).status, 403);
}

async function testForgotPasswordRateLimit() {
  let providerCalls = 0;
  let limiterCalls = 0;
  const statuses: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    const response = await handleForgotPassword(
      nextRequest("/api/auth/forgot-password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vercel-forwarded-for": "192.0.2.10",
        },
        body: JSON.stringify({ email: "user@example.com" }),
      }),
      {
        rateLimiter: async () => {
          limiterCalls += 1;
          return limiterCalls > 5 ? 600 : null;
        },
        fetch: async () => {
          providerCalls += 1;
          return new Response(null, { status: 200 });
        },
      },
    );
    statuses.push(response.status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  assert.equal(providerCalls, 5);

  const missingTrustedIp = await handleForgotPassword(
    new Request("https://dashboard.example/api/auth/forgot-password", {
      method: "POST",
      headers: {
        origin: "https://dashboard.example",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "user@example.com" }),
    }),
    { rateLimiter: async () => null },
  );
  assert.equal(missingTrustedIp.status, 503);
}

async function main() {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  Object.assign(process.env, {
    AUTH0_DOMAIN: "tenant.example.auth0.com",
    AUTH0_CLIENT_ID: "test-client-id",
    AUTH0_CLIENT_SECRET: "test-client-secret",
    AUTH0_AUDIENCE: AUDIENCE,
  });

  try {
    await testRoleMatrix();
    await testGuardFailuresAndDuplicateCookies();
    await testSameOriginGuard();
    testVerifierConfiguration();
    await testRouteRolesWithRealCrypto();
    await testUnsignedAndTamperedRejection();
    await testLoginInputBounds();
    await testLoginProviderFailures();
    await testRefreshProviderFailures();
    await testSuccessfulProviderBodyLimits();
    await testProfileAndLogoutLifecycle();
    await testForgotPasswordLifecycle();
    await testStaticAndFunctionalUiContracts();
    await testSettlementRouteInventory();
    await testGlobalAdminAndSessionLifetime();
    await testAuthMutationSameOrigin();
    await testForgotPasswordRateLimit();
    console.log("test-settlement-auth: all assertions passed");
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
}

void main();
