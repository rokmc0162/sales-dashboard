import postgres from "postgres";

import type {
  SettlementJobFileRow,
  SettlementJobRow,
} from "@/features/settlement/lib/supabase/types";

type Sql = postgres.Sql;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const STORAGE_PATH_RE = /^uploads\/\d{4}-\d{2}\/[A-Za-z0-9._-]{1,255}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

let jobApiSqlSingleton: Sql | null = null;

function getSettlementJobApiSql(): Sql {
  const url = process.env.SUPABASE_DATABASE_URL;
  if (!url) {
    throw new Error("SUPABASE_DATABASE_URL is required for settlement job API store");
  }
  if (!jobApiSqlSingleton) {
    jobApiSqlSingleton = postgres(url, {
      max: 1,
      prepare: false,
      ssl: "require",
    });
  }
  return jobApiSqlSingleton;
}

export const SETTLEMENT_JOB_TERMINAL_STATUSES = [
  "completed",
  "completed_with_warnings",
  "failed",
] as const;

export type SettlementJobTerminalStatus = typeof SETTLEMENT_JOB_TERMINAL_STATUSES[number];

export type SettlementJobFileInput = {
  upload_id: string;
  position: number;
  folder_hint?: string;
};

export type CreateSettlementJobInput = {
  month: string;
  files: SettlementJobFileInput[];
};

export type JobUploadSource = {
  id: string;
  filename: string;
  storage_path: string;
  settlement_month: string | null;
  status: string;
};

export type JobFileWithFilename = SettlementJobFileRow & {
  filename: string;
};

export interface SettlementJobApiStore {
  loadUploads(uploadIds: readonly string[]): Promise<JobUploadSource[]>;
  enqueue(input: CreateSettlementJobInput): Promise<string>;
  getJob(jobId: string): Promise<SettlementJobRow | null>;
  getLatestJobForMonth(month: string): Promise<SettlementJobRow | null>;
  getJobFiles(jobId: string): Promise<JobFileWithFilename[]>;
}

export type CreateJobResult =
  | { ok: true; job_id: string }
  | { ok: false; status: 400 | 409 | 500; error: string };

export type GetJobResult =
  | { ok: true; value: ReturnType<typeof projectSettlementJob> }
  | { ok: false; status: 400 | 404 | 500; error: string };

export type GetLatestJobResult =
  | { ok: true; value: ReturnType<typeof projectSettlementJob> | null }
  | { ok: false; status: 400 | 500; error: string };

export function validateCreateSettlementJobInput(input: unknown):
  | { ok: true; value: CreateSettlementJobInput }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "invalid JSON body" };
  }
  const body = input as Record<string, unknown>;
  const month = typeof body.month === "string" ? body.month.trim() : "";
  if (!MONTH_RE.test(month)) return { ok: false, error: "month must be YYYY-MM-01" };
  if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 200) {
    return { ok: false, error: "files must contain 1 to 200 entries" };
  }

  const files: SettlementJobFileInput[] = [];
  const uploadIds = new Set<string>();
  const positions = new Set<number>();
  for (const item of body.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: "invalid job file" };
    }
    const row = item as Record<string, unknown>;
    const uploadId = typeof row.upload_id === "string" ? row.upload_id.trim() : "";
    if (!UUID_RE.test(uploadId)) return { ok: false, error: "invalid upload_id" };
    if (!Number.isInteger(row.position) || (row.position as number) < 0 || (row.position as number) >= body.files.length) {
      return { ok: false, error: "invalid file position" };
    }
    if (uploadIds.has(uploadId)) return { ok: false, error: "duplicate upload_id" };
    if (positions.has(row.position as number)) return { ok: false, error: "duplicate file position" };

    let folderHint: string | undefined;
    if (row.folder_hint !== undefined && row.folder_hint !== null && row.folder_hint !== "") {
      if (typeof row.folder_hint !== "string") return { ok: false, error: "invalid folder_hint" };
      folderHint = row.folder_hint.trim();
      if (folderHint.length > 200 || CONTROL_RE.test(folderHint)) {
        return { ok: false, error: "invalid folder_hint" };
      }
      if (!folderHint) folderHint = undefined;
    }
    uploadIds.add(uploadId);
    positions.add(row.position as number);
    files.push({ upload_id: uploadId, position: row.position as number, ...(folderHint ? { folder_hint: folderHint } : {}) });
  }

  for (let position = 0; position < files.length; position += 1) {
    if (!positions.has(position)) return { ok: false, error: "file positions must be contiguous" };
  }
  files.sort((a, b) => a.position - b.position);
  return { ok: true, value: { month, files } };
}

