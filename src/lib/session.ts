/**
 * Signed session cookie (`X-SESSION`).
 *
 * ONE implementation, used by both Node route handlers and the Edge
 * middleware. `crypto.subtle` exists in both runtimes, so there is no second
 * `node:crypto` code path — a divergence between two implementations (base64url
 * handling, UTF-8 encoding, `exp` boundary) would let middleware admit a request
 * the API then rejects, or the reverse. Every export here is therefore async.
 *
 * The session is stateless: logout deletes the cookie but cannot invalidate a
 * copy already taken from the browser. The revocation window is bounded by
 * SESSION_TTL_SECONDS instead, and `/api/auth/refresh` re-checks the ADMIN role
 * against Auth0 on every renewal, so a role removed upstream stops working
 * within one TTL. A server-side denylist would close the window completely and
 * is the natural next step if that ever matters.
 *
 * Token layout: base64url(header) "." base64url(payload) "." base64url(mac)
 * where mac = HMAC-SHA256(secret, "<header>.<payload>").
 */

export const SESSION_COOKIE = "X-SESSION";

/** Bounds how long a stolen cookie stays usable after logout. */
export const SESSION_TTL_SECONDS = 60 * 60;

/**
 * Authorization schema version. Bumping this rejects every session already
 * issued, which is the "log everybody out now" lever.
 */
export const SESSION_VERSION = 1;

const MAX_TOKEN_LENGTH = 4096;
const MAX_ROLES = 32;
const MAX_ROLE_LENGTH = 128;
const MAX_STRING_LENGTH = 512;

/** Only ever used when NODE_ENV=development AND ALLOW_TEMP_LOGIN=1. */
const DEV_ONLY_SECRET = "rvjp-development-only-session-secret";

export interface SessionPayload {
  sub: string;
  email: string;
  roles: string[];
  /** Issued at, epoch seconds. */
  iat: number;
  /** Expires at, epoch seconds. */
  exp: number;
  /** Must equal SESSION_VERSION. */
  ver: number;
}

export class SessionSecretMissingError extends Error {
  constructor() {
    super(
      "SESSION_SECRET is not set. Sessions cannot be issued or verified. " +
        "Set it in the deployment environment before shipping auth changes.",
    );
    this.name = "SessionSecretMissingError";
  }
}

// ---------------------------------------------------------------------------
// base64url — no Buffer, so the same code runs on Edge
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Secrets and key ids
// ---------------------------------------------------------------------------

interface SecretEntry {
  kid: string;
  secret: string;
}

function devSecretAllowed(): boolean {
  // Both conditions required: a production build must never fall back.
  return (
    process.env.NODE_ENV === "development" && process.env.ALLOW_TEMP_LOGIN === "1"
  );
}

function rawSecrets(): { current: string | null; previous: string | null } {
  const current = process.env.SESSION_SECRET || (devSecretAllowed() ? DEV_ONLY_SECRET : null);
  const previous = process.env.SESSION_SECRET_PREVIOUS || null;
  return { current, previous };
}

const kidCache = new Map<string, string>();

/**
 * Key id derived from the secret itself, so rotating SESSION_SECRET changes the
 * kid with no extra env var to keep in sync. Truncated to 8 hex characters —
 * enough to pick between two live secrets, too short to help an attacker.
 */
async function keyIdFor(secret: string): Promise<string> {
  const cached = kidCache.get(secret);
  if (cached) return cached;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const kid = Array.from(new Uint8Array(digest).slice(0, 4))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  kidCache.set(secret, kid);
  return kid;
}

async function currentSecret(): Promise<SecretEntry> {
  const { current } = rawSecrets();
  if (!current) throw new SessionSecretMissingError();
  return { kid: await keyIdFor(current), secret: current };
}

/** Current secret first, then the previous one during a rotation window. */
async function acceptedSecrets(): Promise<SecretEntry[]> {
  const { current, previous } = rawSecrets();
  const entries: SecretEntry[] = [];
  if (current) entries.push({ kid: await keyIdFor(current), secret: current });
  if (previous) entries.push({ kid: await keyIdFor(previous), secret: previous });
  return entries;
}

