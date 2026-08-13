// Browser client for the versioned settlement intake workspace. Talks only to
// the /api/settlement/intakes routes plus the signed-upload capability those
// routes hand out — never to the legacy /api/settlement/upload pipeline and
// never with any privileged key.

import { createClient } from "@/features/settlement/lib/supabase/client";
import {
  INTAKE_BUCKET,
  INTAKE_ERROR,
  type IntakeWorkspace,
} from "./contract";

export class IntakeApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly payload: Record<string, unknown>;

  constructor(code: string, status: number, payload: Record<string, unknown>) {
    super(code);
    this.name = "IntakeApiError";
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

async function readIntakeJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
    throw new IntakeApiError(code, response.status, body);
  }
  return body as T;
}

export function fetchIntakeWorkspace(
  month: string,
  signal?: AbortSignal,
): Promise<IntakeWorkspace> {
  return fetch(`/api/settlement/intakes?month=${encodeURIComponent(month)}`, {
    signal,
    cache: "no-store",
  }).then((response) => readIntakeJson<IntakeWorkspace>(response));
}

/** Creates the shared month workspace if needed and returns it. */
export function ensureIntakeWorkspace(month: string): Promise<IntakeWorkspace> {
  return fetch("/api/settlement/intakes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ month }),
  }).then((response) => readIntakeJson<IntakeWorkspace>(response));
}

export async function sha256HexOfFile(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type PreparedIntakeUpload = {
  object_id: string;
  bucket: string;
  path: string;
  token: string;
  path_key: string;
  display_path: string;
};

export type IntakeUploadResult = {
  object_id: string;
  draft_revision: number;
};

/** Registers the source object and returns the signed-upload capability. */
export function prepareIntakeUpload(options: {
  intakeId: string;
  file: File;
  relativePath: string;
  replace: boolean;
  expectedDraftRevision: number;
  sha256: string;
}): Promise<PreparedIntakeUpload> {
  return fetch(
    `/api/settlement/intakes/${encodeURIComponent(options.intakeId)}/files/prepare`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        relative_path: options.relativePath,
        content_type: options.file.type || null,
        size_bytes: options.file.size,
        sha256: options.sha256,
        replace: options.replace,
        expected_draft_revision: options.expectedDraftRevision,
      }),
    },
  ).then((response) => readIntakeJson<PreparedIntakeUpload>(response));
}

/** Transfers the file bytes with the signed-upload token. */
export async function uploadIntakeBytes(
  prepared: PreparedIntakeUpload,
  file: File,
): Promise<void> {
  const supabase = createClient();
  const { error: uploadError } = await supabase.storage
    .from(INTAKE_BUCKET)
    .uploadToSignedUrl(prepared.path, prepared.token, file, {
      contentType: file.type || "application/octet-stream",
    });
  if (uploadError) {
    throw new IntakeApiError("storage_transfer_failed", 0, {
      object_id: prepared.object_id,
    });
  }
}

/** Asks the server to verify, finalize, and place the uploaded object. */
export function completeIntakeUpload(
  intakeId: string,
  objectId: string,
  expectedDraftRevision: number,
): Promise<{ draft_revision: number }> {
  return fetch(
    `/api/settlement/intakes/${encodeURIComponent(intakeId)}/files/complete`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object_id: objectId,
        expected_draft_revision: expectedDraftRevision,
      }),
    },
  ).then((response) => readIntakeJson<{ draft_revision: number }>(response));
}

/**
 * Full upload of one draft file: hash locally, register (prepare), transfer
 * bytes with the returned signed-upload token, then ask the server to verify
 * and finalize (complete). Prepare and the byte transfer run exactly once;
 * if complete hits a 409 stale_draft_revision, complete alone is retried
 * exactly once with the same object_id and the server-reported revision,
 * after which the error surfaces to the caller.
 */
export async function uploadIntakeFile(options: {
  intakeId: string;
  file: File;
  relativePath: string;
  expectedDraftRevision: number;
  replace?: boolean;
}): Promise<IntakeUploadResult> {
  const sha256 = await sha256HexOfFile(options.file);
  const prepared = await prepareIntakeUpload({
    intakeId: options.intakeId,
    file: options.file,
    relativePath: options.relativePath,
    replace: options.replace === true,
    expectedDraftRevision: options.expectedDraftRevision,
    sha256,
  });

  await uploadIntakeBytes(prepared, options.file);

  try {
    const completed = await completeIntakeUpload(
      options.intakeId,
      prepared.object_id,
      options.expectedDraftRevision,
    );
    return { object_id: prepared.object_id, draft_revision: completed.draft_revision };
  } catch (error) {
    const freshRevision =
      error instanceof IntakeApiError &&
      error.code === INTAKE_ERROR.staleDraftRevision &&
      typeof error.payload.draft_revision === "number"
        ? error.payload.draft_revision
        : null;
    if (freshRevision === null) throw error;
    const completed = await completeIntakeUpload(
      options.intakeId,
      prepared.object_id,
      freshRevision,
    );
    return { object_id: prepared.object_id, draft_revision: completed.draft_revision };
  }
}

export function removeIntakeFile(
  intakeId: string,
  objectId: string,
  expectedDraftRevision: number,
): Promise<{ draft_revision: number }> {
  return fetch(
    `/api/settlement/intakes/${encodeURIComponent(intakeId)}/files/${encodeURIComponent(objectId)}`,
    {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_draft_revision: expectedDraftRevision }),
    },
  ).then((response) => readIntakeJson<{ draft_revision: number }>(response));
}

export function reorderIntakeDraft(
  intakeId: string,
  objectIds: string[],
  expectedDraftRevision: number,
): Promise<{ draft_revision: number }> {
  return fetch(
    `/api/settlement/intakes/${encodeURIComponent(intakeId)}/reorder`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        object_ids: objectIds,
        expected_draft_revision: expectedDraftRevision,
      }),
    },
  ).then((response) => readIntakeJson<{ draft_revision: number }>(response));
}

export type SubmittedIntakeVersion = {
  id: string;
  version_no: number;
  file_count: number;
  total_size_bytes: number;
  manifest_sha256: string;
  submitted_by: string;
  created_at: string;
  files: Array<{
    id: string;
    object_id: string;
    position: number;
    path_key: string;
    display_path: string;
    size_bytes: number;
    sha256: string;
  }>;
};

export function submitIntakeVersion(
  intakeId: string,
  expectedDraftRevision: number,
): Promise<{ version: SubmittedIntakeVersion; job_id: string }> {
  return fetch(
    `/api/settlement/intakes/${encodeURIComponent(intakeId)}/submit`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_draft_revision: expectedDraftRevision }),
    },
  ).then((response) => readIntakeJson<{ version: SubmittedIntakeVersion; job_id: string }>(response));
}
