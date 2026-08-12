import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import path from "node:path";

import type { SettlementDriveClient, SettlementDriveFileMetadata } from "../src/features/settlement/lib/google-drive/client";
import { SettlementDriveError } from "../src/features/settlement/lib/google-drive/client";
import type { DriveBackupArtifact, DriveBackupRow, DriveBackupStore } from "../src/features/settlement/lib/worker/drive-backup-runner";
import { backupClaimedVersionArtifacts, planVersionDriveBackupArtifacts } from "../src/features/settlement/lib/worker/version-drive-backup";
import type { VersionSourceManifestEntry } from "../src/features/settlement/lib/worker/version-source-snapshot";

const ROOT = path.resolve(`.tmp/version-drive-backup-${process.pid}-${randomUUID()}`);
const identity = {
  jobId: "10000000-0000-4000-8000-000000000001",
  runId: "20000000-0000-4000-8000-000000000001",
  sourceVersionId: "30000000-0000-4000-8000-000000000001",
  workerId: "worker-test",
  claimToken: "40000000-0000-4000-8000-000000000001",
};
const parentId = "backup_root";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function entry(position: number, name: string): VersionSourceManifestEntry {
  return {
    versionFileId: `50000000-0000-4000-8000-${position.toString().padStart(12, "0")}`,
    objectId: `60000000-0000-4000-8000-${position.toString().padStart(12, "0")}`,
    position, pathKey: name.toLowerCase(), displayPath: name,
    sizeBytes: 1, sha256: hash(Buffer.from(String(position))),
    storagePath: `intake/202607/${position.toString(16).padStart(32, "0")}/${position.toString(16).padStart(32, "0")}`,
  };
}

class Store implements DriveBackupStore {
  readonly rows = new Map<string, DriveBackupRow>();
  readonly begins: Array<{ kind: string; sourceVersionFileId: string | null }> = [];
  readonly retries: Array<{ backupId: string; errorSummary: string }> = [];
  constructor(readonly artifacts: Map<string, { bytes: Buffer; mimeType: string }>) {}
  async begin(input: Parameters<DriveBackupStore["begin"]>[0]) {
    this.begins.push({ kind: input.kind, sourceVersionFileId: input.sourceVersionFileId });
    const key = `${input.kind}:${input.sourceVersionFileId ?? "-"}`;
    const source = this.artifacts.get(key);
    if (!source) throw new Error("test artifact missing");
    const existing = this.rows.get(key);
    if (existing) return { ...existing };
    const row: DriveBackupRow = {
      id: `70000000-0000-4000-8000-${this.rows.size.toString().padStart(12, "0")}`,
      kind: input.kind,
      backup_identity: input.kind === "source_manifest" ? `svm:${identity.sourceVersionId}`
        : input.kind === "source_file" ? `svf:${input.sourceVersionFileId}` : `run:${identity.runId}`,
      content_sha256: hash(source.bytes), size_bytes: source.bytes.byteLength,
      drive_parent_id: parentId, status: "pending", drive_file_id: null,
      drive_sha256: null, drive_version: null,
    };
    this.rows.set(key, row);
    return { ...row };
  }
  async verify(input: Parameters<DriveBackupStore["verify"]>[0]) {
    const found = [...this.rows.entries()].find(([, row]) => row.id === input.backupId);
    if (!found) return false;
    found[1] = { ...found[1], status: "verified", drive_file_id: input.driveFileId,
      drive_sha256: input.driveSha256, drive_version: input.driveVersion };
    this.rows.set(found[0], found[1]);
    return true;
  }
  async getVerified(backupId: string) {
    return [...this.rows.values()].find((row) => row.id === backupId && row.status === "verified") ?? null;
  }
  async retry(input: Parameters<DriveBackupStore["retry"]>[0]) {
    this.retries.push({ backupId: input.backupId, errorSummary: input.errorSummary });
    return true;
  }
}

