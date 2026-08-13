import assert from "node:assert/strict";

import type { SettlementProcessingRunRow } from "../src/features/settlement/lib/supabase/types";
import {
  claimSettlementVersionRun,
  createPostgresVersionRunLifecycle,
  runClaimedVersionProcessing,
  runClaimedVersionSnapshot,
} from "../src/features/settlement/lib/worker/version-source-runner";
import { VersionSourceSnapshotError } from "../src/features/settlement/lib/worker/version-source-snapshot";

const RUN: SettlementProcessingRunRow = {
  id: "11111111-2222-4333-8444-555555555555",
  job_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  source_version_id: "22222222-3333-4444-8555-666666666666",
  attempt_no: 1,
  parser_version: null,
  rule_version: null,
  status: "claimed",
  worker_id: "worker-1",
  claim_token: "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
  lease_expires_at: "2099-01-01T00:00:00Z",
  heartbeat_at: "2026-08-12T00:00:00Z",
  snapshot_manifest_sha256: null,
  snapshot_file_count: null,
  snapshot_total_bytes: null,
  snapshot_ready_at: null,
  stage_sha256: null,
  stage_size_bytes: null,
  stage_file_count: null,
  stage_raw_row_count: null,
  stage_sales_row_count: null,
  stage_ready_at: null,
  workbook_sha256: null,
  workbook_archive_sha256: null,
  workbook_size_bytes: null,
  workbook_sheet_count: null,
  workbook_row_count: null,
  office_verifier: null,
  office_version: null,
  office_archive_sha256: null,
  office_sheet_count: null,
  office_row_count: null,
  workbook_ready_at: null,
  error_summary: null,
  claimed_at: "2026-08-12T00:00:00Z",
  terminal_at: null,
  created_at: "2026-08-12T00:00:00Z",
  updated_at: "2026-08-12T00:00:00Z",
};
const INPUT = {
  workRoot: "/Volumes/SSD_MacMini_2/Riverse/settlement-worker",
  leaseSeconds: 60,
  supabaseUrl: "https://example.supabase.co",
  serviceRoleKey: "test-key",
};
const READY = {
  snapshotDir: "/tmp/snapshot",
  manifestDigest: "a".repeat(64),
  fileCount: 1,
  totalBytes: 5,
  reused: false,
  snapshotReady: true as const,
  settlementMonth: "2026-07-01",
  versionNo: 1,
  entries: [{
    versionFileId: "22222222-3333-4444-8555-666666666666",
    objectId: "33333333-4444-4555-8666-777777777777",
    position: 0,
    pathKey: "source.csv",
    displayPath: "source.csv",
    sizeBytes: 5,
    sha256: "b".repeat(64),
    storagePath: `intake/202607/${"a".repeat(32)}/${"b".repeat(32)}`,
  }],
};

async function testClaimAndLifecycleSql(): Promise<void> {
  const replies: unknown[] = [[RUN], [{ ok: true }], [{ ok: true }]];
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(replies.shift());
  }) as never;
  assert.deepEqual(await claimSettlementVersionRun(sql, "worker-1", 60), RUN);
  const lifecycle = createPostgresVersionRunLifecycle(sql);
  assert.equal(await lifecycle.fail({ jobId: RUN.job_id, runId: RUN.id, workerId: RUN.worker_id, claimToken: RUN.claim_token, errorSummary: "failed" }), true);
  assert.equal(await lifecycle.release({ jobId: RUN.job_id, runId: RUN.id, workerId: RUN.worker_id, claimToken: RUN.claim_token }), true);
  assert.match(calls[0].text, /claim_settlement_version_job/);
  assert.deepEqual(calls[0].values, ["worker-1", 60]);
  assert.match(calls[1].text, /fail_settlement_processing_run/);
  assert.deepEqual(calls[1].values, [RUN.job_id, RUN.id, RUN.worker_id, RUN.claim_token, "failed"]);
  assert.match(calls[2].text, /release_settlement_processing_run/);
  assert.deepEqual(calls[2].values, [RUN.job_id, RUN.id, RUN.worker_id, RUN.claim_token]);
}

async function testRunnerOutcomes(): Promise<void> {
  let failed = 0;
  let released = 0;
  const base = {
    materialize: async (input: { jobId: string; runId: string; sourceVersionId: string; workerId: string; claimToken: string }) => {
      assert.deepEqual(input, expectIdentity(input));
      return READY;
    },
    fail: async () => { failed += 1; return true; },
    release: async () => { released += 1; return true; },
  };
  const success = await runClaimedVersionSnapshot(RUN, INPUT, base as never);
  assert.equal(success.outcome, "snapshot_ready");

  const interrupted = await runClaimedVersionSnapshot(RUN, INPUT, { ...base, shouldStop: () => true } as never);
  assert.equal(interrupted.outcome, "interrupted");
  assert.equal(released, 1);

  const stale = await runClaimedVersionSnapshot(RUN, INPUT, {
    ...base,
    materialize: async () => { throw new VersionSourceSnapshotError("STALE_RUN", "stale"); },
  } as never);
  assert.equal(stale.outcome, "lease_lost");
  assert.equal(failed, 0);

  const ordinary = await runClaimedVersionSnapshot(RUN, INPUT, {
    ...base,
    materialize: async () => { throw new Error("secret backend detail"); },
  } as never);
  assert.equal(ordinary.outcome, "failed");
  assert.equal(failed, 1);

  const rejected = await runClaimedVersionSnapshot(RUN, INPUT, {
    ...base,
    materialize: async () => { throw new Error("boom"); },
    fail: async () => false,
  } as never);
  assert.equal(rejected.outcome, "lease_lost");

  const invalid = await runClaimedVersionSnapshot({ ...RUN, status: "snapshot_ready" }, INPUT, base as never);
  assert.equal(invalid.outcome, "lease_lost");
}

