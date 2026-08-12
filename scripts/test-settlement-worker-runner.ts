import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import type postgres from "postgres";

import type {
  Database,
  SettlementJobFileRow,
  SettlementJobRow,
} from "../src/features/settlement/lib/supabase/types";
import {
  buildSettlementJobArtifactPath,
  claimSettlementJob,
  createPostgresSettlementWorkerStore,
  runSettlementJob,
  validateSettlementWorkbook,
  type SettlementWorkerStore,
  type WorkerFilePatch,
} from "../src/features/settlement/lib/worker/run-job";

const jobId = "11111111-1111-4111-8111-111111111111";
const workerId = "test-worker";
const now = "2026-08-01T00:00:00.000Z";

function sqlFixture(responses: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$param"), values });
    return Promise.resolve(responses.shift() ?? []);
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

function job(total = 2): SettlementJobRow {
  return {
    id: jobId,
    month: "2026-06-01",
    status: "claimed",
    stage: "queued",
    progress_current: 0,
    progress_total: total,
    worker_id: workerId,
    lease_expires_at: "2026-08-01T01:00:00.000Z",
    heartbeat_at: now,
    source_version_id: null,
    claim_token: "99999999-9999-4999-8999-999999999999",
    attempt_count: 1,
    parser_version: null,
    rule_version: null,
    error_summary: null,
    result_summary: null,
    artifact_storage_path: null,
    workbook_sheet_count: null,
    workbook_row_count: null,
    created_at: now,
    updated_at: now,
    started_at: now,
    completed_at: null,
  };
}

function file(position: number): SettlementJobFileRow {
  return {
    id: `${position + 2}2222222-2222-4222-8222-222222222222`.slice(0, 36),
    job_id: jobId,
    upload_id: `${position + 3}3333333-3333-4333-8333-333333333333`.slice(0, 36),
    source_version_file_id: null,
    position,
    folder_hint: position === 0 ? "folder-a" : null,
    status: "queued",
    parsed_rows: null,
    sales_records_written: null,
    sales_records_skipped_duplicates: null,
    result_summary: null,
    error_summary: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
  };
}

function memoryStore(
  files: SettlementJobFileRow[],
  heartbeatValues: boolean[] = [],
  releaseValues: boolean[] = [],
) {
  const patches: Array<{ fileId: string; patch: WorkerFilePatch }> = [];
  const heartbeats: Array<{ stage: string; current: number }> = [];
  const releases: Array<{ jobId: string; workerId: string }> = [];
  const artifacts: Array<{ path: string; buffer: Buffer }> = [];
  const finishes: Parameters<SettlementWorkerStore["finish"]>[0][] = [];
  const store: SettlementWorkerStore = {
    listFiles: async () => files.map((item) => ({ ...item })),
    updateFile: async (input) => {
      patches.push({ fileId: input.fileId, patch: input.patch });
      const target = files.find((item) => item.id === input.fileId);
      if (target) Object.assign(target, input.patch);
      return true;
    },
    heartbeat: async (input) => {
      heartbeats.push({ stage: input.stage, current: input.progressCurrent });
      return heartbeatValues.length > 0 ? (heartbeatValues.shift() ?? true) : true;
    },
    release: async (releasedJobId, releasedWorkerId) => {
      releases.push({ jobId: releasedJobId, workerId: releasedWorkerId });
      return releaseValues.length > 0 ? (releaseValues.shift() ?? true) : true;
    },
    uploadArtifact: async (path, buffer) => { artifacts.push({ path, buffer }); },
    finish: async (input) => { finishes.push(input); return true; },
  };
  return { store, patches, heartbeats, releases, artifacts, finishes };
}

function baseDeps(store: SettlementWorkerStore) {
  return {
    store,
    now: () => now,
    logger: { log() {}, warn() {}, error() {} },
    loadRecords: async () => ({ records: [{ safe: true }], loadError: null, sourceWarnings: [] }),
    fillWorkbook: async () => ({ buffer: Buffer.from("workbook"), rows_written: 1 }),
    validateWorkbook: async () => ({ sheetCount: 1, rowCount: 7 }),
  };
}

async function main() {
  assert.equal(
    buildSettlementJobArtifactPath(job()),
    `job-artifacts/2026-06/${jobId}.xlsx`,
  );
  assert.match(buildSettlementJobArtifactPath(job()), /^[A-Za-z0-9/._-]+$/);

  {
    const state = memoryStore([file(0)]);
    let processed = false;
    let loaded = false;
    const result = await runSettlementJob(
      { ...job(1), source_version_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      workerId,
      3_600,
      {
        ...baseDeps(state.store),
        processUpload: async () => { processed = true; return { status: 200, body: {} }; },
        loadRecords: async () => { loaded = true; return { records: [], loadError: null, sourceWarnings: [] }; },
      },
    );
    assert.deepEqual(result, { outcome: "failed", filesProcessed: 0, filesFailed: 0 });
    assert.equal(processed, false);
    assert.equal(loaded, false);
    assert.equal(state.heartbeats.length, 0);
    assert.equal(state.patches.length, 0);
    assert.equal(state.artifacts.length, 0);
    assert.equal(state.finishes.length, 0);
  }

  {
    const versionFile = {
      ...file(0),
      upload_id: null,
      source_version_file_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    const state = memoryStore([versionFile]);
    let processed = false;
    let loaded = false;
    const result = await runSettlementJob(job(1), workerId, 3_600, {
      ...baseDeps(state.store),
      processUpload: async () => { processed = true; return { status: 200, body: {} }; },
      loadRecords: async () => { loaded = true; return { records: [], loadError: null, sourceWarnings: [] }; },
    });
    assert.deepEqual(result, { outcome: "failed", filesProcessed: 0, filesFailed: 0 });
    assert.equal(processed, false);
    assert.equal(loaded, false);
    assert.equal(state.patches.length, 0);
    assert.equal(state.artifacts.length, 0);
    assert.equal(state.finishes.length, 0);
  }

  {
    const state = memoryStore([file(0), file(1)]);
    let calls = 0;
    const result = await runSettlementJob(job(), workerId, 3_600, {
      ...baseDeps(state.store),
      processUpload: async () => {
        calls += 1;
        return calls === 1
          ? {
              status: 200,
              body: { results: [{
                parsed_rows: 9_999_999_999,
                sales_records_written: 4,
                sales_records_skipped_duplicates: 2,
                title: "must not persist",
                amount_jpy: 123,
              }] },
            }
          : { status: 200, body: { results: [{ skipped: true, skip_reason: "/private/source" }] } };
      },
    });
    assert.deepEqual(result, { outcome: "completed", filesProcessed: 2, filesFailed: 0 });
    assert.equal(calls, 2);
    assert.equal(state.artifacts.length, 1);
    assert.equal(state.artifacts[0].path, `job-artifacts/2026-06/${jobId}.xlsx`);
    assert.equal(state.finishes[0].status, "completed");
    assert.equal(state.finishes[0].workbookSheetCount, 1);
    assert.equal(state.patches.some(({ patch }) => patch.parsed_rows === 1_000_000), true);
    const operationalJson = JSON.stringify({ patches: state.patches, finish: state.finishes });
    for (const forbidden of ["must not persist", "/private/source", "amount_jpy", "skip_reason"]) {
      assert.equal(operationalJson.includes(forbidden), false);
    }
  }

  {
    const state = memoryStore([file(0), file(1)]);
    let calls = 0;
    const result = await runSettlementJob(job(), workerId, 3_600, {
      ...baseDeps(state.store),
      processUpload: async () => {
        calls += 1;
        if (calls === 1) throw new Error("/private/path title and amount 999 JPY");
        return { status: 200, body: { results: [{ parsed_rows: 1, sales_records_written: 1 }] } };
      },
    });
    assert.deepEqual(result, { outcome: "completed_with_warnings", filesProcessed: 2, filesFailed: 1 });
    assert.equal(calls, 2, "the runner must continue after an individual file failure");
    assert.equal(state.finishes[0].status, "completed_with_warnings");
    assert.equal(state.patches.some(({ patch }) => patch.error_summary === "file processing failed"), true);
    assert.equal(JSON.stringify(state).includes("/private/path"), false);
  }

  {
    const state = memoryStore([file(0)]);
    const result = await runSettlementJob(job(1), workerId, 3_600, {
      ...baseDeps(state.store),
      processUpload: async () => ({ status: 200, body: { results: [{}] } }),
      validateWorkbook: async () => { throw new Error("cell title leaked"); },
    });
    assert.equal(result.outcome, "failed");
    assert.equal(state.artifacts.length, 0);
    assert.equal(state.finishes[0].status, "failed");
    assert.equal(state.finishes[0].errorSummary, "workbook validation failed");
    assert.equal(JSON.stringify(state.finishes).includes("cell title leaked"), false);
  }

  {
    // Initial heartbeat succeeds; lease is lost at the pre-file checkpoint.
    const state = memoryStore([file(0)], [true, false]);
    let processed = false;
    const result = await runSettlementJob(job(1), workerId, 3_600, {
      ...baseDeps(state.store),
      processUpload: async () => { processed = true; return { status: 200, body: { results: [{}] } }; },
    });
    assert.equal(result.outcome, "lease_lost");
    assert.equal(processed, false);
    assert.equal(state.finishes.length, 0);
    assert.equal(state.artifacts.length, 0);
  }

  {
    // A reclaimed job must not replay a file that the previous worker left in
    // the non-transactional processing state.
    const interrupted = file(0);
    interrupted.status = "processing";
    const state = memoryStore([interrupted]);
    let called = false;
    const result = await runSettlementJob(job(1), workerId, 3_600, {
      ...baseDeps(state.store),
      processUpload: async () => {
        called = true;
        return { status: 200, body: { results: [{}] } };
      },
    });
    assert.equal(result.outcome, "failed");
    assert.equal(called, false, "an interrupted in-flight file must never be replayed automatically");
    assert.equal(state.finishes[0].errorSummary, "interrupted file requires review");
  }

  {
    // A long-running parser must renew the job lease while it is inside a
    // single file, not only at file boundaries.
    const state = memoryStore([file(0)]);
    const originalHeartbeat = state.store.heartbeat;
    let insideParser = false;
    let heartbeatsInsideParser = 0;
    state.store.heartbeat = async (input) => {
      if (insideParser) heartbeatsInsideParser += 1;
      return originalHeartbeat(input);
    };
    const result = await runSettlementJob(job(1), workerId, 3_600, {
      ...baseDeps(state.store),
      leaseHeartbeatIntervalMs: 1,
      processUpload: async () => {
        insideParser = true;
        await new Promise((resolve) => setTimeout(resolve, 12));
        insideParser = false;
        return { status: 200, body: { results: [{ parsed_rows: 1, sales_records_written: 1 }] } };
      },
    });
    assert.equal(result.outcome, "completed");
    assert.ok(heartbeatsInsideParser > 0, "lease must renew during a long file parse");
  }

  {
    // Loading records, filling the workbook, validating it, and uploading the
    // artifact must each renew the lease while that operation is in progress.
    const state = memoryStore([file(0)]);
    const heartbeatsByOperation = new Map<string, number>();
    let activeOperation: string | null = null;
    const originalHeartbeat = state.store.heartbeat;
    state.store.heartbeat = async (input) => {
      if (activeOperation) {
        heartbeatsByOperation.set(activeOperation, (heartbeatsByOperation.get(activeOperation) ?? 0) + 1);
      }
      return originalHeartbeat(input);
    };
    const delayed = async <T>(name: string, value: T): Promise<T> => {
      activeOperation = name;
      await new Promise((resolve) => setTimeout(resolve, 8));
      activeOperation = null;
      return value;
    };
    state.store.uploadArtifact = async () => {
      await delayed("upload", undefined);
    };
    const result = await runSettlementJob(job(1), workerId, 3_600, {
      ...baseDeps(state.store),
      leaseHeartbeatIntervalMs: 1,
      processUpload: async () => ({ status: 200, body: { results: [{}] } }),
      loadRecords: () => delayed("load", { records: [{ safe: true }], loadError: null }),
      fillWorkbook: () => delayed("fill", { buffer: Buffer.from("workbook"), rows_written: 1 }),
      validateWorkbook: () => delayed("validate", { sheetCount: 1, rowCount: 1 }),
    });
    assert.equal(result.outcome, "completed");
    for (const operation of ["load", "fill", "validate", "upload"]) {
      assert.ok(
        (heartbeatsByOperation.get(operation) ?? 0) > 0,
        `lease must renew during workbook ${operation}`,
      );
    }
  }

  {
    // Lease loss during workbook generation fences all later side effects.
    const state = memoryStore([file(0)]);
    let insideFill = false;
    let validated = false;
    const originalHeartbeat = state.store.heartbeat;
    state.store.heartbeat = async (input) => insideFill ? false : originalHeartbeat(input);
    const result = await runSettlementJob(job(1), workerId, 3_600, {
      ...baseDeps(state.store),
      leaseHeartbeatIntervalMs: 1,
      processUpload: async () => ({ status: 200, body: { results: [{}] } }),
      fillWorkbook: async () => {
        insideFill = true;
        await new Promise((resolve) => setTimeout(resolve, 8));
        insideFill = false;
        return { buffer: Buffer.from("workbook"), rows_written: 1 };
      },
      validateWorkbook: async () => {
        validated = true;
        return { sheetCount: 1, rowCount: 1 };
      },
    });
    assert.equal(result.outcome, "lease_lost");
    assert.equal(validated, false);
    assert.equal(state.artifacts.length, 0);
    assert.equal(state.finishes.length, 0);
  }

  {
    // SIGTERM is represented by shouldStop; after the file reaches a terminal
    // checkpoint the job is requeued immediately instead of retaining its lease.
    const state = memoryStore([file(0)]);
    let stopping = false;
    const result = await runSettlementJob(job(1), workerId, 7_200, {
      ...baseDeps(state.store),
      shouldStop: () => stopping,
      processUpload: async () => {
        stopping = true;
        return { status: 200, body: { results: [{}] } };
      },
    });
    assert.deepEqual(result, { outcome: "interrupted", filesProcessed: 1, filesFailed: 0 });
    assert.deepEqual(state.releases, [{ jobId, workerId }]);
    assert.equal(state.artifacts.length, 0);
    assert.equal(state.finishes.length, 0);
  }

  {
    const queuedFile = file(0);
    const fixture = sqlFixture([
      [queuedFile],
      [{ id: queuedFile.id }],
      [{ ok: true }],
      [{ ok: true }],
      [{ ok: true }],
      [{ ...job(1), month: new Date("2026-06-01T00:00:00.000Z") }],
    ]);
    const uploads: Array<{ path: string; bytes: number }> = [];
    const storageClient = {
      storage: {
        from: () => ({
          upload: async (path: string, buffer: Buffer) => {
            uploads.push({ path, bytes: buffer.length });
            return { error: null };
          },
        }),
      },
    } as unknown as SupabaseClient<Database>;
    const store = createPostgresSettlementWorkerStore(fixture.sql, storageClient);

    assert.deepEqual(await store.listFiles(jobId), [queuedFile]);
    assert.match(fixture.calls[0].text, /source_version_file_id/,
      "legacy file query must materialize the nullable version-contract column");
    assert.equal(await store.updateFile({
      jobId,
      workerId,
      fileId: queuedFile.id,
      patch: { status: "processing", completed_at: null },
    }), true);
    assert.equal(await store.heartbeat({
      jobId,
      workerId,
      leaseSeconds: 900,
      stage: "parsing",
      progressCurrent: 0,
      progressTotal: 1,
    }), true);
    assert.equal(await store.release(jobId, workerId), true);
    await store.uploadArtifact("job-artifacts/2026-06/test.xlsx", Buffer.from("xlsx"));
    assert.equal(await store.finish({
      jobId,
      workerId,
      status: "completed",
      errorSummary: null,
      resultSummary: "done",
      artifactStoragePath: "job-artifacts/2026-06/test.xlsx",
      workbookSheetCount: 1,
      workbookRowCount: 2,
    }), true);
    const claimed = await claimSettlementJob(fixture.sql, workerId, 900);
    assert.equal(claimed?.id, jobId);
    assert.equal(claimed?.month, "2026-06-01");
    assert.deepEqual(uploads, [{ path: "job-artifacts/2026-06/test.xlsx", bytes: 4 }]);
    assert.equal(fixture.calls.length, 6);
    for (const call of fixture.calls) {
      assert.equal(call.text.includes(jobId), false, "job IDs must be bound parameters");
      assert.equal(call.text.includes(workerId), false, "worker IDs must be bound parameters");
    }
    assert.equal(fixture.calls[0].values.includes(jobId), true);
    assert.equal(fixture.calls[5].values.includes(workerId), true);
    assert.match(fixture.calls[1].text, /with owned_job[\s\S]+worker_id = \$param[\s\S]+status in \('claimed', 'processing'\)/i);
    assert.match(fixture.calls[1].text, /lease_expires_at >= clock_timestamp\(\)/i);
    assert.match(fixture.calls[1].text, /file\.job_id = \$param[\s\S]+file\.job_id = owned_job\.id/i);
    assert.equal(fixture.calls[1].values.includes(jobId), true);
    assert.equal(fixture.calls[1].values.includes(workerId), true);
    assert.match(fixture.calls[3].text, /release_settlement_job/i);
  }

  {
    const staleFixture = sqlFixture([[]]);
    const storageClient = { storage: { from: () => ({}) } } as unknown as SupabaseClient<Database>;
    const staleStore = createPostgresSettlementWorkerStore(staleFixture.sql, storageClient);
    assert.equal(await staleStore.updateFile({
      jobId,
      workerId: "stale-worker",
      fileId: file(0).id,
      patch: { status: "completed" },
    }), false, "a stale worker must not update a job file");
  }

  {
    const makeArchive = async (content: string, date: Date) => {
      const zip = new JSZip();
      zip.file("[Content_Types].xml", content, { date });
      zip.file("xl/workbook.xml", "<workbook/>", { date });
      return Buffer.from(await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    };
    const artifact = await makeArchive("same", new Date("2026-01-01T00:00:00Z"));
    const replayArtifact = await makeArchive("same", new Date("2026-02-01T00:00:00Z"));
    assert.notDeepEqual(artifact, replayArtifact, "ZIP metadata should differ for this replay test");
    const replayStorageClient = {
      storage: {
        from: () => ({
          upload: async () => ({
            error: { statusCode: 409, message: "The resource already exists" },
          }),
          download: async () => ({
            data: new Blob([new Uint8Array(replayArtifact)]),
            error: null,
          }),
        }),
      },
    } as unknown as SupabaseClient<Database>;
    const replayStore = createPostgresSettlementWorkerStore(sqlFixture([]).sql, replayStorageClient);
    await replayStore.uploadArtifact("job-artifacts/2026-06/replay.xlsx", artifact);

    const mismatchedArtifact = await makeArchive("different", new Date("2026-02-01T00:00:00Z"));
    const mismatchStorageClient = {
      storage: {
        from: () => ({
          upload: async () => ({
            error: { statusCode: 409, message: "The resource already exists" },
          }),
          download: async () => ({
            data: new Blob([new Uint8Array(mismatchedArtifact)]),
            error: null,
          }),
        }),
      },
    } as unknown as SupabaseClient<Database>;
    const mismatchStore = createPostgresSettlementWorkerStore(sqlFixture([]).sql, mismatchStorageClient);
    await assert.rejects(
      mismatchStore.uploadArtifact("job-artifacts/2026-06/replay.xlsx", artifact),
      /artifact replay mismatch/,
    );
  }

  {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("INPUT");
    sheet.addRow(["header"]);
    sheet.addRow(["value"]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    assert.deepEqual(await validateSettlementWorkbook(buffer), { sheetCount: 1, rowCount: 2 });
    await assert.rejects(validateSettlementWorkbook(Buffer.from("not xlsx")));
  }

  console.log("test-settlement-worker-runner: all assertions passed");
}

void main();
