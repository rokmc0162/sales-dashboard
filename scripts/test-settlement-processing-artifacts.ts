import assert from "node:assert/strict";

import type { LocalWorkbookArtifactResult } from "../src/features/settlement/lib/worker/local-workbook-artifact";
import type { LocalParseStageResult } from "../src/features/settlement/lib/worker/local-parse-stage";
import {
  createPostgresProcessingArtifactFence,
  processSnapshotArtifacts,
} from "../src/features/settlement/lib/worker/version-processing-artifacts";
import type { SnapshotReadyResult, VersionClaimIdentity } from "../src/features/settlement/lib/worker/version-source-adapter";

const IDENTITY: VersionClaimIdentity = {
  jobId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  runId: "11111111-2222-4333-8444-555555555555",
  sourceVersionId: "22222222-3333-4444-8555-666666666666",
  workerId: "worker-1",
  claimToken: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
};
const SNAPSHOT: SnapshotReadyResult = {
  snapshotDir: "/tmp/snapshot",
  manifestDigest: "a".repeat(64), fileCount: 1, totalBytes: 5, reused: false,
  snapshotReady: true, settlementMonth: "2026-07-01", versionNo: 1,
  entries: [{ objectId: "33333333-4444-4555-8666-777777777777", position: 0,
    pathKey: "source.csv", displayPath: "source.csv", sizeBytes: 5,
    sha256: "b".repeat(64), storagePath: `intake/202607/${"a".repeat(32)}/${"b".repeat(32)}` }],
};
const STAGE: LocalParseStageResult = {
  schemaVersion: 1, settlementMonth: "2026-07-01", files: [{
    objectId: SNAPSHOT.entries[0].objectId, position: 0, displayPath: "source.csv",
    platformCode: "synthetic", detectionConfidence: 1, parsedRowCount: 1,
    transformedRowCount: 1, summaryOnly: false, warningCodes: [],
  }], rawRows: [{ objectId: SNAPSHOT.entries[0].objectId, position: 0, rowIndex: 0, data: { ok: true } }],
  salesRows: [{ objectId: SNAPSHOT.entries[0].objectId, position: 0, sourceOrdinal: 0, record: {} as never }],
  counts: { files: 1, rawRows: 1, salesRows: 1, summaryFiles: 0 }, digest: "c".repeat(64),
};
const WORKBOOK: LocalWorkbookArtifactResult = {
  artifactDir: "/tmp/artifact", candidatePath: "/tmp/artifact/candidate.xlsx",
  officePath: "/tmp/artifact/office-verified.xlsx", evidencePath: "/tmp/artifact/evidence.json", reused: false,
  evidence: { schemaVersion: 1, stageDigest: STAGE.digest, settlementMonth: "2026-07-01",
    detailRows: 1, workbookSha256: "d".repeat(64), workbookArchiveDigest: "e".repeat(64),
    workbookSizeBytes: 200, officeWorkbookSha256: "a".repeat(64), officeWorkbookSizeBytes: 210,
    reopened: { sheetCount: 2, rowCount: 3 }, office: {
      verifier: "libreoffice", version: "LibreOffice test", reopened: { sheetCount: 2, rowCount: 3 }, archiveDigest: "f".repeat(64),
    }, baselineMonth: "2026-06-01", baselinePublicationId: null, baselineSha256: "8".repeat(64) },
};

const PERSISTED_STAGE_SHA = "9".repeat(64);
const BASELINE_SHA = "8".repeat(64);

function deps(events: string[], heartbeat = [true, true], stageReady = true, workbookReady = true) {
  return {
    fence: {
      heartbeat: async () => { events.push("heartbeat"); return heartbeat.shift() ?? false; },
      markStageReady: async (input: { stageSha256: string }) => { events.push("stage-ready"); assert.equal(input.stageSha256, PERSISTED_STAGE_SHA); assert.notEqual(input.stageSha256, STAGE.digest); return stageReady; },
      markWorkbookReady: async (input: { workbookSha256: string; officeVerifier: string }) => { events.push("workbook-ready"); assert.equal(input.workbookSha256, WORKBOOK.evidence.officeWorkbookSha256); assert.equal(input.officeVerifier, "libreoffice"); return workbookReady; },
    },
    loadLookups: async () => { events.push("lookups"); return { clientIds: new Map(), channelIds: new Map() }; },
    parseFile: async () => { throw new Error("not called by injected build"); },
    toSalesRecords: () => { throw new Error("not called by injected build"); },
    buildStage: async (input: { settlementMonth: string; snapshotDir: string }) => { events.push("build-stage"); assert.equal(input.settlementMonth, "2026-07-01"); assert.equal(input.snapshotDir, SNAPSHOT.snapshotDir); return STAGE; },
    persistStage: async () => { events.push("persist-stage"); return { stagingDir: "/tmp/staging", stagePath: "/tmp/staging/stage.json", sha256: PERSISTED_STAGE_SHA, sizeBytes: 100, reused: false }; },
    prepareRecords: async () => { events.push("prepare"); return { records: [{}], baselineMonth: "2026-06-01", baselinePublicationId: null, baselineSha256: BASELINE_SHA }; },
    generateWorkbook: async () => { events.push("workbook"); return WORKBOOK; },
    validatePreparedWorkbook: async () => { events.push("validate"); },
    fillWorkbook: async () => { throw new Error("not called by injected workbook"); },
    validateWorkbook: async () => ({ sheetCount: 1, rowCount: 1 }),
    archiveDigest: async () => "0".repeat(64),
  } as never;
}

