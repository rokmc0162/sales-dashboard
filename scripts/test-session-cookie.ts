/**
 * Assertions for the signed session cookie.
 * Run: node --import tsx scripts/test-session-cookie.ts
 *
 * Hermetic: sets the secrets it needs on process.env itself and never touches
 * the network, so CI needs no repository secret. `session.ts` reads env at call
 * time, not module load, so the rotation cases below work with a static import.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  SESSION_TTL_SECONDS,
  SESSION_VERSION,
  SessionSecretMissingError,
  hasAdminRole,
  signSession,
  verifySession,
} from "../src/lib/session";

const SECRET_A = "unit-test-secret-aaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET_B = "unit-test-secret-bbbbbbbbbbbbbbbbbbbbbbbb";

const CLAIMS = { sub: "auth0|abc", email: "ops@riverse.local", roles: ["ADMIN"] };

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function resetEnv() {
  process.env.SESSION_SECRET = SECRET_A;
  delete process.env.SESSION_SECRET_PREVIOUS;
  delete process.env.ALLOW_TEMP_LOGIN;
  process.env.NODE_ENV = "test";
}

async function roundTrip() {
  const token = await signSession(CLAIMS);
  const payload = await verifySession(token);
  assert.ok(payload, "a freshly signed token must verify");
  assert.equal(payload.sub, "auth0|abc");
  assert.equal(payload.email, "ops@riverse.local");
  assert.deepEqual(payload.roles, ["ADMIN"]);
  assert.equal(payload.ver, SESSION_VERSION);
  assert.equal(payload.exp - payload.iat, SESSION_TTL_SECONDS);
  assert.ok(hasAdminRole(payload));

  // an empty email is legitimate — Auth0 access tokens do not always carry one
  const noEmail = await signSession({ sub: "auth0|x", email: "", roles: ["ADMIN"] });
  const noEmailPayload = await verifySession(noEmail);
  assert.ok(noEmailPayload, "an empty email must still verify");
  assert.equal(noEmailPayload.email, "");
}

async function tampering() {
  const token = await signSession(CLAIMS);
  const [header, body, mac] = token.split(".");
  const now = Math.floor(Date.now() / 1000);

  const forgedBody = base64url(
    JSON.stringify({
      sub: "attacker",
      email: "attacker@evil.test",
      roles: ["ADMIN"],
      iat: now,
      exp: now + 3600,
      ver: SESSION_VERSION,
    }),
  );
  assert.equal(
    await verifySession(`${header}.${forgedBody}.${mac}`),
    null,
    "a swapped payload must not verify against the original mac",
  );

  const flipped = mac[0] === "A" ? `B${mac.slice(1)}` : `A${mac.slice(1)}`;
  assert.equal(await verifySession(`${header}.${body}.${flipped}`), null, "a tampered mac must fail");

  assert.equal(await verifySession(`${header}.${body}`), null, "a two-part token must fail");
  assert.equal(await verifySession(""), null);
  assert.equal(await verifySession(null), null);
  assert.equal(await verifySession(undefined), null);
  assert.equal(await verifySession("not.a.token"), null);
  assert.equal(await verifySession(`${"x".repeat(5000)}.a.b`), null, "an oversized token must fail");

  // alg confusion
  const noneHeader = base64url(JSON.stringify({ alg: "none", kid: "0".repeat(8) }));
  const noneBody = base64url(
    JSON.stringify({ sub: "a", email: "", roles: ["ADMIN"], iat: now, exp: now + 60, ver: SESSION_VERSION }),
  );
  assert.equal(await verifySession(`${noneHeader}.${noneBody}.`), null, "alg=none must be rejected");
}

async function expiryAndVersion() {
  const issuedAt = Math.floor(Date.now() / 1000) - SESSION_TTL_SECONDS - 10;
  assert.equal(await verifySession(await signSession(CLAIMS, issuedAt)), null, "an expired token must fail");

  const fresh = await signSession(CLAIMS);
  const payload = await verifySession(fresh);
  assert.ok(payload);
  assert.equal(await verifySession(fresh, payload.exp), null, "exp must not be inclusive");
  assert.ok(await verifySession(fresh, payload.exp - 1), "one second before exp must still pass");

  const [header] = fresh.split(".");
  const now = Math.floor(Date.now() / 1000);
  const wrongVersion = base64url(
    JSON.stringify({ sub: "a", email: "", roles: ["ADMIN"], iat: now, exp: now + 60, ver: SESSION_VERSION + 1 }),
  );
  const mac = createHmac("sha256", SECRET_A).update(`${header}.${wrongVersion}`).digest("base64url");
  assert.equal(
    await verifySession(`${header}.${wrongVersion}.${mac}`),
    null,
    "a bumped SESSION_VERSION must invalidate older sessions",
  );
}

/** A valid signature does not imply a payload we would have issued. */
async function payloadHygiene() {
  const [header] = (await signSession(CLAIMS)).split(".");
  const now = Math.floor(Date.now() / 1000);

  const bad: Array<[string, Record<string, unknown>]> = [
    ["roles not an array", { sub: "a", email: "", roles: "ADMIN", iat: now, exp: now + 60, ver: SESSION_VERSION }],
    ["too many roles", { sub: "a", email: "", roles: Array(64).fill("R"), iat: now, exp: now + 60, ver: SESSION_VERSION }],
    ["non-integer exp", { sub: "a", email: "", roles: [], iat: now, exp: now + 0.5, ver: SESSION_VERSION }],
    ["missing sub", { email: "", roles: [], iat: now, exp: now + 60, ver: SESSION_VERSION }],
    ["oversized email", { sub: "a", email: "x".repeat(600), roles: [], iat: now, exp: now + 60, ver: SESSION_VERSION }],
  ];

  for (const [label, payload] of bad) {
    const body = base64url(JSON.stringify(payload));
    const mac = createHmac("sha256", SECRET_A).update(`${header}.${body}`).digest("base64url");
    assert.equal(await verifySession(`${header}.${body}.${mac}`), null, `${label} must be rejected`);
  }
}

