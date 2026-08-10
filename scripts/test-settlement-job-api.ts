import assert from "node:assert/strict";
import type postgres from "postgres";

import { GET as getJobRoute } from "../app/api/settlement/jobs/[id]/route";
import { GET as getLatestJobRoute, POST as postJobRoute } from "../app/api/settlement/jobs/route";
import type {
  SettlementJobFileRow,
  SettlementJobRow,
} from "../src/features/settlement/lib/supabase/types";
import {
  createPostgresSettlementJobApiStore,
  createSettlementJob,
  getLatestSettlementJob,
  getSettlementJob,
  isTerminalSettlementJobStatus,
  projectSettlementJob,
  validateCreateSettlementJobInput,
  type JobUploadSource,
  type SettlementJobApiStore,
} from "../src/features/settlement/lib/worker/job-contract";

const jobId = "11111111-1111-4111-8111-111111111111";
const uploadA = "22222222-2222-4222-8222-222222222222";
const uploadB = "33333333-3333-4333-8333-333333333333";
const now = "2026-08-01T00:00:00.000Z";

function sqlFixture(responses: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$param"), values });
    return Promise.resolve(responses.shift() ?? []);
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

const job: SettlementJobRow = {
  id: jobId,
  month: "2026-06-01",
  status: "completed_with_warnings",
  stage: "completed",
  progress_current: 2,
  progress_total: 2,
  worker_id: "private-worker",
  lease_expires_at: null,
  heartbeat_at: now,
  parser_version: "private-version",
  rule_version: null,
  error_summary: "token=secret /private/path title amount JPY",
  result_summary: "2 file(s) processed; 1 warning(s)",
  artifact_storage_path: `job-artifacts/2026-06/${jobId}.xlsx`,
  workbook_sheet_count: 1,
  workbook_row_count: 20,
  created_at: now,
  updated_at: now,
  started_at: now,
  completed_at: now,
};

function file(overrides: Partial<SettlementJobFileRow> = {}): SettlementJobFileRow {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    job_id: jobId,
    upload_id: uploadA,
    position: 0,
    folder_hint: "private/folder",
    status: "completed",
    parsed_rows: 3,
    sales_records_written: 2,
    sales_records_skipped_duplicates: 1,
    result_summary: "file processed",
    error_summary: null,
    created_at: now,
    updated_at: now,
    started_at: now,
    completed_at: now,
    ...overrides,
  };
}

function storeFor(uploads: JobUploadSource[]): SettlementJobApiStore {
  return {
    loadUploads: async () => uploads,
    enqueue: async () => jobId,
    getJob: async () => job,
    getLatestJobForMonth: async () => job,
    getJobFiles: async () => [{ ...file(), filename: "folder/private-report.xlsx" }],
  };
}