class Drive {
  readonly files = new Map<string, SettlementDriveFileMetadata>();
  readonly starts: string[] = [];
  failFind = false;
  failGet = false;
  async findUniqueByAppProperties(parent: string, props: Record<string, string>) {
    if (this.failFind) throw new SettlementDriveError("findUniqueByAppProperties", undefined);
    return [...this.files.values()].find((file) => file.parents?.[0] === parent
      && Object.entries(props).every(([key, value]) => file.appProperties?.[key] === value)) ?? null;
  }
  async getFileMetadata(id: string) {
    if (this.failGet) throw new SettlementDriveError("getFileMetadata", undefined);
    const file = this.files.get(id); if (!file) throw new Error("missing"); return file;
  }
  async startResumableUpload(input: { name: string }) {
    this.starts.push(input.name);
    return `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${this.starts.length}`;
  }
  async uploadResumableChunk(input: { bytes: Uint8Array; totalSizeBytes: number; expectedParentId: string; expectedAppProperties: Record<string, string>; mimeType: string }) {
    const id = `drive_${this.files.size}`;
    const metadata: SettlementDriveFileMetadata = {
      id, name: this.starts.at(-1)!, mimeType: input.mimeType, parents: [input.expectedParentId],
      size: String(input.totalSizeBytes), sha256Checksum: input.expectedAppProperties.content_sha256,
      version: "1", appProperties: { ...input.expectedAppProperties },
    };
    this.files.set(id, metadata);
    return { complete: true as const, metadata };
  }
}

async function fixture() {
  const snapshotDir = path.join(ROOT, "snapshot");
  const filesDir = path.join(snapshotDir, "files");
  const workbookDir = path.join(ROOT, "workbook");
  await fsp.mkdir(path.join(filesDir, "nested"), { recursive: true, mode: 0o700 });
  await fsp.mkdir(workbookDir, { recursive: true, mode: 0o700 });
  const entries = [entry(0, "first.csv"), entry(1, "nested/second.pdf")];
  const manifest = Buffer.from("manifest"); const first = Buffer.from("0"); const second = Buffer.from("1"); const workbook = Buffer.from("workbook");
  await Promise.all([
    fsp.writeFile(path.join(snapshotDir, "manifest.json"), manifest, { mode: 0o600 }),
    fsp.writeFile(path.join(filesDir, entries[0].displayPath), first, { mode: 0o600 }),
    fsp.writeFile(path.join(filesDir, entries[1].displayPath), second, { mode: 0o600 }),
    fsp.writeFile(path.join(workbookDir, "candidate.xlsx"), workbook, { mode: 0o600 }),
  ]);
  const artifacts = new Map<string, { bytes: Buffer; mimeType: string }>([
    ["source_manifest:-", { bytes: manifest, mimeType: "application/json" }],
    [`source_file:${entries[0].versionFileId}`, { bytes: first, mimeType: "application/octet-stream" }],
    [`source_file:${entries[1].versionFileId}`, { bytes: second, mimeType: "application/octet-stream" }],
    ["verified_workbook:-", { bytes: workbook, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }],
  ]);
  return { snapshotDir, candidatePath: path.join(workbookDir, "candidate.xlsx"), entries, artifacts };
}

