import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";

import type postgres from "postgres";

import type {
  SettlementDriveAppProperties,
  SettlementDriveClient,
  SettlementDriveFileMetadata,
} from "../google-drive/client";
import type { VersionClaimIdentity } from "./version-source-adapter";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const VERSION_RE = /^(0|[1-9][0-9]{0,19})$/;
const CHUNK_BYTES = 8 * 1024 * 1024;

export type DriveBackupKind = "source_manifest" | "source_file" | "verified_workbook";
export type DriveBackupRow = {
  id: string; kind: DriveBackupKind; backup_identity: string; content_sha256: string;
  size_bytes: number | string; drive_parent_id: string; status: "pending" | "retry" | "verified";
  drive_file_id: string | null; drive_sha256: string | null; drive_version: string | null;
};
export interface DriveBackupStore {
  begin(input: VersionClaimIdentity & { attemptToken: string; kind: DriveBackupKind; sourceVersionFileId: string | null; driveParentId: string }): Promise<DriveBackupRow | null>;
  verify(input: VersionClaimIdentity & { attemptToken: string; backupId: string; driveFileId: string; driveSha256: string; driveVersion: string }): Promise<boolean>;
  getVerified(backupId: string): Promise<DriveBackupRow | null>;
  retry(input: VersionClaimIdentity & { attemptToken: string; backupId: string; errorSummary: string; retryAfterSeconds: number }): Promise<boolean>;
}
export type DriveBackupArtifact = {
  kind: DriveBackupKind; sourceVersionFileId: string | null; localPath: string;
  name: string; mimeType: string;
};
export type DriveBackupResult = { outcome: "verified"; backupId: string; driveFileId: string; reused: boolean } | { outcome: "lease_lost" };

function safeInt(value: number | string): number {
  const parsed = typeof value === "number" ? value : (/^[1-9][0-9]*$/.test(value) ? Number(value) : NaN);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("drive backup evidence invalid");
  return parsed;
}
function properties(row: DriveBackupRow): SettlementDriveAppProperties {
  return { riverse_managed: "true", backup_identity: row.backup_identity, artifact_kind: row.kind, content_sha256: row.content_sha256 };
}
function sameProperties(left: Record<string, string> | undefined, right: Record<string, string>): boolean {
  if (!left) return false;
  const leftKeys = Object.keys(left).sort(); const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}
function validateRow(row: DriveBackupRow, artifact: DriveBackupArtifact, parentId: string): number {
  if (!UUID_RE.test(row.id) || row.kind !== artifact.kind || row.drive_parent_id !== parentId
    || !SHA256_RE.test(row.content_sha256) || !DRIVE_ID_RE.test(parentId)) throw new Error("drive backup evidence invalid");
  return safeInt(row.size_bytes);
}
function validateRemote(metadata: SettlementDriveFileMetadata, row: DriveBackupRow, artifact: DriveBackupArtifact, expectedSize: number): void {
  if (!DRIVE_ID_RE.test(metadata.id) || metadata.size !== String(expectedSize)
    || metadata.mimeType !== artifact.mimeType || metadata.parents?.length !== 1
    || metadata.parents[0] !== row.drive_parent_id || metadata.sha256Checksum !== row.content_sha256
    || !VERSION_RE.test(metadata.version ?? "")
    || !sameProperties(metadata.appProperties, properties(row))) {
    throw new Error("drive backup remote evidence invalid");
  }
}
async function hashHandle(handle: fsp.FileHandle, size: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size));
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.byteLength, size - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead !== length) throw new Error("drive backup local artifact changed");
    hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
  }
  return hash.digest("hex");
}
async function uploadFile(input: {
  drive: SettlementDriveClient; row: DriveBackupRow; artifact: DriveBackupArtifact; expectedSize: number;
}): Promise<SettlementDriveFileMetadata> {
  const handle = await fsp.open(input.artifact.localPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!before.isFile() || uid === undefined || before.uid !== uid || before.size !== input.expectedSize
      || (before.mode & 0o177) !== 0) throw new Error("drive backup local artifact invalid");
    if (await hashHandle(handle, input.expectedSize) !== input.row.content_sha256) throw new Error("drive backup local hash mismatch");
    const props = properties(input.row);
    const sessionUrl = await input.drive.startResumableUpload({
      parentId: input.row.drive_parent_id, name: input.artifact.name, mimeType: input.artifact.mimeType,
      sizeBytes: input.expectedSize, appProperties: props,
    });
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, input.expectedSize));
    let offset = 0; let complete: SettlementDriveFileMetadata | null = null;
    while (offset < input.expectedSize) {
      const length = Math.min(buffer.byteLength, input.expectedSize - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new Error("drive backup local artifact changed");
      const bytes = Buffer.from(buffer.subarray(0, bytesRead)); hash.update(bytes);
      const result = await input.drive.uploadResumableChunk({
        sessionUrl, bytes, offsetBytes: offset, totalSizeBytes: input.expectedSize,
        mimeType: input.artifact.mimeType, expectedParentId: input.row.drive_parent_id,
        expectedAppProperties: props,
      });
      if (result.complete) { complete = result.metadata; offset = input.expectedSize; }
      else offset = result.nextOffsetBytes;
    }
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs || hash.digest("hex") !== input.row.content_sha256 || !complete) {
      throw new Error("drive backup local artifact changed");
    }
    return complete;
  } finally { await handle.close().catch(() => undefined); }
}

