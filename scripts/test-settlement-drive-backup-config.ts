import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { decodeJwt } from "jose";

import { readSettlementDriveBackupConfig } from "../src/features/settlement/lib/worker/drive-backup-config";
import {
  fetchGoogleServiceAccountToken,
  GOOGLE_DRIVE_SCOPE,
  GOOGLE_OAUTH_TOKEN_URL,
  MAX_TOKEN_RESPONSE_BYTES,
  TOKEN_LIFETIME_SECONDS,
} from "../src/features/settlement/lib/worker/google-service-account-token";

const EMAIL = "drive-backup@example.iam.gserviceaccount.com";
const NOW = 1_800_000_000;
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const SECRET_MARKER = "secret-assertion-marker";

async function getError(run: () => Promise<unknown>): Promise<Error> {
  try { await run(); } catch (error) { return error as Error; }
  assert.fail("expected error");
}

function assertSafe(error: Error): void {
  assert.doesNotMatch(error.message, /access-token-value|secret-assertion-marker/i);
  assert.ok(!error.message.includes(PRIVATE_KEY.slice(0, 40)));
  assert.ok(error.message.length <= 100);
}

function testConfig(): void {
  assert.deepEqual(readSettlementDriveBackupConfig({}), { enabled: false });
  assert.deepEqual(readSettlementDriveBackupConfig({ SETTLEMENT_DRIVE_BACKUP_ENABLED: "false" }), { enabled: false });
  const escaped = PRIVATE_KEY.replaceAll("\n", "\\n");
  const config = readSettlementDriveBackupConfig({
    SETTLEMENT_DRIVE_BACKUP_ENABLED: "true",
    GOOGLE_DRIVE_CLIENT_EMAIL: EMAIL,
    GOOGLE_DRIVE_PRIVATE_KEY: escaped,
    GOOGLE_DRIVE_SHARED_DRIVE_ID: "shared_drive-1",
    GOOGLE_DRIVE_BACKUP_ROOT_FOLDER_ID: "backup_root-1",
  });
  assert.equal(config.enabled, true);
  if (config.enabled) {
    assert.equal(config.clientEmail, EMAIL);
    assert.equal(config.privateKey, PRIVATE_KEY);
    assert.equal(config.sharedDriveId, "shared_drive-1");
    assert.equal(config.backupRootFolderId, "backup_root-1");
  }
  for (const bad of [
    { SETTLEMENT_DRIVE_BACKUP_ENABLED: "true" },
    { SETTLEMENT_DRIVE_BACKUP_ENABLED: "true", GOOGLE_DRIVE_CLIENT_EMAIL: "bad" },
    {
      SETTLEMENT_DRIVE_BACKUP_ENABLED: "true", GOOGLE_DRIVE_CLIENT_EMAIL: EMAIL,
      GOOGLE_DRIVE_PRIVATE_KEY: SECRET_MARKER, GOOGLE_DRIVE_SHARED_DRIVE_ID: "x",
      GOOGLE_DRIVE_BACKUP_ROOT_FOLDER_ID: "y",
    },
  ]) {
    assert.throws(() => readSettlementDriveBackupConfig(bad), (error: Error) => {
      assertSafe(error); return true;
    });
  }
}

async function testToken(): Promise<void> {
  let called = 0;
  const token = await fetchGoogleServiceAccountToken(
    { clientEmail: EMAIL, privateKey: PRIVATE_KEY },
    {
      nowEpochSeconds: () => NOW,
      fetchImpl: async (input, init) => {
        called += 1;
        assert.equal(String(input), GOOGLE_OAUTH_TOKEN_URL);
        assert.equal(init?.method, "POST");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
        const params = new URLSearchParams(String(init?.body));
        assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
        const assertion = params.get("assertion");
        assert.ok(assertion);
        const claims = decodeJwt(assertion);
        assert.equal(claims.iss, EMAIL);
        assert.equal(claims.aud, GOOGLE_OAUTH_TOKEN_URL);
        assert.equal(claims.scope, GOOGLE_DRIVE_SCOPE);
        assert.equal(claims.iat, NOW);
        assert.equal(claims.exp, NOW + TOKEN_LIFETIME_SECONDS);
        return Response.json({ access_token: "access-token-value", token_type: "Bearer", expires_in: 1800 });
      },
    },
  );
  assert.equal(called, 1);
  assert.deepEqual(token, { accessToken: "access-token-value", expiresAtEpochSeconds: NOW + 1800 });
}

async function testSafeFailures(): Promise<void> {
  const credentials = { clientEmail: EMAIL, privateKey: PRIVATE_KEY };
  const invalidCredentials = await getError(() => fetchGoogleServiceAccountToken(
    { clientEmail: "bad", privateKey: SECRET_MARKER },
    { fetchImpl: async () => { throw new Error("must not fetch"); } },
  ));
  assertSafe(invalidCredentials);

  const invalidPkcs8 = await getError(() => fetchGoogleServiceAccountToken(
    { clientEmail: EMAIL, privateKey: SECRET_MARKER },
    { nowEpochSeconds: () => NOW, fetchImpl: async () => { throw new Error("must not fetch"); } },
  ));
  assert.equal(invalidPkcs8.message, "Invalid service account private key");
  assertSafe(invalidPkcs8);

  const network = await getError(() => fetchGoogleServiceAccountToken(credentials, {
    nowEpochSeconds: () => NOW,
    fetchImpl: async (_input, init) => { throw new Error(`${SECRET_MARKER}:${String(init?.body)}`); },
  }));
  assert.equal(network.message, "Token endpoint request failed");
  assertSafe(network);

  const streamFailure = new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error(SECRET_MARKER)); },
  });
  const streamError = await getError(() => fetchGoogleServiceAccountToken(credentials, {
    nowEpochSeconds: () => NOW,
    fetchImpl: async () => new Response(streamFailure, { status: 200 }),
  }));
  assert.equal(streamError.message, "Token endpoint response could not be read");
  assertSafe(streamError);

  for (const response of [
    new Response(`${SECRET_MARKER}:${"x".repeat(MAX_TOKEN_RESPONSE_BYTES)}`, { status: 400 }),
    Response.json({ access_token: "access-token-value", token_type: "bearer", expires_in: 10 }),
    Response.json({ access_token: "bad\nvalue", token_type: "Bearer", expires_in: 10 }),
    Response.json({ access_token: "access-token-value", token_type: "Bearer", expires_in: TOKEN_LIFETIME_SECONDS + 1 }),
    new Response("not-json", { status: 200 }),
  ]) {
    const error = await getError(() => fetchGoogleServiceAccountToken(credentials, {
      nowEpochSeconds: () => NOW,
      fetchImpl: async () => response,
    }));
    assertSafe(error);
  }
}

async function main(): Promise<void> {
  testConfig();
  await testToken();
  await testSafeFailures();
  console.log("test-settlement-drive-backup-config: all assertions passed");
}

void main();
