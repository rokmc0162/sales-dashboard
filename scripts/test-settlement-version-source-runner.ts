import assert from "node:assert/strict";

import type { SettlementProcessingRunRow } from "../src/features/settlement/lib/supabase/types";
import {
  claimSettlementVersionRun,
  createPostgresVersionRunLifecycle,
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
  console.log("test-settlement-version-source-runner: all assertions passed");
}
void main();
