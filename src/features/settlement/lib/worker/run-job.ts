import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";
import type postgres from "postgres";

import type {
  Database,
  SettlementJobFileRow,
  SettlementJobFileStatus,
  SettlementJobRow,
  SettlementJobStage,
  SettlementJobTerminalStatus,
} from "@/features/settlement/lib/supabase/types";
import type { PreparedUploadOutcome } from "./process-prepared-upload";

type Sql = postgres.Sql;

export const SETTLEMENT_WORKER_BUCKET = "upload-debug";
const MAX_METRIC = 1_000_000;

export type WorkerFilePatch = Partial<Pick<
  SettlementJobFileRow,
  | "status"
  | "parsed_rows"
  | "sales_records_written"
  | "sales_records_skipped_duplicates"
  | "result_summary"
  | "error_summary"
  | "started_at"
  | "completed_at"
>>;

export interface SettlementWorkerStore {
  listFiles(jobId: string): Promise<SettlementJobFileRow[]>;
  updateFile(input: {
    jobId: string;
    workerId: string;
    fileId: string;
    patch: WorkerFilePatch;
  }): Promise<boolean>;
  heartbeat(input: {
    jobId: string;
    workerId: string;
    leaseSeconds: number;
    stage: SettlementJobStage;
    progressCurrent: number;
    progressTotal: number;
  }): Promise<boolean>;
  release(jobId: string, workerId: string): Promise<boolean>;
  uploadArtifact(path: string, buffer: Buffer): Promise<void>;
  finish(input: {
    jobId: string;
    workerId: string;
    status: SettlementJobTerminalStatus;
    errorSummary: string | null;
    resultSummary: string | null;
    artifactStoragePath: string | null;
    workbookSheetCount: number | null;
    workbookRowCount: number | null;
  }): Promise<boolean>;
}

export interface SettlementJobRunnerDependencies {
  store: SettlementWorkerStore;
  processUpload(input: { uploadId: string; folderHint?: string }): Promise<PreparedUploadOutcome>;
  loadRecords(month: string): Promise<{
    records: Record<string, unknown>[];
    loadError: { error: string } | null;
    sourceWarnings?: readonly string[];
  }>;
  fillWorkbook(input: { month: string; records: Record<string, unknown>[] }): Promise<{
    buffer: Buffer;
    rows_written: number;
  }>;
  validateWorkbook(buffer: Buffer): Promise<{ sheetCount: number; rowCount: number }>;
  now?: () => string;
  shouldStop?: () => boolean;
  leaseHeartbeatIntervalMs?: number;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export type SettlementJobRunResult = {
  outcome: "completed" | "completed_with_warnings" | "failed" | "lease_lost" | "interrupted";
  filesProcessed: number;
  filesFailed: number;
};

function boundedMetric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.trunc(value), MAX_METRIC)
    : 0;
}

function readFileOutcome(outcome: PreparedUploadOutcome): {
  status: SettlementJobFileStatus;
  parsedRows: number;
  writtenRows: number;
  skippedDuplicates: number;
  resultSummary: string | null;
  errorSummary: string | null;
} {
  if ("error" in outcome.body) {
    return {
      status: "failed",
      parsedRows: 0,
      writtenRows: 0,
      skippedDuplicates: 0,
      resultSummary: null,
      errorSummary: "file processing failed",
    };
  }
  const result = outcome.body.results[0];
  if (!result || typeof result.error === "string") {
    return {
      status: "failed",
      parsedRows: boundedMetric(result?.parsed_rows),
      writtenRows: boundedMetric(result?.sales_records_written),
      skippedDuplicates: boundedMetric(result?.sales_records_skipped_duplicates ?? result?.skipped_duplicates),
      resultSummary: null,
      errorSummary: "file processing failed",
    };
  }
  const skipped = result.skipped === true;
  return {
    status: skipped ? "skipped" : "completed",
    parsedRows: boundedMetric(result.parsed_rows),
    writtenRows: boundedMetric(result.sales_records_written),
    skippedDuplicates: boundedMetric(result.sales_records_skipped_duplicates ?? result.skipped_duplicates),
    resultSummary: skipped ? "file skipped safely" : "file processed",
    errorSummary: null,
  };
}

export function buildSettlementJobArtifactPath(job: Pick<SettlementJobRow, "id" | "month">): string {
  const month = /^\d{4}-\d{2}/.exec(job.month)?.[0];
  if (!month || !/^[0-9a-f-]{36}$/i.test(job.id)) throw new Error("invalid artifact identity");
  return `job-artifacts/${month}/${job.id}.xlsx`;
}

