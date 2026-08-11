import "server-only";

import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { createServiceClient } from "../supabase/server";
import type {
  SettlementIntakeMonthRow,
  SettlementIntakeObjectRow,
  SettlementIntakeVersionFileRow,
} from "../supabase/types";
import {
  INTAKE_BUCKET,
  INTAKE_ERROR,
  MAX_INTAKE_FILE_BYTES,
  type IntakeDraftFile,
  type IntakeVersionSummary,
  type IntakeWorkspace,
} from "./contract";

export type IntakeAdminClient = ReturnType<typeof createServiceClient>;

/**
 * Server-only service-role client for the intake RPCs and the private
 * settlement-intake bucket. The key never leaves the server: routes return
 * only opaque signed-upload tokens and derived workspace payloads.
 */
export function createIntakeAdminClient(): IntakeAdminClient {
  return createServiceClient();
}

export function intakeJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

type PostgrestErrorLike = {
  message?: string | null;
  code?: string | null;
};

/**
 * Maps migration-029 RPC failures onto the deterministic API error codes in
 * the intake contract. Anything unrecognized becomes a 500 intake_rpc_failed
 * without leaking raw database internals.
 */
export function mapIntakeDbError(error: PostgrestErrorLike): {
  status: number;
  body: { error: string; reason?: string };
} {
  const message = error.message ?? "";
  if (/stale draft revision/i.test(message)) {
    return { status: 409, body: { error: INTAKE_ERROR.staleDraftRevision } };
  }
  if (
    error.code === "23505" ||
    /duplicate key value/i.test(message) ||
    /is already in the draft/i.test(message)
  ) {
    return { status: 409, body: { error: INTAKE_ERROR.duplicatePath } };
  }
  if (/invalid settlement intake path_key/i.test(message)) {
    return { status: 400, body: { error: INTAKE_ERROR.invalidPath } };
  }
  if (/unknown settlement intake object/i.test(message)) {
    return { status: 404, body: { error: INTAKE_ERROR.unknownObject } };
  }
  if (/unknown settlement intake/i.test(message)) {
    return { status: 404, body: { error: INTAKE_ERROR.unknownIntake } };
  }
  if (/is not part of the draft/i.test(message)) {
    return { status: 404, body: { error: INTAKE_ERROR.notInDraft } };
  }
  if (/must list exactly the current draft entries/i.test(message)) {
    return { status: 409, body: { error: INTAKE_ERROR.reorderMismatch } };
  }
  if (/cannot submit an empty draft/i.test(message)) {
    return { status: 409, body: { error: INTAKE_ERROR.emptyDraft } };
  }
  if (/contains non-finalized objects/i.test(message)) {
    return { status: 409, body: { error: INTAKE_ERROR.draftNotReady } };
  }
  if (
    /quarantined object .* cannot enter the draft/i.test(message) ||
    /cannot be finalized/i.test(message) ||
    /invalid intake object status transition/i.test(message) ||
    /referenced by a version cannot be (changed|deleted)/i.test(message) ||
    /must keep canonical path/i.test(message) ||
    /must be finalized/i.test(message) ||
    /must use a different object/i.test(message)
  ) {
    return { status: 409, body: { error: INTAKE_ERROR.invalidObjectState } };
  }
  if (
    error.code === "23514" ||
    /violates check constraint/i.test(message) ||
    /draft for intake .* is full/i.test(message)
  ) {
    return { status: 400, body: { error: INTAKE_ERROR.limitExceeded } };
  }
  return { status: 500, body: { error: INTAKE_ERROR.rpcFailed } };
}

export async function fetchIntakeById(
  supabase: IntakeAdminClient,
  intakeId: string,
): Promise<SettlementIntakeMonthRow | null> {
  const { data, error } = await supabase
    .from("settlement_intake_months")
    .select("*")
    .eq("id", intakeId)
    .maybeSingle();
  if (error) throw new Error(`intake lookup failed: ${error.message}`);
  return data;
}

export async function fetchIntakeObject(
  supabase: IntakeAdminClient,
  objectId: string,
): Promise<SettlementIntakeObjectRow | null> {
  const { data, error } = await supabase
    .from("settlement_intake_objects")
    .select("*")
    .eq("id", objectId)
    .maybeSingle();
  if (error) throw new Error(`intake object lookup failed: ${error.message}`);
  return data;
}