const keyCache = new Map<string, CryptoKey>();

async function hmacKey(secret: string): Promise<CryptoKey> {
  const cached = keyCache.get(secret);
  if (cached) return cached;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  keyCache.set(secret, key);
  return key;
}

async function macFor(secret: string, signingInput: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  return new Uint8Array(signature);
}

/** Length is not secret; the bytes are. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Payload hygiene
// ---------------------------------------------------------------------------

function isSaneString(value: unknown, max = MAX_STRING_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/**
 * A valid signature only proves we minted the token — it says nothing about the
 * shape of what is inside. Reject anything we would not have issued.
 */
function parsePayload(value: unknown): SessionPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;

  if (!isSaneString(candidate.sub)) return null;
  // email is display/audit only and Auth0 access tokens do not always carry it,
  // so an empty string is legitimate. sub is the identity.
  if (typeof candidate.email !== "string" || candidate.email.length > MAX_STRING_LENGTH) {
    return null;
  }
  if (!Array.isArray(candidate.roles)) return null;
  if (candidate.roles.length > MAX_ROLES) return null;
  if (!candidate.roles.every((role) => isSaneString(role, MAX_ROLE_LENGTH))) return null;
  if (!Number.isSafeInteger(candidate.iat)) return null;
  if (!Number.isSafeInteger(candidate.exp)) return null;
  if (candidate.ver !== SESSION_VERSION) return null;

  return {
    sub: candidate.sub,
    email: candidate.email as string,
    roles: candidate.roles as string[],
    iat: candidate.iat as number,
    exp: candidate.exp as number,
    ver: SESSION_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Sign / verify
// ---------------------------------------------------------------------------

export interface SessionClaims {
  sub: string;
  email: string;
  roles: string[];
}

/**
 * @throws SessionSecretMissingError when no secret is configured.
 */
export async function signSession(
  claims: SessionClaims,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const { kid, secret } = await currentSecret();
  const payload: SessionPayload = {
    sub: claims.sub,
    email: claims.email,
    roles: claims.roles,
    iat: nowSeconds,
    exp: nowSeconds + SESSION_TTL_SECONDS,
    ver: SESSION_VERSION,
  };
  const header = bytesToBase64url(encoder.encode(JSON.stringify({ alg: "HS256", kid })));
  const body = bytesToBase64url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${header}.${body}`;
  const mac = await macFor(secret, signingInput);
  return `${signingInput}.${bytesToBase64url(mac)}`;
}

/**
 * Returns null for every failure — missing secret, malformed token, bad
 * signature, expired, wrong version, implausible payload. Never throws, so
 * callers cannot accidentally treat an error as an authenticated request.
 */
export async function verifySession(
  token: string | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<SessionPayload | null> {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;

  const headerBytes = base64urlToBytes(header);
  const bodyBytes = base64urlToBytes(body);
  const macBytes = base64urlToBytes(signature);
  if (!headerBytes || !bodyBytes || !macBytes) return null;

  let kid: unknown;
  let rawPayload: unknown;
  try {
    const parsedHeader = JSON.parse(decoder.decode(headerBytes)) as Record<string, unknown>;
    if (parsedHeader.alg !== "HS256") return null;
    kid = parsedHeader.kid;
    rawPayload = JSON.parse(decoder.decode(bodyBytes));
  } catch {
    return null;
  }
  if (!isSaneString(kid, 64)) return null;

  const candidates = await acceptedSecrets();
  const matching = candidates.filter((entry) => entry.kid === kid);
  if (matching.length === 0) return null;

  const signingInput = `${header}.${body}`;
  let verified = false;
  for (const entry of matching) {
    const expected = await macFor(entry.secret, signingInput);
    if (constantTimeEqual(expected, macBytes)) verified = true;
  }
  if (!verified) return null;

  const payload = parsePayload(rawPayload);
  if (!payload) return null;
  if (payload.exp <= nowSeconds) return null;

  return payload;
}

export function hasAdminRole(payload: SessionPayload): boolean {
  return payload.roles.includes("ADMIN");
}

/** Cookie attributes shared by every set/clear so they always match. */
export function sessionCookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}