async function testOrchestration(): Promise<void> {
  const events: string[] = [];
  const result = await processSnapshotArtifacts({ identity: IDENTITY, snapshot: SNAPSHOT, workRoot: "/tmp/work", leaseSeconds: 60 }, deps(events));
  assert.equal(result.outcome, "workbook_ready");
  assert.deepEqual(events, ["heartbeat", "lookups", "build-stage", "persist-stage", "stage-ready", "heartbeat", "prepare", "workbook", "validate", "workbook-ready"]);

  const firstLost: string[] = [];
  assert.equal((await processSnapshotArtifacts({ identity: IDENTITY, snapshot: SNAPSHOT, workRoot: "/tmp/work", leaseSeconds: 60 }, deps(firstLost, [false]))).outcome, "lease_lost");
  assert.deepEqual(firstLost, ["heartbeat"]);
  const stageLost: string[] = [];
  assert.equal((await processSnapshotArtifacts({ identity: IDENTITY, snapshot: SNAPSHOT, workRoot: "/tmp/work", leaseSeconds: 60 }, deps(stageLost, [true], false))).outcome, "lease_lost");
  assert.ok(!stageLost.includes("workbook"));
  const secondLost: string[] = [];
  assert.equal((await processSnapshotArtifacts({ identity: IDENTITY, snapshot: SNAPSHOT, workRoot: "/tmp/work", leaseSeconds: 60 }, deps(secondLost, [true, false]))).outcome, "lease_lost");
  assert.ok(!secondLost.includes("workbook"));

  const prepareFailed: string[] = [];
  const prepareDeps = deps(prepareFailed);
  prepareDeps.prepareRecords = async () => { prepareFailed.push("prepare"); throw new Error("baseline unavailable"); };
  await assert.rejects(() => processSnapshotArtifacts({ identity: IDENTITY, snapshot: SNAPSHOT, workRoot: "/tmp/work", leaseSeconds: 60 }, prepareDeps));
  assert.ok(!prepareFailed.includes("workbook-ready"));

  const validationFailed: string[] = [];
  const validationDeps = deps(validationFailed);
  validationDeps.validatePreparedWorkbook = async () => { validationFailed.push("validate"); throw new Error("semantic mismatch"); };
  await assert.rejects(() => processSnapshotArtifacts({ identity: IDENTITY, snapshot: SNAPSHOT, workRoot: "/tmp/work", leaseSeconds: 60 }, validationDeps));
  assert.ok(!validationFailed.includes("workbook-ready"));

  const mismatchFailed: string[] = [];
  const mismatchDeps = deps(mismatchFailed);
  mismatchDeps.generateWorkbook = async () => {
    mismatchFailed.push("workbook");
    return { ...WORKBOOK, evidence: { ...WORKBOOK.evidence, baselineSha256: "7".repeat(64) } };
  };
  await assert.rejects(() => processSnapshotArtifacts({ identity: IDENTITY, snapshot: SNAPSHOT, workRoot: "/tmp/work", leaseSeconds: 60 }, mismatchDeps));
  assert.ok(!mismatchFailed.includes("workbook-ready"));
}

async function testPostgresFence(): Promise<void> {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => { calls.push({ text: strings.join("?"), values }); return Promise.resolve([{ ok: true }]); }) as never;
  const fence = createPostgresProcessingArtifactFence(sql);
  assert.equal(await fence.heartbeat({ ...IDENTITY, leaseSeconds: 60 }), true);
  assert.equal(await fence.markStageReady({ ...IDENTITY, stageSha256: STAGE.digest, stageSizeBytes: 100, fileCount: 1, rawRowCount: 1, salesRowCount: 1 }), true);
  assert.equal(await fence.markWorkbookReady({ ...IDENTITY, workbookSha256: "d".repeat(64), archiveSha256: "e".repeat(64), sizeBytes: 200, sheetCount: 2, rowCount: 3, officeVerifier: "libreoffice", officeVersion: "LibreOffice test", officeArchiveSha256: "f".repeat(64), officeSheetCount: 2, officeRowCount: 3, baselineMonth: "2026-06-01", baselinePublicationId: null, baselineSha256: BASELINE_SHA }), true);
  assert.match(calls[0].text, /heartbeat_settlement_processing_run/);
  assert.deepEqual(calls[0].values, [IDENTITY.jobId, IDENTITY.runId, IDENTITY.workerId, IDENTITY.claimToken, 60]);
  assert.match(calls[1].text, /mark_settlement_processing_run_stage_ready/);
  assert.deepEqual(calls[1].values, [IDENTITY.jobId, IDENTITY.runId, IDENTITY.workerId, IDENTITY.claimToken, STAGE.digest, 100, 1, 1, 1]);
  assert.match(calls[2].text, /mark_settlement_processing_run_workbook_ready/);
  assert.equal(calls[2].values.length, 17);
}

async function main(): Promise<void> {
  await testOrchestration();
  await testPostgresFence();
  console.log("test-settlement-processing-artifacts: all assertions passed");
}
void main();