/**
 * The object referenced by a *current draft entry* on a canonical path, if
 * any. Objects outside the draft (historical version sources, orphaned
 * uploads) never block a path — draft-level uniqueness is what the RPCs
 * enforce. The draft is bounded at 200 entries, so the .in() list is bounded.
 */
export async function fetchDraftObjectByPathKey(
  supabase: IntakeAdminClient,
  intakeId: string,
  pathKey: string,
): Promise<SettlementIntakeObjectRow | null> {
  const { data: entries, error: entriesError } = await supabase
    .from("settlement_intake_draft_entries")
    .select("object_id")
    .eq("intake_id", intakeId);
  if (entriesError) {
    throw new Error(`draft entries lookup failed: ${entriesError.message}`);
  }
  const objectIds = (entries ?? []).map((entry) => entry.object_id);
  if (objectIds.length === 0) return null;
  const { data: objects, error: objectsError } = await supabase
    .from("settlement_intake_objects")
    .select("*")
    .eq("intake_id", intakeId)
    .eq("path_key", pathKey)
    .in("id", objectIds)
    .limit(1);
  if (objectsError) {
    throw new Error(`intake path lookup failed: ${objectsError.message}`);
  }
  return objects?.[0] ?? null;
}

export async function currentDraftRevision(
  supabase: IntakeAdminClient,
  intakeId: string,
): Promise<number | null> {
  const intake = await fetchIntakeById(supabase, intakeId);
  return intake?.draft_revision ?? null;
}

const MAX_WORKSPACE_VERSIONS = 50;
const VERSION_FILE_PAGE_SIZE = 1000;
// 50 versions x 200 files: anything past this bound is a data invariant
// violation and must fail loudly instead of silently truncating.
const MAX_VERSION_FILE_ROWS = 10_000;

/**
 * All version_files rows for the given versions, paginated with .range until
 * complete. PostgREST caps a single response (default 1000 rows), so one
 * unpaginated query would silently truncate multi-version workspaces.
 */
async function fetchAllVersionFiles(
  supabase: IntakeAdminClient,
  versionIds: string[],
): Promise<SettlementIntakeVersionFileRow[]> {
  const rows: SettlementIntakeVersionFileRow[] = [];
  for (let offset = 0; ; offset += VERSION_FILE_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("settlement_intake_version_files")
      .select("*")
      .in("version_id", versionIds)
      .order("version_id", { ascending: true })
      .order("position", { ascending: true })
      .range(offset, offset + VERSION_FILE_PAGE_SIZE - 1);
    if (error) {
      throw new Error(`version files lookup failed: ${error.message}`);
    }
    const page = data ?? [];
    rows.push(...page);
    if (rows.length > MAX_VERSION_FILE_ROWS) {
      throw new Error(
        `version files overflow: more than ${MAX_VERSION_FILE_ROWS} rows for one workspace`,
      );
    }
    if (page.length < VERSION_FILE_PAGE_SIZE) return rows;
  }
}

/**
 * Bounded month workspace read: the intake row, the ordered draft (entries
 * joined with their immutable source objects), and the most recent submitted
 * versions with their frozen file snapshots.
 */
