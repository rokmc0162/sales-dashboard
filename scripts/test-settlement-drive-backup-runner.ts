import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import path from "node:path";

import type { SettlementDriveClient, SettlementDriveFileMetadata } from "../src/features/settlement/lib/google-drive/client";
import { backupDriveArtifact, type DriveBackupRow, type DriveBackupStore } from "../src/features/settlement/lib/worker/drive-backup-runner";

const ROOT = path.resolve(`.tmp/drive-backup-test-${process.pid}-${randomUUID()}`);
const identity = {
  jobId: "10000000-0000-4000-8000-000000000001",
  runId: "20000000-0000-4000-8000-000000000001",
  sourceVersionId: "30000000-0000-4000-8000-000000000001",
  workerId: "worker-test",
  claimToken: "40000000-0000-4000-8000-000000000001",
};
const attemptToken = "50000000-0000-4000-8000-000000000001";
const parentId = "backup_root";
function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function rowFor(bytes: Buffer, status: DriveBackupRow["status"] = "pending"): DriveBackupRow {
  return {
    id: "60000000-0000-4000-8000-000000000001", kind: "verified_workbook",
    backup_identity: `run:${identity.runId}`, content_sha256: digest(bytes), size_bytes: bytes.byteLength,
    drive_parent_id: parentId, status, drive_file_id: status === "verified" ? "drive_file" : null,
    drive_sha256: status === "verified" ? digest(bytes) : null, drive_version: status === "verified" ? "7" : null,
  };
}
function props(row: DriveBackupRow): Record<string, string> {
  return { riverse_managed: "true", backup_identity: row.backup_identity, artifact_kind: row.kind, content_sha256: row.content_sha256 };
}
function metadata(row: DriveBackupRow): SettlementDriveFileMetadata {
  return { id: "drive_file", name: "workbook.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    parents: [parentId], size: String(row.size_bytes), sha256Checksum: row.content_sha256, version: "7", appProperties: props(row) };
}
function store(row: DriveBackupRow, verifyResult = true): DriveBackupStore & { beginCalls: number; verifyCalls: number; verifiedRow: DriveBackupRow } {
  const verifiedRow: DriveBackupRow = { ...row, status: "verified", drive_file_id: "drive_file",
    drive_sha256: row.content_sha256, drive_version: "7" };
  return {
    beginCalls: 0, verifyCalls: 0, verifiedRow,
    async begin() { this.beginCalls += 1; return { ...row }; },
    async verify(input) { this.verifyCalls += 1; assert.equal(input.driveSha256, row.content_sha256); return verifyResult; },
    async getVerified() { return verifiedRow; },
    async retry() { return true; },
  };
}
class FakeDrive {
  found: SettlementDriveFileMetadata | null = null;
  getResult: SettlementDriveFileMetadata | null = null;
  uploaded: SettlementDriveFileMetadata;
  calls = { find: 0, get: 0, start: 0, chunk: 0 };
  maxChunk = 0;
  constructor(readonly row: DriveBackupRow) { this.uploaded = metadata(row); }
  async findUniqueByAppProperties(): Promise<SettlementDriveFileMetadata | null> { this.calls.find += 1; return this.found; }
  async getFileMetadata(): Promise<SettlementDriveFileMetadata> { this.calls.get += 1; if (!this.getResult) throw new Error("missing"); return this.getResult; }
  async startResumableUpload(): Promise<string> { this.calls.start += 1; return "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=test"; }
  async uploadResumableChunk(input: { bytes: Uint8Array; offsetBytes: number; totalSizeBytes: number }) {
    this.calls.chunk += 1; this.maxChunk = Math.max(this.maxChunk, input.bytes.byteLength);
    const next = input.offsetBytes + input.bytes.byteLength;
    return next === input.totalSizeBytes ? { complete: true as const, metadata: this.uploaded }
      : { complete: false as const, nextOffsetBytes: next };
  }
}
async function localArtifact(bytes: Buffer, name: string) {
  const file = path.join(ROOT, name); await fsp.writeFile(file, bytes, { mode: 0o600 });
  return { kind: "verified_workbook" as const, sourceVersionFileId: null, localPath: file,
    name: "workbook.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}
async function main() {
  await fsp.mkdir(ROOT, { recursive: true, mode: 0o700 });
  try {
    const bytes = Buffer.from("verified workbook bytes");
    const artifact = await localArtifact(bytes, "candidate.xlsx");

    const verifiedRow = rowFor(bytes, "verified");
    const verifiedStore = store(verifiedRow); const verifiedDrive = new FakeDrive(verifiedRow);
    verifiedDrive.getResult = metadata(verifiedRow);
    assert.deepEqual(await backupDriveArtifact({ identity, artifact, driveParentId: parentId,
      store: verifiedStore, drive: verifiedDrive as unknown as SettlementDriveClient, attemptToken }),
    { outcome: "verified", backupId: verifiedRow.id, driveFileId: "drive_file", reused: true });
    assert.deepEqual(verifiedDrive.calls, { find: 0, get: 1, start: 0, chunk: 0 });
    assert.equal(verifiedStore.verifyCalls, 0);

    const pendingRow = rowFor(bytes);
    const recoveredStore = store(pendingRow); const recoveredDrive = new FakeDrive(pendingRow);
    recoveredDrive.found = metadata(pendingRow);
    const recovered = await backupDriveArtifact({ identity, artifact, driveParentId: parentId,
      store: recoveredStore, drive: recoveredDrive as unknown as SettlementDriveClient, attemptToken });
    assert.equal(recovered.outcome, "verified"); assert.equal(recovered.reused, true);
    assert.deepEqual(recoveredDrive.calls, { find: 1, get: 0, start: 0, chunk: 0 });
    assert.equal(recoveredStore.verifyCalls, 1);

    // Property key order is not evidence: the real Drive client normalizes keys.
    const reorderedStore = store(pendingRow); const reorderedDrive = new FakeDrive(pendingRow);
    const reordered = metadata(pendingRow);
    reordered.appProperties = {
      content_sha256: pendingRow.content_sha256,
      artifact_kind: pendingRow.kind,
      backup_identity: pendingRow.backup_identity,
      riverse_managed: "true",
    };
    reorderedDrive.found = reordered;
    assert.equal((await backupDriveArtifact({ identity, artifact, driveParentId: parentId,
      store: reorderedStore, drive: reorderedDrive as unknown as SettlementDriveClient, attemptToken })).outcome, "verified");

    const readBackMismatch = store(pendingRow); const mismatchDrive = new FakeDrive(pendingRow);
    mismatchDrive.found = metadata(pendingRow);
    readBackMismatch.getVerified = async () => ({ ...readBackMismatch.verifiedRow, drive_version: "8" });
    await assert.rejects(() => backupDriveArtifact({ identity, artifact, driveParentId: parentId,
      store: readBackMismatch, drive: mismatchDrive as unknown as SettlementDriveClient, attemptToken }),
    /database read-back invalid/);

    const staleStore = store(pendingRow, false); const staleDrive = new FakeDrive(pendingRow);
    staleDrive.found = metadata(pendingRow);
    assert.deepEqual(await backupDriveArtifact({ identity, artifact, driveParentId: parentId,
      store: staleStore, drive: staleDrive as unknown as SettlementDriveClient, attemptToken }), { outcome: "lease_lost" });

    const large = Buffer.alloc(8 * 1024 * 1024 + 123, 0x5a);
    const largeArtifact = await localArtifact(large, "large.xlsx"); const largeRow = rowFor(large);
    const largeStore = store(largeRow); const largeDrive = new FakeDrive(largeRow);
    const uploaded = await backupDriveArtifact({ identity, artifact: largeArtifact, driveParentId: parentId,
      store: largeStore, drive: largeDrive as unknown as SettlementDriveClient, attemptToken });
    assert.equal(uploaded.outcome, "verified"); assert.equal(uploaded.reused, false);
    assert.equal(largeDrive.calls.chunk, 2); assert.equal(largeDrive.maxChunk, 8 * 1024 * 1024);

    const badRow = { ...pendingRow, content_sha256: "0".repeat(64) };
    const badStore = store(badRow); const badDrive = new FakeDrive(badRow);
    await assert.rejects(() => backupDriveArtifact({ identity, artifact, driveParentId: parentId,
      store: badStore, drive: badDrive as unknown as SettlementDriveClient, attemptToken }), /local hash mismatch/);
    assert.equal(badDrive.calls.start, 0);

    const noLease: DriveBackupStore = {
      async begin() { return null; }, async verify() { return false; },
      async getVerified() { return null; }, async retry() { return false; },
    };
    assert.deepEqual(await backupDriveArtifact({ identity, artifact, driveParentId: parentId,
      store: noLease, drive: new FakeDrive(pendingRow) as unknown as SettlementDriveClient, attemptToken }), { outcome: "lease_lost" });

    console.log("test-settlement-drive-backup-runner: all assertions passed");
  } finally { await fsp.rm(ROOT, { recursive: true, force: true }); }
}
void main();
