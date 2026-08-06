import assert from "node:assert/strict";

import { readSettlementDriveConfig } from "../src/features/settlement/lib/google-drive/config.server";

const validEnv = {
  DRIVE_UPLOAD_ENABLED: "true",
  GOOGLE_DRIVE_CLIENT_EMAIL: "drive-uploader@example.iam.gserviceaccount.com",
  GOOGLE_DRIVE_PRIVATE_KEY:
    "-----BEGIN PRIVATE KEY-----\\nABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\\n-----END PRIVATE KEY-----\\n",
  GOOGLE_DRIVE_SHARED_DRIVE_ID: "shared-drive_123",
  GOOGLE_DRIVE_INTAKE_ROOT_FOLDER_ID: "intake-root_456",
  GOOGLE_DRIVE_INTAKE_ROOT_URL:
    "https://drive.google.com/drive/folders/intake-root_456",
} as const;

type Env = Record<string, string | undefined>;

function getError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("Expected configuration loading to fail");
}

function assertPrivacySafeFailure(env: Env, expectedVariable: string) {
  const error = getError(() => readSettlementDriveConfig(env));
  assert.match(error.message, new RegExp(`\\b${expectedVariable}\\b`));
  for (const [name, value] of Object.entries(env)) {
    if (name !== "DRIVE_UPLOAD_ENABLED" && value) {
      assert.equal(
        error.message.includes(value),
        false,
        `Error exposed the value of ${name}`,
      );
    }
  }
}

function main() {
  for (const flag of [undefined, "false", "TRUE", "1", "random"]) {
    assert.deepEqual(
      readSettlementDriveConfig({ ...validEnv, DRIVE_UPLOAD_ENABLED: flag }),
      { enabled: false },
    );
  }

  const enabled = readSettlementDriveConfig({ ...validEnv });
  assert.deepEqual(enabled, {
    enabled: true,
    clientEmail: validEnv.GOOGLE_DRIVE_CLIENT_EMAIL,
    privateKey: validEnv.GOOGLE_DRIVE_PRIVATE_KEY.replaceAll("\\n", "\n"),
    sharedDriveId: validEnv.GOOGLE_DRIVE_SHARED_DRIVE_ID,
    intakeRootFolderId: validEnv.GOOGLE_DRIVE_INTAKE_ROOT_FOLDER_ID,
    intakeRootUrl: validEnv.GOOGLE_DRIVE_INTAKE_ROOT_URL,
  });
  assert.deepEqual(Object.keys(enabled).sort(), [
    "clientEmail",
    "enabled",
    "intakeRootFolderId",
    "intakeRootUrl",
    "privateKey",
    "sharedDriveId",
  ]);

  for (const privateKey of [
    validEnv.GOOGLE_DRIVE_PRIVATE_KEY.replaceAll("\\n", "\n"),
    validEnv.GOOGLE_DRIVE_PRIVATE_KEY.replaceAll("\\n", "\r\n"),
  ]) {
    const config = readSettlementDriveConfig({
      ...validEnv,
      GOOGLE_DRIVE_PRIVATE_KEY: privateKey,
    });
    assert.equal(config.enabled, true);
    assert.equal(config.privateKey, privateKey);
  }

  const canonicalized = readSettlementDriveConfig({
    ...validEnv,
    GOOGLE_DRIVE_INTAKE_ROOT_URL:
      `${validEnv.GOOGLE_DRIVE_INTAKE_ROOT_URL}/?usp=sharing#intake`,
  });
  assert.equal(canonicalized.enabled, true);
  assert.equal(
    canonicalized.intakeRootUrl,
    validEnv.GOOGLE_DRIVE_INTAKE_ROOT_URL,
  );

  const requiredVariables = [
    "GOOGLE_DRIVE_CLIENT_EMAIL",
    "GOOGLE_DRIVE_PRIVATE_KEY",
    "GOOGLE_DRIVE_SHARED_DRIVE_ID",
    "GOOGLE_DRIVE_INTAKE_ROOT_FOLDER_ID",
    "GOOGLE_DRIVE_INTAKE_ROOT_URL",
  ] as const;
  for (const variable of requiredVariables) {
    const env: Env = { ...validEnv };
    delete env[variable];
    assertPrivacySafeFailure(env, variable);
  }

  const invalidValues: Array<[keyof typeof validEnv, string]> = [
    ["GOOGLE_DRIVE_CLIENT_EMAIL", "not an email secret"],
    ["GOOGLE_DRIVE_CLIENT_EMAIL", `${"a".repeat(255)}@example.com`],
    ["GOOGLE_DRIVE_PRIVATE_KEY", "definitely-not-a-private-key"],
    ["GOOGLE_DRIVE_SHARED_DRIVE_ID", "invalid/id secret"],
    ["GOOGLE_DRIVE_SHARED_DRIVE_ID", "x".repeat(257)],
    ["GOOGLE_DRIVE_INTAKE_ROOT_FOLDER_ID", "invalid folder id secret"],
    ["GOOGLE_DRIVE_INTAKE_ROOT_URL", "http://drive.google.com/drive/folders/secret"],
    ["GOOGLE_DRIVE_INTAKE_ROOT_URL", "HTTPS://drive.google.com/drive/folders/secret"],
    ["GOOGLE_DRIVE_INTAKE_ROOT_URL", "https://evil.example/drive/folders/secret"],
    [
      "GOOGLE_DRIVE_INTAKE_ROOT_URL",
      String.raw`https://drive.google.com\drive\folders\secret`,
    ],
    [
      "GOOGLE_DRIVE_INTAKE_ROOT_URL",
      "https://user:password@drive.google.com/drive/folders/secret",
    ],
    [
      "GOOGLE_DRIVE_INTAKE_ROOT_URL",
      "https://drive.google.com:443/drive/folders/secret",
    ],
    [
      "GOOGLE_DRIVE_INTAKE_ROOT_URL",
      `${validEnv.GOOGLE_DRIVE_INTAKE_ROOT_URL}?${"x".repeat(2_048)}`,
    ],
  ];
  for (const [variable, invalidValue] of invalidValues) {
    assertPrivacySafeFailure(
      { ...validEnv, [variable]: invalidValue },
      variable,
    );
  }

  assert.deepEqual(
    readSettlementDriveConfig({
      DRIVE_UPLOAD_ENABLED: "false",
      SETTLEMENT_DRIVE_SYNC_ROOT: "/worker-only/path",
    }),
    { enabled: false },
  );

  console.log("test-settlement-drive-config: all assertions passed");
}

main();