export async function loadIntakeWorkspace(
  supabase: IntakeAdminClient,
  monthKey: string,
): Promise<IntakeWorkspace> {
  const { data: intake, error: intakeError } = await supabase
    .from("settlement_intake_months")
    .select("*")
    .eq("month_key", monthKey)
    .maybeSingle();
  if (intakeError) throw new Error(`intake lookup failed: ${intakeError.message}`);
  if (!intake) {
    return {
      month_key: monthKey,
      intake: null,
      draft: { revision: 0, files: [] },
      versions: [],
    };
  }

  const [entriesResult, versionsResult] = await Promise.all([
    supabase
      .from("settlement_intake_draft_entries")
      .select("*")
      .eq("intake_id", intake.id)
      .order("position", { ascending: true }),
    supabase
      .from("settlement_intake_versions")
      .select("*")
      .eq("intake_id", intake.id)
      .order("version_no", { ascending: false })
      .limit(MAX_WORKSPACE_VERSIONS),
  ]);
  if (entriesResult.error) {
    throw new Error(`draft entries lookup failed: ${entriesResult.error.message}`);
  }
  if (versionsResult.error) {
    throw new Error(`versions lookup failed: ${versionsResult.error.message}`);
  }
  const entries = entriesResult.data ?? [];
  const versions = (versionsResult.data ?? []).slice().reverse();

  const objectIds = entries.map((entry) => entry.object_id);
  const versionIds = versions.map((version) => version.id);

  const [objectsResult, versionFiles] = await Promise.all([
    objectIds.length > 0
      ? supabase.from("settlement_intake_objects").select("*").in("id", objectIds)
      : Promise.resolve({ data: [], error: null }),
    versionIds.length > 0
      ? fetchAllVersionFiles(supabase, versionIds)
      : Promise.resolve([] as SettlementIntakeVersionFileRow[]),
  ]);
  if (objectsResult.error) {
    throw new Error(`objects lookup failed: ${objectsResult.error.message}`);
  }

  const objectsById = new Map(
    (objectsResult.data ?? []).map((object) => [object.id, object]),
  );
  // Informational badge only: "frozen into one of the displayed versions".
  const lockedObjectIds = new Set(versionFiles.map((file) => file.object_id));

  const draftFiles: IntakeDraftFile[] = [];
  for (const entry of entries) {
    const object = objectsById.get(entry.object_id);
    if (!object) continue;
    draftFiles.push({
      object_id: object.id,
      position: entry.position,
      path_key: object.path_key,
      display_path: object.display_name,
      content_type: object.content_type,
      size_bytes: object.expected_size_bytes,
      sha256: object.expected_sha256,
      status: object.status,
      uploaded_by: object.created_by,
      uploaded_at: object.created_at,
      locked_by_version: lockedObjectIds.has(object.id),
    });
  }

  const versionSummaries: IntakeVersionSummary[] = versions.map((version) => ({
    id: version.id,
    version_no: version.version_no,
    file_count: version.file_count,
    total_size_bytes: version.total_size_bytes,
    manifest_sha256: version.manifest_sha256,
    submitted_by: version.submitted_by,
    created_at: version.created_at,
    files: versionFiles
      .filter((file) => file.version_id === version.id)
      .map((file) => ({
        id: file.id,
        object_id: file.object_id,
        position: file.position,
        path_key: file.path_key,
        display_path: file.display_name,
        size_bytes: file.size_bytes,
        sha256: file.sha256,
      })),
  }));

  return {
    month_key: monthKey,
    intake: {
      id: intake.id,
      month_key: intake.month_key,
      draft_revision: intake.draft_revision,
      created_by: intake.created_by,
      created_at: intake.created_at,
    },
    draft: { revision: intake.draft_revision, files: draftFiles },
    versions: versionSummaries,
  };
}

export type StorageReadBack =
  | { ok: true; sizeBytes: number; sha256: string }
  | { ok: false; error: typeof INTAKE_ERROR.objectMissing | typeof INTAKE_ERROR.sizeMismatch };

const SIGNED_READBACK_TTL_SECONDS = 60;

/**
 * Bounded trusted read-back of an uploaded object: the server fetches the
 * private object itself through a short-lived signed download URL (never
 * trusting client-reported bytes) and streams the body through an
 * incremental SHA-256 with byte counting. The stream is hard-aborted the
 * moment it exceeds the expected size or the 100 MiB cap — the whole object
 * is never buffered in memory.
 */
export async function readBackIntakeObject(
  supabase: IntakeAdminClient,
  storagePath: string,
  expectedSizeBytes: number,
): Promise<StorageReadBack> {
  const { data: signed, error: signedError } = await supabase.storage
    .from(INTAKE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_READBACK_TTL_SECONDS);
  if (signedError || !signed?.signedUrl) {
    return { ok: false, error: INTAKE_ERROR.objectMissing };
  }

  const controller = new AbortController();
  let response: Response;
  try {
    response = await fetch(signed.signedUrl, {
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: INTAKE_ERROR.objectMissing };
  }
  if (!response.ok || !response.body) {
    return { ok: false, error: INTAKE_ERROR.objectMissing };
  }

  const hardLimitBytes = Math.min(expectedSizeBytes, MAX_INTAKE_FILE_BYTES);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      sizeBytes += value.byteLength;
      if (sizeBytes > hardLimitBytes) {
        controller.abort();
        return { ok: false, error: INTAKE_ERROR.sizeMismatch };
      }
      hash.update(value);
    }
  } catch {
    return { ok: false, error: INTAKE_ERROR.objectMissing };
  }
  if (sizeBytes !== expectedSizeBytes) {
    return { ok: false, error: INTAKE_ERROR.sizeMismatch };
  }
  return { ok: true, sizeBytes, sha256: hash.digest("hex") };
}