export function validateJobUploadSources(
  input: CreateSettlementJobInput,
  uploads: readonly JobUploadSource[],
): { ok: true } | { ok: false; error: string } {
  if (uploads.length !== input.files.length) return { ok: false, error: "upload not ready for selected month" };
  const byId = new Map(uploads.map((upload) => [upload.id, upload]));
  for (const file of input.files) {
    const upload = byId.get(file.upload_id);
    if (
      !upload ||
      upload.status !== "uploaded" ||
      upload.settlement_month !== input.month ||
      !STORAGE_PATH_RE.test(upload.storage_path) ||
      /(^|\/)\.\.($|\/)/.test(upload.storage_path)
    ) {
      return { ok: false, error: "upload not ready for selected month" };
    }
  }
  return { ok: true };
}

export async function createSettlementJob(
  store: SettlementJobApiStore,
  input: unknown,
): Promise<CreateJobResult> {
  const validated = validateCreateSettlementJobInput(input);
  if (!validated.ok) return { ok: false, status: 400, error: validated.error };
  try {
    const uploads = await store.loadUploads(validated.value.files.map((file) => file.upload_id));
    const sources = validateJobUploadSources(validated.value, uploads);
    if (!sources.ok) return { ok: false, status: 409, error: sources.error };
    const jobId = await store.enqueue(validated.value);
    return { ok: true, job_id: jobId };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/already assigned|not ready|unique/i.test(message)) {
      return { ok: false, status: 409, error: "one or more uploads cannot be assigned" };
    }
    return { ok: false, status: 500, error: "job enqueue failed" };
  }
}

export async function getSettlementJob(
  store: SettlementJobApiStore,
  jobId: string,
): Promise<GetJobResult> {
  if (!UUID_RE.test(jobId)) return { ok: false, status: 400, error: "invalid job id" };
  try {
    const job = await store.getJob(jobId);
    if (!job) return { ok: false, status: 404, error: "job not found" };
    const files = await store.getJobFiles(jobId);
    return { ok: true, value: projectSettlementJob(job, files) };
  } catch {
    return { ok: false, status: 500, error: "job status unavailable" };
  }
}

export async function getLatestSettlementJob(
  store: SettlementJobApiStore,
  month: string,
): Promise<GetLatestJobResult> {
  if (!MONTH_RE.test(month)) return { ok: false, status: 400, error: "month must be YYYY-MM-01" };
  try {
    const job = await store.getLatestJobForMonth(month);
    if (!job) return { ok: true, value: null };
    const files = await store.getJobFiles(job.id);
    return { ok: true, value: projectSettlementJob(job, files) };
  } catch {
    return { ok: false, status: 500, error: "job status unavailable" };
  }
}

function boundedText(value: string | null, maxLength = 500): string | null {
  if (!value) return null;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!clean) return null;
  if (
    /(?:service[_ -]?role|authorization|bearer|token|secret|storage[_ -]?path|raw[_ -]?record|title|amount|jpy|krw|usd|[A-Za-z]:\\|\/(?:Users|Volumes|private|tmp)\/)/i.test(clean)
  ) {
    return "details withheld";
  }
  return clean.slice(0, maxLength);
}

function boundedMetric(value: number | null, max: number): number | null {
  return Number.isInteger(value) && (value as number) >= 0
    ? Math.min(value as number, max)
    : null;
}