export async function validateSettlementWorkbook(buffer: Buffer): Promise<{
  sheetCount: number;
  rowCount: number;
}> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheetCount = workbook.worksheets.length;
  const rowCount = workbook.worksheets.reduce((sum, sheet) => sum + sheet.actualRowCount, 0);
  if (sheetCount < 1 || sheetCount > 100 || rowCount < 1 || rowCount > MAX_METRIC) {
    throw new Error("workbook bounds invalid");
  }
  return { sheetCount, rowCount };
}

const MAX_XLSX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_XLSX_ENTRIES = 10_000;
const MAX_XLSX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

/**
 * Hashes XLSX entry names and uncompressed entry bytes, ignoring ZIP container
 * timestamps. Inputs are worker-generated private artifacts; strict bounds and
 * CRC checks prevent a malformed replay object from causing unbounded unzip.
 */
export async function xlsxArchiveDigest(buffer: Buffer): Promise<string> {
  if (buffer.byteLength < 1 || buffer.byteLength > MAX_XLSX_ARCHIVE_BYTES) {
    throw new Error("xlsx archive bounds invalid");
  }
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (entries.length < 1 || entries.length > MAX_XLSX_ENTRIES) {
    throw new Error("xlsx entry count invalid");
  }

  const digest = createHash("sha256");
  let uncompressedBytes = 0;
  for (const entry of entries) {
    const originalName = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName
      ?? entry.name;
    if (originalName.split("/").some((part) => part === "..")) {
      throw new Error("xlsx entry path invalid");
    }
    const bytes = await entry.async("nodebuffer");
    uncompressedBytes += bytes.byteLength;
    if (uncompressedBytes > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new Error("xlsx uncompressed bounds invalid");
    }
    digest.update(String(Buffer.byteLength(originalName, "utf8")));
    digest.update(":");
    digest.update(originalName, "utf8");
    digest.update(":");
    digest.update(String(bytes.byteLength));
    digest.update(":");
    digest.update(bytes);
  }
  return digest.digest("hex");
}