async function rotation() {
  const oldToken = await signSession(CLAIMS);

  // B becomes current, A stays accepted
  process.env.SESSION_SECRET = SECRET_B;
  process.env.SESSION_SECRET_PREVIOUS = SECRET_A;
  assert.ok(await verifySession(oldToken), "a token signed with the previous secret stays valid");

  const newToken = await signSession(CLAIMS);
  assert.ok(await verifySession(newToken), "a token signed with the new secret verifies");
  assert.notEqual(newToken.split(".")[0], oldToken.split(".")[0], "rotation must change the kid");

  // rotation completed
  delete process.env.SESSION_SECRET_PREVIOUS;
  assert.equal(await verifySession(oldToken), null, "dropping the previous secret retires its tokens");
  assert.ok(await verifySession(newToken));

  resetEnv();
}

async function failClosed() {
  const token = await signSession(CLAIMS);
  delete process.env.SESSION_SECRET;

  assert.equal(await verifySession(token), null, "no secret means no session verifies");
  await assert.rejects(
    () => signSession(CLAIMS),
    SessionSecretMissingError,
    "signing without a secret must throw rather than mint an unsigned session",
  );

  // the development fallback requires BOTH conditions
  process.env.ALLOW_TEMP_LOGIN = "1";
  await assert.rejects(
    () => signSession(CLAIMS),
    SessionSecretMissingError,
    "ALLOW_TEMP_LOGIN alone must not unlock the dev secret",
  );

  process.env.NODE_ENV = "production";
  await assert.rejects(
    () => signSession(CLAIMS),
    SessionSecretMissingError,
    "a production build must never use the dev secret",
  );

  process.env.NODE_ENV = "development";
  assert.ok(
    await verifySession(await signSession(CLAIMS)),
    "development + ALLOW_TEMP_LOGIN may use the dev secret",
  );

  resetEnv();
}

async function main() {
  resetEnv();
  await roundTrip();
  await tampering();
  await expiryAndVersion();
  await payloadHygiene();
  await rotation();
  await failClosed();
  console.log("session cookie: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