export async function backupDriveArtifact(input: {
  identity: VersionClaimIdentity; artifact: DriveBackupArtifact; driveParentId: string;
  store: DriveBackupStore; drive: SettlementDriveClient; attemptToken?: string;
}): Promise<DriveBackupResult> {
  const attemptToken = input.attemptToken ?? randomUUID();
  const row = await input.store.begin({ ...input.identity, attemptToken, kind: input.artifact.kind,
    sourceVersionFileId: input.artifact.sourceVersionFileId, driveParentId: input.driveParentId });
  if (!row) return { outcome: "lease_lost" };
  const expectedSize = validateRow(row, input.artifact, input.driveParentId);
  const props = properties(row);
  let metadata: SettlementDriveFileMetadata;
  let reused = true;
  if (row.status === "verified") {
    if (!row.drive_file_id) throw new Error("drive backup evidence invalid");
    metadata = await input.drive.getFileMetadata(row.drive_file_id);
  } else {
    const existing = await input.drive.findUniqueByAppProperties(row.drive_parent_id, props);
    if (existing) metadata = existing;
    else { reused = false; metadata = await uploadFile({ drive: input.drive, row, artifact: input.artifact, expectedSize }); }
  }
  validateRemote(metadata, row, input.artifact, expectedSize);
  if (row.status !== "verified") {
    const ok = await input.store.verify({ ...input.identity, attemptToken, backupId: row.id,
      driveFileId: metadata.id, driveSha256: metadata.sha256Checksum!, driveVersion: metadata.version! });
    if (!ok) return { outcome: "lease_lost" };
  }
  const stored = await input.store.getVerified(row.id);
  if (!stored || stored.status !== "verified" || stored.id !== row.id
    || stored.kind !== row.kind || stored.backup_identity !== row.backup_identity
    || safeInt(stored.size_bytes) !== expectedSize || stored.drive_file_id !== metadata.id
    || stored.drive_sha256 !== metadata.sha256Checksum || stored.drive_version !== metadata.version
    || stored.content_sha256 !== row.content_sha256 || stored.drive_parent_id !== row.drive_parent_id) {
    throw new Error("drive backup database read-back invalid");
  }
  return { outcome: "verified", backupId: stored.id, driveFileId: metadata.id, reused };
}

export function createPostgresDriveBackupStore(sql: postgres.Sql): DriveBackupStore {
  return {
    async begin(input) {
      const rows = await sql<DriveBackupRow[]>`select * from public.begin_settlement_drive_backup(
        ${input.jobId}::uuid, ${input.runId}::uuid, ${input.workerId}::text, ${input.claimToken}::uuid,
        ${input.attemptToken}::uuid, ${input.kind}::text, ${input.sourceVersionFileId}::uuid,
        ${input.driveParentId}::text)`;
      return rows[0] ?? null;
    },
    async verify(input) {
      const rows = await sql<Array<{ ok: boolean }>>`select public.verify_settlement_drive_backup(
        ${input.jobId}::uuid, ${input.runId}::uuid, ${input.workerId}::text, ${input.claimToken}::uuid,
        ${input.attemptToken}::uuid, ${input.backupId}::uuid, ${input.driveFileId}::text,
        ${input.driveSha256}::text, ${input.driveVersion}::text) as ok`;
      return rows[0]?.ok === true;
    },
    async getVerified(backupId) {
      const rows = await sql<DriveBackupRow[]>`select id, kind, backup_identity, content_sha256,
        size_bytes, drive_parent_id, status, drive_file_id, drive_sha256, drive_version
        from public.settlement_drive_backups where id = ${backupId}::uuid and status = 'verified' limit 1`;
      return rows[0] ?? null;
    },
    async retry(input) {
      const rows = await sql<Array<{ ok: boolean }>>`select public.retry_settlement_drive_backup(
        ${input.jobId}::uuid, ${input.runId}::uuid, ${input.workerId}::text, ${input.claimToken}::uuid,
        ${input.attemptToken}::uuid, ${input.backupId}::uuid, ${input.errorSummary}::text,
        ${input.retryAfterSeconds}::integer) as ok`;
      return rows[0]?.ok === true;
    },
  };
}