export async function runSettlementJob(
  job: SettlementJobRow,
  workerId: string,
  leaseSeconds: number,
  deps: SettlementJobRunnerDependencies,
): Promise<SettlementJobRunResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const shouldStop = deps.shouldStop ?? (() => false);
  const logger = deps.logger ?? console;
  let processed = 0;
  let failed = 0;

  // Migration 030 keeps version jobs out of the legacy claim RPC. Fail closed
  // even if a caller bypasses that RPC: do not heartbeat, mutate files,
  // generate a workbook, upload an artifact, or invoke the legacy finish RPC.
  if (job.source_version_id !== null) {
    logger.error(`[settlement-worker] job=${job.id} unsupported source contract`);
    return { outcome: "failed", filesProcessed: 0, filesFailed: 0 };
  }

  const heartbeat = (stage: SettlementJobStage, current: number) => deps.store.heartbeat({
    jobId: job.id,
    workerId,
    leaseSeconds,
    stage,
    progressCurrent: current,
    progressTotal: job.progress_total,
  });

  const leaseLost = (): SettlementJobRunResult => ({
    outcome: "lease_lost",
    filesProcessed: processed,
    filesFailed: failed,
  });

  const heartbeatSafely = async (stage: SettlementJobStage, current: number): Promise<boolean> => {
    try {
      return await heartbeat(stage, current);
    } catch {
      return false;
    }
  };

  const interruptAtCheckpoint = async (): Promise<SettlementJobRunResult | null> => {
    if (!shouldStop()) return null;
    let released = false;
    try {
      released = await deps.store.release(job.id, workerId);
    } catch {
      released = false;
    }
    if (released) {
      logger.log(`[settlement-worker] job=${job.id} released at safe checkpoint`);
      return { outcome: "interrupted", filesProcessed: processed, filesFailed: failed };
    }
    return leaseLost();
  };

  if (!await heartbeatSafely("parsing", job.progress_current)) {
    return leaseLost();
  }

  let files: SettlementJobFileRow[];
  try {
    files = await deps.store.listFiles(job.id);
  } catch {
    return finishFailed("job files unavailable");
  }
  files.sort((a, b) => a.position - b.position);
  if (files.length !== job.progress_total) return finishFailed("job file count mismatch");
  if (!files.every((file): file is SettlementJobFileRow & {
    upload_id: string;
    source_version_file_id: null;
  } => file.upload_id !== null && file.source_version_file_id === null)) {
    logger.error(`[settlement-worker] job=${job.id} unsupported file source contract`);
    return { outcome: "failed", filesProcessed: 0, filesFailed: 0 };
  }
  // A reclaimed lease may find the prior worker stopped inside a file. The
  // underlying upload pipeline is not transactional, so replaying that file
  // could duplicate raw evidence or race a still-finishing worker. Fail closed
  // and require review; only checkpoints between files are resumable.
  if (files.some((file) => file.status === "processing")) {
    return finishFailed("interrupted file requires review");
  }

  const leaseHeartbeatIntervalMs = deps.leaseHeartbeatIntervalMs
    ?? Math.max(10_000, Math.min(60_000, Math.floor((leaseSeconds * 1_000) / 3)));
  if (!Number.isFinite(leaseHeartbeatIntervalMs) || leaseHeartbeatIntervalMs < 1) {
    return finishFailed("invalid lease heartbeat interval");
  }

  const runLeasedStage = async <T>(
    stage: SettlementJobStage,
    operation: () => Promise<T>,
  ): Promise<
    | { ok: true; value: T }
    | { ok: false; reason: "operation_failed" | "lease_lost" }
  > => {
    if (!await heartbeatSafely(stage, processed)) return { ok: false, reason: "lease_lost" };

    let leaseLostDuringStage = false;
    let value: T | undefined;
    let operationFailed = false;
    const inFlightLeaseRenewals = new Set<Promise<void>>();
    const renewLease = setInterval(() => {
      const renewal = heartbeatSafely(stage, processed)
        .then((ok) => { if (!ok) leaseLostDuringStage = true; })
        .finally(() => { inFlightLeaseRenewals.delete(renewal); });
      inFlightLeaseRenewals.add(renewal);
    }, leaseHeartbeatIntervalMs);
    try {
      value = await operation();
    } catch {
      operationFailed = true;
    } finally {
      clearInterval(renewLease);
      await Promise.allSettled([...inFlightLeaseRenewals]);
    }

    if (leaseLostDuringStage || !await heartbeatSafely(stage, processed)) {
      return { ok: false, reason: "lease_lost" };
    }
    if (operationFailed) return { ok: false, reason: "operation_failed" };
    return { ok: true, value: value as T };
  };

  const initialInterruption = await interruptAtCheckpoint();
  if (initialInterruption) return initialInterruption;

  for (const file of files) {
    if (["completed", "skipped", "failed"].includes(file.status)) {
      processed += 1;
      if (file.status === "failed") failed += 1;
      continue;
    }
    const preFileInterruption = await interruptAtCheckpoint();
    if (preFileInterruption) return preFileInterruption;
    if (!await heartbeatSafely("parsing", processed)) {
      return leaseLost();
    }
    if (!await deps.store.updateFile({
      jobId: job.id,
      workerId,
      fileId: file.id,
      patch: {
        status: "processing",
        result_summary: null,
        error_summary: null,
        started_at: file.started_at ?? now(),
        completed_at: null,
      },
    })) return leaseLost();

    let safeResult: ReturnType<typeof readFileOutcome>;
    let leaseLostDuringProcessing = false;
    const inFlightLeaseRenewals = new Set<Promise<void>>();
    const renewLease = setInterval(() => {
      const renewal = heartbeatSafely("parsing", processed)
        .then((ok) => { if (!ok) leaseLostDuringProcessing = true; })
        .finally(() => { inFlightLeaseRenewals.delete(renewal); });
      inFlightLeaseRenewals.add(renewal);
    }, leaseHeartbeatIntervalMs);
    try {
      const outcome = await deps.processUpload({
        uploadId: file.upload_id,
        ...(file.folder_hint ? { folderHint: file.folder_hint } : {}),
      });
      safeResult = readFileOutcome(outcome);
    } catch {
      safeResult = readFileOutcome({ status: 500, body: { error: "withheld" } });
    } finally {
      clearInterval(renewLease);
      await Promise.allSettled([...inFlightLeaseRenewals]);
    }

    if (leaseLostDuringProcessing || !await heartbeatSafely("parsing", processed)) {
      return leaseLost();
    }
    if (!await deps.store.updateFile({
      jobId: job.id,
      workerId,
      fileId: file.id,
      patch: {
        status: safeResult.status,
        parsed_rows: safeResult.parsedRows,
        sales_records_written: safeResult.writtenRows,
        sales_records_skipped_duplicates: safeResult.skippedDuplicates,
        result_summary: safeResult.resultSummary,
        error_summary: safeResult.errorSummary,
        completed_at: now(),
      },
    })) return leaseLost();
    processed += 1;
    if (safeResult.status === "failed") failed += 1;
    if (!await heartbeatSafely("parsing", processed)) {
      return leaseLost();
    }
    const fileInterruption = await interruptAtCheckpoint();
    if (fileInterruption) return fileInterruption;
  }

  const month = job.month.slice(0, 7).replace("-", "");
  let sourceWarningCount = 0;
  const loaded = await runLeasedStage("workbook_generation", () => deps.loadRecords(month));
  if (!loaded.ok) {
    if (loaded.reason === "lease_lost") return leaseLost();
    return finishFailed("workbook generation failed");
  }
  const loadInterruption = await interruptAtCheckpoint();
  if (loadInterruption) return loadInterruption;
  if (loaded.value.loadError || loaded.value.records.length === 0) {
    return finishFailed("workbook records unavailable");
  }
  sourceWarningCount = loaded.value.sourceWarnings?.length ?? 0;

  const filled = await runLeasedStage(
    "workbook_generation",
    () => deps.fillWorkbook({ month, records: loaded.value.records }),
  );
  if (!filled.ok) {
    if (filled.reason === "lease_lost") return leaseLost();
    return finishFailed("workbook generation failed");
  }
  const fillInterruption = await interruptAtCheckpoint();
  if (fillInterruption) return fillInterruption;
  if (filled.value.rows_written < 1 || filled.value.rows_written > MAX_METRIC) {
    return finishFailed("workbook row count invalid");
  }
  const workbookBuffer = filled.value.buffer;

  const validated = await runLeasedStage(
    "workbook_validation",
    () => deps.validateWorkbook(workbookBuffer),
  );
  if (!validated.ok) {
    if (validated.reason === "lease_lost") return leaseLost();
    return finishFailed("workbook validation failed");
  }
  const validationInterruption = await interruptAtCheckpoint();
  if (validationInterruption) return validationInterruption;
  const workbookMetrics = validated.value;

  const artifactPath = buildSettlementJobArtifactPath(job);
  const uploaded = await runLeasedStage(
    "workbook_validation",
    () => deps.store.uploadArtifact(artifactPath, workbookBuffer),
  );
  if (!uploaded.ok) {
    if (uploaded.reason === "lease_lost") return leaseLost();
    return finishFailed("workbook artifact storage failed");
  }
  const uploadInterruption = await interruptAtCheckpoint();
  if (uploadInterruption) return uploadInterruption;

  const warningCount = failed + sourceWarningCount;
  const status: SettlementJobTerminalStatus = warningCount > 0
    ? "completed_with_warnings"
    : "completed";
  const finished = await deps.store.finish({
    jobId: job.id,
    workerId,
    status,
    errorSummary: failed > 0 ? `${failed} file(s) failed` : null,
    resultSummary: `${processed} file(s) processed; ${warningCount} warning(s)`,
    artifactStoragePath: artifactPath,
    workbookSheetCount: workbookMetrics.sheetCount,
    workbookRowCount: workbookMetrics.rowCount,
  });
  return {
    outcome: finished ? status : "lease_lost",
    filesProcessed: processed,
    filesFailed: failed,
  };

  async function finishFailed(errorSummary: string): Promise<SettlementJobRunResult> {
    logger.error(`[settlement-worker] job=${job.id} failed category=${errorSummary.replace(/\s+/g, "_")}`);
    const finished = await deps.store.finish({
      jobId: job.id,
      workerId,
      status: "failed",
      errorSummary: errorSummary.slice(0, 500),
      resultSummary: `${processed} file(s) reached a safe checkpoint`,
      artifactStoragePath: null,
      workbookSheetCount: null,
      workbookRowCount: null,
    });
    return {
      outcome: finished ? "failed" : "lease_lost",
      filesProcessed: processed,
      filesFailed: failed,
    };
  }
}