function safeFilename(value: string): string {
  const leaf = value.split(/[\\/]/).pop() ?? "file";
  return boundedText(leaf, 255) ?? "file";
}

export function isTerminalSettlementJobStatus(status: string): status is SettlementJobTerminalStatus {
  return (SETTLEMENT_JOB_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Explicit safe projection: paths, tokens, worker identity, versions, and raw records are omitted. */
export function projectSettlementJob(job: SettlementJobRow, files: readonly JobFileWithFilename[]) {
  return {
    id: job.id,
    month: job.month,
    status: job.status,
    stage: job.stage,
    progress: {
      current: boundedMetric(job.progress_current, 200) ?? 0,
      total: boundedMetric(job.progress_total, 200) ?? 0,
    },
    terminal: isTerminalSettlementJobStatus(job.status),
    result_summary: boundedText(job.result_summary),
    error_summary: boundedText(job.error_summary),
    workbook: {
      sheet_count: boundedMetric(job.workbook_sheet_count, 100),
      row_count: boundedMetric(job.workbook_row_count, 1_000_000),
    },
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
    files: [...files]
      .sort((a, b) => a.position - b.position)
      .map((file) => ({
        position: file.position,
        filename: safeFilename(file.filename),
        status: file.status,
        parsed_rows: boundedMetric(file.parsed_rows, 1_000_000),
        sales_records_written: boundedMetric(file.sales_records_written, 1_000_000),
        sales_records_skipped_duplicates: boundedMetric(file.sales_records_skipped_duplicates, 1_000_000),
        result_summary: boundedText(file.result_summary),
        error_summary: boundedText(file.error_summary),
      })),
  };
}

export function createPostgresSettlementJobApiStore(
  sql: Sql = getSettlementJobApiSql(),
): SettlementJobApiStore {
  return {
    async loadUploads(uploadIds) {
      return sql<JobUploadSource[]>`
        select id, filename, storage_path, settlement_month, status
        from raw_uploads
        where id = any(${[...uploadIds]}::uuid[])
      `;
    },
    async enqueue(input) {
      const [row] = await sql<{ job_id: string }[]>`
        select enqueue_settlement_job(
          ${input.month}::date,
          ${JSON.stringify(input.files)}::jsonb,
          ${null}::text,
          ${null}::text
        ) as job_id
      `;
      if (typeof row?.job_id !== "string") throw new Error("enqueue failed");
      return row.job_id;
    },
    async getJob(jobId) {
      const rows = await sql<SettlementJobRow[]>`
        select
          id, month, status, stage, progress_current, progress_total,
          result_summary, error_summary, workbook_sheet_count, workbook_row_count,
          created_at, updated_at, completed_at
        from settlement_jobs
        where id = ${jobId}::uuid
        limit 1
      `;
      return rows[0] ?? null;
    },
    async getLatestJobForMonth(month) {
      const rows = await sql<SettlementJobRow[]>`
        select
          id, month, status, stage, progress_current, progress_total,
          result_summary, error_summary, workbook_sheet_count, workbook_row_count,
          created_at, updated_at, completed_at
        from settlement_jobs
        where month = ${month}::date
        order by
          case when status in ('queued', 'claimed', 'processing') then 0 else 1 end,
          created_at desc
        limit 1
      `;
      return rows[0] ?? null;
    },
    async getJobFiles(jobId) {
      return sql<JobFileWithFilename[]>`
        select
          f.id, f.job_id, f.upload_id, f.position, f.folder_hint, f.status,
          f.parsed_rows, f.sales_records_written, f.sales_records_skipped_duplicates,
          f.result_summary, f.error_summary, f.created_at, f.updated_at,
          f.started_at, f.completed_at, u.filename
        from settlement_job_files f
        join raw_uploads u on u.id = f.upload_id
        where f.job_id = ${jobId}::uuid
        order by f.position
      `;
    },
  };
}
