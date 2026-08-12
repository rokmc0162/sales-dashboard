import { SignJWT, importPKCS8 } from "jose";

export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export const TOKEN_LIFETIME_SECONDS = 3_600;
export const MAX_TOKEN_RESPONSE_BYTES = 16_384;

const MAX_ACCESS_TOKEN_LENGTH = 4_096;
const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export interface GoogleServiceAccountCredentials {
  clientEmail: string;
  /** PKCS#8 PEM private key. Never included in any error thrown here. */
  privateKey: string;
}

export interface GoogleAccessToken {
  accessToken: string;
  expiresAtEpochSeconds: number;
}

export interface FetchAccessTokenOptions {
  fetchImpl?: typeof fetch;
  nowEpochSeconds?: () => number;
}

function isPrintableAscii(value: string): boolean {
  return /^[\x21-\x7E]+$/.test(value);
}

async function readBodyBounded(response: Response): Promise<string> {
  try {
    if (!response.body) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_TOKEN_RESPONSE_BYTES) {
        throw new Error("too-large");
      }
      return text;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TOKEN_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("too-large");
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch {
    throw new Error("Token endpoint response could not be read");
  }
}

async function signAssertion(
  credentials: GoogleServiceAccountCredentials,
  nowEpochSeconds: number,
): Promise<string> {
  let key;
  try {
    key = await importPKCS8(credentials.privateKey, "RS256");
  } catch {
    // Never propagate the underlying error: it may echo key material.
    throw new Error("Invalid service account private key");
  }
  try {
    return await new SignJWT({ scope: GOOGLE_DRIVE_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(credentials.clientEmail)
      .setAudience(GOOGLE_OAUTH_TOKEN_URL)
      .setIssuedAt(nowEpochSeconds)
      .setExpirationTime(nowEpochSeconds + TOKEN_LIFETIME_SECONDS)
      .sign(key);
  } catch {
    throw new Error("Service account assertion could not be signed");
  }
}

export async function fetchGoogleServiceAccountToken(
  credentials: GoogleServiceAccountCredentials,
  options: FetchAccessTokenOptions = {},
): Promise<GoogleAccessToken> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = Math.floor(
    options.nowEpochSeconds ? options.nowEpochSeconds() : Date.now() / 1_000,
  );
  if (
    typeof credentials?.clientEmail !== "string" ||
    credentials.clientEmail.length > 254 ||
    !isPrintableAscii(credentials.clientEmail) ||
    !EMAIL_PATTERN.test(credentials.clientEmail) ||
    typeof credentials.privateKey !== "string" ||
    credentials.privateKey.length < 1 ||
    credentials.privateKey.length > 16_384 ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    throw new Error("Invalid service account credentials");
  }
  const assertion = await signAssertion(credentials, now);

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch {
    throw new Error("Token endpoint request failed");
  }

  const text = await readBodyBounded(response);
  if (!response.ok) {
    // The error body may echo the assertion; report only the status.
    throw new Error(`Token endpoint returned HTTP ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Token endpoint returned invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Token endpoint returned an unexpected payload");
  }
  const { token_type: tokenType, access_token: accessToken, expires_in: expiresIn } =
    parsed as Record<string, unknown>;

  if (tokenType !== "Bearer") {
    throw new Error("Token endpoint returned an unexpected token_type");
  }
  if (
    typeof accessToken !== "string" ||
    accessToken.length === 0 ||
    accessToken.length > MAX_ACCESS_TOKEN_LENGTH ||
    !isPrintableAscii(accessToken)
  ) {
    throw new Error("Token endpoint returned an invalid access_token");
  }
  if (
    typeof expiresIn !== "number" ||
    !Number.isInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error("Token endpoint returned an invalid expires_in");
  }

  return { accessToken, expiresAtEpochSeconds: now + expiresIn };
}
