type Environment = Readonly<Record<string, string | undefined>>;

export type SettlementDriveBackupConfig =
  | { enabled: false }
  | {
      enabled: true;
      clientEmail: string;
      privateKey: string;
      sharedDriveId: string;
      backupRootFolderId: string;
    };

const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PRIVATE_KEY_PATTERN =
  /^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{64,}\r?\n-----END PRIVATE KEY-----\r?\n?$/;

function required(env: Environment, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function invalid(name: string): never {
  throw new Error(`Invalid environment variable: ${name}`);
}

function isPrintableAscii(value: string): boolean {
  return /^[\x21-\x7E]+$/.test(value);
}

function readEmail(env: Environment): string {
  const name = "GOOGLE_DRIVE_CLIENT_EMAIL";
  const value = required(env, name);
  if (value.length > 254 || !isPrintableAscii(value) || !EMAIL_PATTERN.test(value)) {
    invalid(name);
  }
  return value;
}

function readPrivateKey(env: Environment): string {
  const name = "GOOGLE_DRIVE_PRIVATE_KEY";
  const value = required(env, name).replaceAll("\\n", "\n");
  if (value.length > 16_384 || !PRIVATE_KEY_PATTERN.test(value)) invalid(name);
  return value;
}

function readDriveId(env: Environment, name: string): string {
  const value = required(env, name);
  if (!DRIVE_ID_PATTERN.test(value)) invalid(name);
  return value;
}

export function readSettlementDriveBackupConfig(
  env: Environment = process.env,
): SettlementDriveBackupConfig {
  if (env.SETTLEMENT_DRIVE_BACKUP_ENABLED !== "true") return { enabled: false };

  return {
    enabled: true,
    clientEmail: readEmail(env),
    privateKey: readPrivateKey(env),
    sharedDriveId: readDriveId(env, "GOOGLE_DRIVE_SHARED_DRIVE_ID"),
    backupRootFolderId: readDriveId(env, "GOOGLE_DRIVE_BACKUP_ROOT_FOLDER_ID"),
  };
}