async function main() {
  await fsp.mkdir(ROOT, { recursive: true, mode: 0o700 });
  try {
    const fx = await fixture();
    const plan = planVersionDriveBackupArtifacts({ identity, snapshotDir: fx.snapshotDir, entries: fx.entries, candidatePath: fx.candidatePath });
    assert.deepEqual(plan.map((item: DriveBackupArtifact) => [item.kind, item.sourceVersionFileId]), [
      ["source_manifest", null], ["source_file", fx.entries[0].versionFileId],
      ["source_file", fx.entries[1].versionFileId], ["verified_workbook", null],
    ]);
    assert.ok(plan.every((item) => !item.name.includes("first") && !item.name.includes("second")));

    const store = new Store(fx.artifacts); const drive = new Drive(); let heartbeats = 0;
    const result = await backupClaimedVersionArtifacts({ identity, snapshot: { snapshotDir: fx.snapshotDir, entries: fx.entries },
      candidatePath: fx.candidatePath, driveParentId: parentId, leaseSeconds: 60 }, {
      store, drive: drive as unknown as SettlementDriveClient, heartbeat: async () => { heartbeats += 1; return true; },
      newAttemptToken: () => randomUUID(),
    });
    assert.equal(result.outcome, "backup_ready");
    assert.equal(result.outcome === "backup_ready" && result.backups.length, 4);
    assert.equal(heartbeats, 8); assert.equal(drive.starts.length, 4);
    assert.deepEqual(store.begins.map((item) => item.sourceVersionFileId), [null, fx.entries[0].versionFileId, fx.entries[1].versionFileId, null]);

    const replay = await backupClaimedVersionArtifacts({ identity, snapshot: { snapshotDir: fx.snapshotDir, entries: fx.entries },
      candidatePath: fx.candidatePath, driveParentId: parentId, leaseSeconds: 60 }, {
      store, drive: drive as unknown as SettlementDriveClient, heartbeat: async () => true,
      newAttemptToken: () => randomUUID(),
    });
    assert.equal(replay.outcome, "backup_ready"); assert.equal(drive.starts.length, 4, "verified replay must not upload");

    drive.failGet = true;
    const verifiedReadRetryCount = store.retries.length;
    assert.deepEqual(await backupClaimedVersionArtifacts({ identity, snapshot: { snapshotDir: fx.snapshotDir, entries: fx.entries },
      candidatePath: fx.candidatePath, driveParentId: parentId, leaseSeconds: 60 }, {
      store, drive: drive as unknown as SettlementDriveClient, heartbeat: async () => true,
      newAttemptToken: () => randomUUID(),
    }), { outcome: "retry" });
    assert.equal(store.retries.length, verifiedReadRetryCount, "verified evidence must not be downgraded to retry");
    drive.failGet = false;

    const lostStore = new Store(fx.artifacts);
    assert.deepEqual(await backupClaimedVersionArtifacts({ identity, snapshot: { snapshotDir: fx.snapshotDir, entries: fx.entries },
      candidatePath: fx.candidatePath, driveParentId: parentId, leaseSeconds: 60 }, {
      store: lostStore, drive: new Drive() as unknown as SettlementDriveClient, heartbeat: async () => false,
    }), { outcome: "lease_lost" });
    assert.equal(lostStore.begins.length, 0);

    const retryStore = new Store(fx.artifacts); const failingDrive = new Drive(); failingDrive.failFind = true;
    assert.deepEqual(await backupClaimedVersionArtifacts({ identity, snapshot: { snapshotDir: fx.snapshotDir, entries: fx.entries },
      candidatePath: fx.candidatePath, driveParentId: parentId, leaseSeconds: 60 }, {
      store: retryStore, drive: failingDrive as unknown as SettlementDriveClient, heartbeat: async () => true,
    }), { outcome: "retry" });
    assert.equal(retryStore.retries.length, 1);
    assert.ok(!retryStore.retries[0].errorSummary.includes(ROOT));

    const badEntries = [{ ...fx.entries[0], displayPath: "../escape.csv" }];
    assert.throws(() => planVersionDriveBackupArtifacts({ identity, snapshotDir: fx.snapshotDir, entries: badEntries, candidatePath: fx.candidatePath }), /plan invalid/);

    const linked = path.join(fx.snapshotDir, "files", "linked.csv");
    await fsp.symlink(path.join(fx.snapshotDir, "files", "first.csv"), linked);
    const linkedEntry = { ...entry(2, "linked.csv") };
    const linkedStore = new Store(new Map([[`source_file:${linkedEntry.versionFileId}`, { bytes: Buffer.from("0"), mimeType: "application/octet-stream" }],
      ["source_manifest:-", fx.artifacts.get("source_manifest:-")!], ["verified_workbook:-", fx.artifacts.get("verified_workbook:-")!]]));
    const linkedResult = await backupClaimedVersionArtifacts({ identity, snapshot: { snapshotDir: fx.snapshotDir, entries: [linkedEntry] },
      candidatePath: fx.candidatePath, driveParentId: parentId, leaseSeconds: 60 }, {
      store: linkedStore, drive: new Drive() as unknown as SettlementDriveClient, heartbeat: async () => true,
    });
    assert.equal(linkedResult.outcome, "failed");
    assert.equal(linkedStore.begins.length, 1, "manifest may finish, symlink source must fail before its reservation");

    console.log("test-settlement-version-drive-backup: all assertions passed");
  } finally { await fsp.rm(ROOT, { recursive: true, force: true }); }
}
void main();
