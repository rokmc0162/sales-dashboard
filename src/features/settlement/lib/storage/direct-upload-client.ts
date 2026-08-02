import { createClient } from "@/features/settlement/lib/supabase/client";
import { SETTLEMENT_HEARTBEAT_HEADER } from "./heartbeat-stream";

type PrepareResponse = {
  upload_id: string;
  path: string;
  token: string;
};

type UploadResponse = {
  results: Array<Record<string, unknown>>;
};

export type SettlementJobFileStatus = {
  position: number;
  filename: string;
  status: "queued" | "processing" | "completed" | "skipped" | "failed";
  parsed_rows: number | null;
  sales_records_written: number | null;
  sales_records_skipped_duplicates: number | null;
  result_summary: string | null;
  error_summary: string | null;
};

export type SettlementJobStatus = {
  id: string;
  month: string;
  status: "queued" | "claimed" | "processing" | "completed" | "completed_with_warnings" | "failed";
  stage: "queued" | "parsing" | "workbook_generation" | "workbook_validation" | "completed";
  progress: { current: number; total: number };
  terminal: boolean;
  result_summary: string | null;
  error_summary: string | null;
  workbook: { sheet_count: number | null; row_count: number | null };
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  files: SettlementJobFileStatus[];
};

export type SettlementJobEnqueueFile = {
  upload_id: string;
  position: number;
  folder_hint?: string;
};

export const MAX_SETTLEMENT_JOB_FILES = 200;

export function exceedsSettlementJobFileLimit(fileCount: number): boolean {
  return fileCount > MAX_SETTLEMENT_JOB_FILES;
}

const DEFAULT_JOB_POLL_INTERVAL_MS = 2_000;
const DEFAULT_JOB_POLL_TIMEOUT_MS = 2 * 60 * 60 * 1_000;

async function readJsonOrThrow<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : `request failed: ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

// Heartbeat-streamed process responses always arrive with status 200, so
// failures surface only in the body: a top-level `error`, or a payload
// without a `results` array (e.g. a truncated/garbled stream).
export function assertUploadResponsePayload(payload: unknown): UploadResponse {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    throw new Error(String((payload as { error: unknown }).error));
  }
  const results =
    typeof payload === "object" && payload !== null
      ? (payload as { results?: unknown }).results
      : undefined;
  if (!Array.isArray(results)) {
    throw new Error("upload response missing results");
  }
  return { results: results as Array<Record<string, unknown>> };
}

// Parent directory of a selection-relative path (slash or backslash
// separated), without the filename. File-only selections have no directory
// part and yield undefined. Parsers key off the parent folder basename
// (e.g. ichijinsha deposit dates), so each file must carry its own.
export function parentFolderHint(relativePath: string | undefined): string | undefined {
  if (!relativePath) return undefined;
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  if (segments.length < 2) return undefined;
  return segments.slice(0, -1).join("/");
}

function cleanFolderHint(folderHint: string | undefined): string | undefined {
  if (!folderHint) return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = folderHint.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200);
  return cleaned || undefined;
}

export function buildCleanupPreparedUploadRequest(uploadId: string): RequestInit {
  return {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ upload_id: uploadId }),
  };
}

async function cleanupPreparedUpload(uploadId: string): Promise<void> {
  await fetch("/api/settlement/uploads/prepare", buildCleanupPreparedUploadRequest(uploadId)).catch(() => undefined);
}

/** Transfers bytes to private Storage and returns only the opaque upload id. */
export async function uploadSettlementFileToStorage(
  file: File,
  activeMonth: string,
): Promise<{ upload_id: string }> {
  const prepared = await fetch("/api/settlement/uploads/prepare", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      size_bytes: file.size,
      content_type: file.type || null,
      active_month: activeMonth,
    }),
  }).then((response) => readJsonOrThrow<PrepareResponse>(response));

  const supabase = createClient();
  const { error: uploadError } = await supabase.storage
    .from("upload-debug")
    .uploadToSignedUrl(prepared.path, prepared.token, file, {
      contentType: file.type || "application/octet-stream",
    });
  if (uploadError) {
    await cleanupPreparedUpload(prepared.upload_id);
    throw new Error("storage transfer failed");
  }

  return { upload_id: prepared.upload_id };
}

export async function enqueueSettlementJob(
  month: string,
  files: SettlementJobEnqueueFile[],
): Promise<{ job_id: string }> {
  return fetch("/api/settlement/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      month,
      files: files.map((file) => ({
        ...file,
        folder_hint: cleanFolderHint(file.folder_hint),
      })),
    }),
  }).then((response) => readJsonOrThrow<{ job_id: string }>(response));
}

export function fetchSettlementJobStatus(
  jobId: string,
  signal?: AbortSignal,
): Promise<SettlementJobStatus> {
  return fetch(`/api/settlement/jobs/${encodeURIComponent(jobId)}`, {
    signal,
    cache: "no-store",
  }).then((response) => readJsonOrThrow<SettlementJobStatus>(response));
}

export function fetchLatestSettlementJob(
  month: string,
  signal?: AbortSignal,
): Promise<SettlementJobStatus | null> {
  return fetch(`/api/settlement/jobs?month=${encodeURIComponent(month)}`, {
    signal,
    cache: "no-store",
  }).then((response) => readJsonOrThrow<SettlementJobStatus | null>(response));
}

function abortError(): Error {
  const error = new Error("job polling aborted");
  error.name = "AbortError";
  return error;
}

function waitForNextPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollSettlementJob(
  jobId: string,
  options: {
    signal?: AbortSignal;
    intervalMs?: number;
    timeoutMs?: number;
    onUpdate?: (job: SettlementJobStatus) => void;
  } = {},
): Promise<SettlementJobStatus> {
  const intervalMs = options.intervalMs ?? DEFAULT_JOB_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_JOB_POLL_TIMEOUT_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 250) throw new Error("invalid polling interval");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) throw new Error("invalid polling timeout");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw abortError();
    const job = await fetchSettlementJobStatus(jobId, options.signal);
    options.onUpdate?.(job);
    if (job.terminal) return job;
    const remaining = deadline - Date.now();
    if (remaining > 0) await waitForNextPoll(Math.min(intervalMs, remaining), options.signal);
  }
  throw new Error("job polling timed out");
}

export async function uploadSettlementFileDirect(
  file: File,
  activeMonth: string,
  folderHint?: string,
): Promise<UploadResponse> {
  const prepared = await uploadSettlementFileToStorage(file, activeMonth);

  return fetch("/api/settlement/upload", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Opt in to heartbeat streaming so long OCR parses keep emitting bytes
      // instead of hitting the ~5-6 minute idle-connection reset.
      [SETTLEMENT_HEARTBEAT_HEADER]: "1",
    },
    body: JSON.stringify({
      upload_id: prepared.upload_id,
      folder_hint: cleanFolderHint(folderHint),
    }),
  })
    .then((response) => readJsonOrThrow<unknown>(response))
    .then((payload) => assertUploadResponsePayload(payload));
}