async function testProcessingRunnerOutcomes(): Promise<void> {
  const events: string[] = [];
  const base = {
    materialize: async () => { events.push("snapshot"); return READY; },
    processArtifacts: async (input: { snapshot: typeof READY; identity: { claimToken: string } }) => {
      events.push("artifacts");
      assert.equal(input.snapshot.settlementMonth, READY.settlementMonth);
      assert.equal(input.identity.claimToken, RUN.claim_token);
      return { outcome: "workbook_ready", stage: {}, workbook: {} };
    },
    backupArtifacts: async () => {
      events.push("backup");
      return { outcome: "backup_ready", backups: [{
        kind: "verified_workbook", backupId: "60000000-0000-4000-8000-000000000001",
        driveFileId: "drive-file", reused: false,
      }] };
    },
    publishWorkbook: async () => {
      events.push("publish");
      return { outcome: "published", publication: {} };
    },
    fail: async (input: { errorSummary: string }) => { events.push(`fail:${input.errorSummary}`); return true; },
    release: async () => { events.push("release"); return true; },
  };
  const success = await runClaimedVersionProcessing(RUN, INPUT, base as never);
  assert.equal(success.outcome, "published");
  assert.deepEqual(events, ["snapshot", "artifacts", "backup", "publish"]);

  const interruptedEvents: string[] = [];
  let stopChecks = 0;
  const interrupted = await runClaimedVersionProcessing(RUN, INPUT, {
    ...base,
    materialize: async () => { interruptedEvents.push("snapshot"); return READY; },
    shouldStop: () => { stopChecks += 1; return stopChecks >= 2; },
    processArtifacts: async () => { interruptedEvents.push("artifacts"); return { outcome: "lease_lost" }; },
    release: async () => { interruptedEvents.push("release"); return true; },
  } as never);
  assert.equal(interrupted.outcome, "interrupted");
  assert.deepEqual(interruptedEvents, ["snapshot", "release"]);

  events.length = 0;
  const stale = await runClaimedVersionProcessing(RUN, INPUT, {
    ...base, processArtifacts: async () => ({ outcome: "lease_lost" }),
  } as never);
  assert.equal(stale.outcome, "lease_lost");
  assert.deepEqual(events, ["snapshot"]);

  events.length = 0;
  const failed = await runClaimedVersionProcessing(RUN, INPUT, {
    ...base, processArtifacts: async () => { throw new Error("secret row content"); },
  } as never);
  assert.equal(failed.outcome, "failed");
  assert.deepEqual(events, ["snapshot", "fail:local artifact failed"]);

  events.length = 0;
  const backupFailed = await runClaimedVersionProcessing(RUN, INPUT, {
    ...base, backupArtifacts: async () => ({ outcome: "failed" }),
  } as never);
  assert.equal(backupFailed.outcome, "failed");
  assert.deepEqual(events, ["snapshot", "artifacts", "fail:drive backup failed"]);

  events.length = 0;
  const backupLost = await runClaimedVersionProcessing(RUN, INPUT, {
    ...base, backupArtifacts: async () => ({ outcome: "lease_lost" }),
  } as never);
  assert.equal(backupLost.outcome, "lease_lost");
  assert.deepEqual(events, ["snapshot", "artifacts"]);

  events.length = 0;
  const backupRetry = await runClaimedVersionProcessing(RUN, INPUT, {
    ...base,
    backupArtifacts: async () => ({ outcome: "retry" }),
    release: async () => { events.push("release"); return true; },
  } as never);
  assert.equal(backupRetry.outcome, "retry");
  assert.deepEqual(events, ["snapshot", "artifacts", "release"]);
}

function expectIdentity(input: { jobId: string; runId: string; sourceVersionId: string; workerId: string; claimToken: string }) {
  return {
    ...input,
    jobId: RUN.job_id,
    runId: RUN.id,
    sourceVersionId: RUN.source_version_id,
    workerId: RUN.worker_id,
    claimToken: RUN.claim_token,
  };
}

async function main(): Promise<void> {
  await testClaimAndLifecycleSql();
  await testRunnerOutcomes();
  await testProcessingRunnerOutcomes();
  console.log("test-settlement-version-source-runner: all assertions passed");
}
void main();