export function createPostgresSettlementWorkerStore(
  sql: Sql,
  storageClient: SupabaseClient<Database>,
): SettlementWorkerStore {
  return {
    async listFiles(jobId) {
      return sql<SettlementJobFileRow[]>`
        select
          id, job_id, upload_id, source_version_file_id, position, folder_hint, status,
          parsed_rows, sales_records_written, sales_records_skipped_duplicates,
          result_summary, error_summary, created_at, updated_at, started_at, completed_at
        from settlement_job_files
        where job_id = ${jobId}::uuid
        order by position
      `;
    },
    async updateFile(input) {
      const patch = input.patch;
      const rows = await sql<{ id: string }[]>`
        with owned_job as (
          select id
          from settlement_jobs
          where id = ${input.jobId}::uuid
            and worker_id = ${input.workerId}::text
            and status in ('claimed', 'processing')
            and lease_expires_at >= clock_timestamp()
          for update
        )
        update settlement_job_files as file
        set
          status = case when ${patch.status !== undefined} then ${patch.status ?? null} else status end,
          parsed_rows = case when ${patch.parsed_rows !== undefined} then ${patch.parsed_rows ?? null} else parsed_rows end,
          sales_records_written = case when ${patch.sales_records_written !== undefined} then ${patch.sales_records_written ?? null} else sales_records_written end,
          sales_records_skipped_duplicates = case when ${patch.sales_records_skipped_duplicates !== undefined} then ${patch.sales_records_skipped_duplicates ?? null} else sales_records_skipped_duplicates end,
          result_summary = case when ${patch.result_summary !== undefined} then ${patch.result_summary ?? null} else result_summary end,
          error_summary = case when ${patch.error_summary !== undefined} then ${patch.error_summary ?? null} else error_summary end,
          started_at = case when ${patch.started_at !== undefined} then ${patch.started_at ?? null} else started_at end,
          completed_at = case when ${patch.completed_at !== undefined} then ${patch.completed_at ?? null} else completed_at end,
          updated_at = clock_timestamp()
        from owned_job
        where file.id = ${input.fileId}::uuid
          and file.job_id = ${input.jobId}::uuid
          and file.job_id = owned_job.id
        returning file.id
      `;
      return rows.length === 1;
    },
    async heartbeat(input) {
      const [row] = await sql<{ ok: boolean }[]>`
        select heartbeat_settlement_job(
          ${input.jobId}::uuid,
          ${input.workerId}::text,
          ${input.leaseSeconds}::integer,
          ${input.stage}::text,
          ${input.progressCurrent}::integer,
          ${input.progressTotal}::integer
        ) as ok
      `;
      return row?.ok === true;
    },
    async release(jobId, currentWorkerId) {
      const [row] = await sql<{ ok: boolean }[]>`
        select release_settlement_job(
          ${jobId}::uuid,
          ${currentWorkerId}::text
        ) as ok
      `;
      return row?.ok === true;
    },
    async uploadArtifact(path, buffer) {
      const bucket = storageClient.storage.from(SETTLEMENT_WORKER_BUCKET);
      const { error } = await bucket.upload(path, buffer, {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        upsert: false,
      });
      if (!error) return;

      const storageError = error as unknown as { message?: string; statusCode?: string | number };
      const duplicate = String(storageError.statusCode ?? "") === "409"
        || /already exists|duplicate|resource exists/i.test(storageError.message ?? "");
      if (!duplicate) throw new Error("artifact upload failed");

      // A prior attempt can upload the deterministic artifact and then lose
      // its DB lease before finish(). Anon Storage intentionally has no UPDATE
      // or DELETE policy, so accept the existing object only when its content
      // hash is exactly the same as the newly generated workbook.
      const { data, error: downloadError } = await bucket.download(path);
      if (downloadError || !data) throw new Error("artifact replay verification failed");
      const existing = Buffer.from(await data.arrayBuffer());
      const [existingDigest, currentDigest] = await Promise.all([
        xlsxArchiveDigest(existing),
        xlsxArchiveDigest(buffer),
      ]);
      if (existingDigest !== currentDigest) {
        throw new Error("artifact replay mismatch");
      }
    },
    async finish(input) {
      const [row] = await sql<{ ok: boolean }[]>`
        select finish_settlement_job(
          ${input.jobId}::uuid,
          ${input.workerId}::text,
          ${input.status}::text,
          ${input.errorSummary}::text,
          ${input.resultSummary}::text,
          ${input.artifactStoragePath}::text,
          ${input.workbookSheetCount}::integer,
          ${input.workbookRowCount}::integer
        ) as ok
      `;
      return row?.ok === true;
    },
  };
}

export async function claimSettlementJob(
  sql: Sql,
  workerId: string,
  leaseSeconds: number,
): Promise<SettlementJobRow | null> {
  const rows = await sql<Array<Omit<SettlementJobRow, "month"> & { month: string | Date }>>`
    select *
    from claim_settlement_job(${workerId}::text, ${leaseSeconds}::integer)
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  const month = row.month instanceof Date
    ? row.month.toISOString().slice(0, 10)
    : String(row.month).slice(0, 10);
  return { ...row, month } as SettlementJobRow;
}
