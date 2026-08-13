import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { backupClaimedVersionToLocalSync, createPostgresLocalSyncBackupStore } from "../src/features/settlement/lib/worker/version-local-sync-backup";
import type { ProcessingArtifactOutcome } from "../src/features/settlement/lib/worker/version-processing-artifacts";
import type { SnapshotReadyResult, VersionClaimIdentity } from "../src/features/settlement/lib/worker/version-source-adapter";

const ROOT = path.resolve(`.tmp/version-local-sync-${process.pid}-${randomUUID()}`);
const BASE = path.join(ROOT, "allowed");
const SYNC = path.join(BASE, "Sales_RVJP");
const SNAPSHOT = path.join(ROOT, "snapshot");
const ARTIFACT = path.join(ROOT, "artifact");
const identity: VersionClaimIdentity = {
  jobId: "10000000-0000-4000-8000-000000000001",
  runId: "20000000-0000-4000-8000-000000000001",
  sourceVersionId: "30000000-0000-4000-8000-000000000001",
  workerId: "worker-test",
  claimToken: "40000000-0000-4000-8000-000000000001",
};
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function fixture() {
  const source = Buffer.from("source");
  const office = Buffer.from("office-workbook");
  await fsp.mkdir(path.join(SNAPSHOT, "files", "nested"), { recursive: true, mode: 0o700 });
  await fsp.mkdir(ARTIFACT, { recursive: true, mode: 0o700 });
  await Promise.all([
    fsp.writeFile(path.join(SNAPSHOT, "manifest.json"), "manifest", { mode: 0o600 }),
    fsp.writeFile(path.join(SNAPSHOT, "files", "nested", "input.csv"), source, { mode: 0o600 }),
    fsp.writeFile(path.join(ARTIFACT, "candidate.xlsx"), "candidate", { mode: 0o600 }),
    fsp.writeFile(path.join(ARTIFACT, "office-verified.xlsx"), office, { mode: 0o600 }),
    fsp.writeFile(path.join(ARTIFACT, "evidence.json"), "{\"ok\":true}\n", { mode: 0o600 }),
  ]);
  const snapshot: SnapshotReadyResult = {
    snapshotReady: true,
    snapshotDir: SNAPSHOT,
    manifestDigest: "a".repeat(64),
    fileCount: 1,
    totalBytes: source.length,
    reused: false,
    settlementMonth: "2026-08-01",
    versionNo: 2,
    entries: [{
      versionFileId: "50000000-0000-4000-8000-000000000001",
      objectId: "60000000-0000-4000-8000-000000000001",
      position: 0,
      pathKey: "nested/input.csv",
      displayPath: "nested/input.csv",
      sizeBytes: source.length,
      sha256: sha(source),
      storagePath: "intake/202608/00000000000000000000000000000001/00000000000000000000000000000001",
    }],
  };
  const workbook: Extract<ProcessingArtifactOutcome, { outcome: "workbook_ready" }> = {
    outcome: "workbook_ready",
    stage: { stagingDir: "x", stagePath: "x", sha256: "b".repeat(64), sizeBytes: 1, reused: false },
    workbook: {
      artifactDir: ARTIFACT,
      candidatePath: path.join(ARTIFACT, "candidate.xlsx"),
      officePath: path.join(ARTIFACT, "office-verified.xlsx"),
      evidencePath: path.join(ARTIFACT, "evidence.json"),
      reused: false,
      evidence: {
        schemaVersion: 1, stageDigest: "c".repeat(64), settlementMonth: "2026-08-01", detailRows: 1,
        workbookSha256: sha(Buffer.from("candidate")), workbookArchiveDigest: "d".repeat(64), workbookSizeBytes: 9,
        officeWorkbookSha256: sha(office), officeWorkbookSizeBytes: office.length,
        reopened: { sheetCount: 1, rowCount: 1 },
        office: { verifier: "libreoffice", version: "test", reopened: { sheetCount: 1, rowCount: 1 }, archiveDigest: "e".repeat(64) },
      },
    },
  };
  return { snapshot, workbook };
}

async function main() {
  await fsp.mkdir(SYNC, { recursive: true, mode: 0o700 });
  try {
    const fx = await fixture();
    const recorded: Array<Parameters<ReturnType<typeof createPostgresLocalSyncBackupStore>["verifyArchive"]>[0]> = [];
    const result = await backupClaimedVersionToLocalSync({ identity, snapshot: fx.snapshot, workbook: fx.workbook, root: SYNC, allowedBaseRoot: BASE, leaseSeconds: 60 }, {
      store: { verifyArchive: async (input) => { recorded.push(input); return true; } },
      heartbeat: async () => true,
    });
    assert.equal(result.outcome, "backup_ready");
    assert.equal(recorded.length, 1);
    const saved = recorded[0];
    assert.equal(saved.relativeArchivePath, `2026-08/v002-${identity.sourceVersionId}/run-${identity.runId}`);
    assert.ok(saved.files.some((file) => file.relativePath === "결과/office-verified.xlsx" && file.sha256 === fx.workbook.workbook.evidence.officeWorkbookSha256));
    const replay = await backupClaimedVersionToLocalSync({ identity, snapshot: fx.snapshot, workbook: fx.workbook, root: SYNC, allowedBaseRoot: BASE, leaseSeconds: 60 }, {
      store: { verifyArchive: async () => true }, heartbeat: async () => true,
    });
    assert.equal(replay.outcome, "backup_ready");
    assert.equal(replay.outcome === "backup_ready" && replay.backups[0].reused, true);

    const rejected = await backupClaimedVersionToLocalSync({ identity, snapshot: { ...fx.snapshot, versionNo: 3 }, workbook: fx.workbook, root: SYNC, allowedBaseRoot: BASE, leaseSeconds: 60 }, {
      store: { verifyArchive: async () => false }, heartbeat: async () => true,
    });
    assert.deepEqual(rejected, { outcome: "lease_lost" });
    const interrupted = await backupClaimedVersionToLocalSync({ identity, snapshot: { ...fx.snapshot, versionNo: 4 }, workbook: fx.workbook, root: SYNC, allowedBaseRoot: BASE, leaseSeconds: 60 }, {
      store: { verifyArchive: async () => true }, heartbeat: async () => false,
    });
    assert.deepEqual(interrupted, { outcome: "lease_lost" });

    const calls: Array<{ text: string; values: unknown[] }> = [];
    const sql = Object.assign(((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join("?"), values }); return Promise.resolve([{ ok: true }]);
    }), { json: (value: unknown) => value }) as never;
    const store = createPostgresLocalSyncBackupStore(sql);
    assert.equal(await store.verifyArchive({ ...identity, relativeArchivePath: saved.relativeArchivePath, evidenceSha256: saved.evidenceSha256, files: saved.files }), true);
    assert.match(calls[0].text, /verify_settlement_local_sync_archive/);
    assert.equal(calls[0].values[0], identity.jobId);
    console.log("test-settlement-version-local-sync-backup: all assertions passed");
  } finally { await fsp.rm(ROOT, { recursive: true, force: true }); }
}
void main();