async function main() {
  const validBody = {
    month: "2026-06-01",
    files: [
      { upload_id: uploadA, position: 0, folder_hint: "parent-a" },
      { upload_id: uploadB, position: 1 },
    ],
  };
  assert.equal(validateCreateSettlementJobInput(validBody).ok, true);
  assert.equal(validateCreateSettlementJobInput({ ...validBody, month: "2026-06-02" }).ok, false);
  assert.equal(validateCreateSettlementJobInput({
    ...validBody,
    files: [{ upload_id: "bad", position: 0 }],
  }).ok, false);
  assert.equal(validateCreateSettlementJobInput({
    ...validBody,
    files: [
      { upload_id: uploadA, position: 0 },
      { upload_id: uploadA, position: 1 },
    ],
  }).ok, false);
  assert.equal(validateCreateSettlementJobInput({
    ...validBody,
    files: [
      { upload_id: uploadA, position: 0 },
      { upload_id: uploadB, position: 0 },
    ],
  }).ok, false);
  assert.equal(validateCreateSettlementJobInput({
    ...validBody,
    files: [{ upload_id: uploadA, position: 0, folder_hint: "x".repeat(201) }],
  }).ok, false);

  const sources: JobUploadSource[] = [
    {
      id: uploadA,
      filename: "a.xlsx",
      storage_path: `uploads/2026-06/${uploadA}.xlsx`,
      settlement_month: "2026-06-01",
      status: "uploaded",
    },
    {
      id: uploadB,
      filename: "b.xlsx",
      storage_path: `uploads/2026-06/${uploadB}.xlsx`,
      settlement_month: "2026-06-01",
      status: "uploaded",
    },
  ];
  {
    const fixture = sqlFixture([
      sources,
      [{ job_id: jobId }],
      [job],
      [job],
      [{ ...file(), filename: "folder/private-report.xlsx" }],
    ]);
    const directStore = createPostgresSettlementJobApiStore(fixture.sql);
    assert.deepEqual(await directStore.loadUploads([uploadA, uploadB]), sources);
    assert.equal(await directStore.enqueue(validBody), jobId);
    assert.equal((await directStore.getJob(jobId))?.id, jobId);
    assert.equal((await directStore.getLatestJobForMonth("2026-06-01"))?.id, jobId);
    assert.equal((await directStore.getJobFiles(jobId))[0].filename, "folder/private-report.xlsx");
    assert.equal(fixture.calls.length, 5);
    for (const call of fixture.calls) {
      assert.equal(call.text.includes(jobId), false, "job IDs must be bound parameters");
      assert.equal(call.text.includes(uploadA), false, "upload IDs must be bound parameters");
    }
    assert.deepEqual(fixture.calls[0].values[0], [uploadA, uploadB]);
    assert.equal(fixture.calls[1].values.includes(JSON.stringify(validBody.files)), true);
  }
  assert.deepEqual(await createSettlementJob(storeFor(sources), validBody), {
    ok: true,
    job_id: jobId,
  });
  assert.deepEqual(await createSettlementJob(storeFor([
    sources[0],
    { ...sources[1], settlement_month: "2026-05-01" },
  ]), validBody), {
    ok: false,
    status: 409,
    error: "upload not ready for selected month",
  });
  assert.equal((await createSettlementJob(storeFor([
    sources[0],
    { ...sources[1], status: "parsing" },
  ]), validBody)).ok, false);
  assert.equal((await createSettlementJob(storeFor([
    sources[0],
    { ...sources[1], storage_path: "uploads/2026-06/../secret.xlsx" },
  ]), validBody)).ok, false);

  const duplicateStore = storeFor(sources);
  duplicateStore.enqueue = async () => { throw new Error("upload already assigned to a job"); };
  const duplicate = await createSettlementJob(duplicateStore, validBody);
  assert.deepEqual(duplicate, {
    ok: false,
    status: 409,
    error: "one or more uploads cannot be assigned",
  });

  const projection = projectSettlementJob(job, [{
    ...file(),
    filename: "folder/private-report.xlsx",
  }]);
  assert.equal(projection.terminal, true);
  assert.equal(projection.files[0].filename, "private-report.xlsx");
  assert.equal(projection.error_summary, "details withheld");
  const serialized = JSON.stringify(projection);
  for (const forbidden of [
    "artifact_storage_path", "job-artifacts/", "worker_id", "private-worker",
    "parser_version", "folder_hint", "upload_id", uploadA, "service_role", "raw_records",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `safe projection leaked ${forbidden}`);
  }
  assert.equal(isTerminalSettlementJobStatus("processing"), false);
  assert.equal(isTerminalSettlementJobStatus("completed"), true);
  const fetched = await getSettlementJob(storeFor(sources), jobId);
  assert.equal(fetched.ok, true);
  const latest = await getLatestSettlementJob(storeFor(sources), "2026-06-01");
  assert.equal(latest.ok, true);
  if (latest.ok) assert.equal(latest.value?.id, jobId);
  const noLatestStore = storeFor(sources);
  noLatestStore.getLatestJobForMonth = async () => null;
  assert.deepEqual(await getLatestSettlementJob(noLatestStore, "2026-06-01"), {
    ok: true,
    value: null,
  });
  assert.deepEqual(await getLatestSettlementJob(storeFor(sources), "2026-06-02"), {
    ok: false,
    status: 400,
    error: "month must be YYYY-MM-01",
  });
  assert.deepEqual(await getSettlementJob(storeFor(sources), "bad"), {
    ok: false,
    status: 400,
    error: "invalid job id",
  });

  const unauthorizedPost = await postJobRoute(new Request("http://local/api/settlement/jobs", {
    method: "POST",
    body: JSON.stringify(validBody),
    headers: {
      "content-type": "application/json",
      origin: "http://local",
      "sec-fetch-site": "same-origin",
    },
  }));
  assert.equal(unauthorizedPost.status, 401);
  const missingOriginPost = await postJobRoute(new Request("http://local/api/settlement/jobs", {
    method: "POST",
    body: JSON.stringify(validBody),
    headers: { "content-type": "application/json" },
  }));
  assert.equal(missingOriginPost.status, 403);
  const unauthorizedLatestGet = await getLatestJobRoute(
    new Request("http://local/api/settlement/jobs?month=2026-06-01"),
  );
  assert.equal(unauthorizedLatestGet.status, 401);
  const unauthorizedGet = await getJobRoute(
    new Request(`http://local/api/settlement/jobs/${jobId}`),
    { params: Promise.resolve({ id: jobId }) },
  );
  assert.equal(unauthorizedGet.status, 401);

  console.log("test-settlement-job-api: all assertions passed");
}

void main();
