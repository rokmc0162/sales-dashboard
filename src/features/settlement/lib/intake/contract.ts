// Shared web-intake contract: canonical path rules, size limits, deterministic
// API error codes, and the workspace payload shapes exchanged between the
// intake API routes and the browser workspace UI. This module is pure and
// isomorphic (no server or DOM dependencies) so the same canonicalization runs
// in the browser, in route handlers, and in tests.

export const INTAKE_BUCKET = "settlement-intake";
export const MAX_INTAKE_FILES = 200;
export const MAX_INTAKE_FILE_BYTES = 104_857_600; // mirrors DB check (100 MiB)
export const MAX_INTAKE_TOTAL_BYTES = 20_971_520_000; // mirrors DB check
export const MAX_INTAKE_PATH_CHARS = 500; // path_key varchar(500)
export const MAX_INTAKE_DISPLAY_CHARS = 300; // display_name varchar(300)

// Deterministic machine-readable error codes returned as { error: <code> }.
export const INTAKE_ERROR = {
  invalidMonth: "invalid_month",
  invalidPath: "invalid_path",
  invalidSize: "invalid_size",
  invalidSha256: "invalid_sha256",
  invalidBody: "invalid_body",
  unknownIntake: "unknown_intake",
  unknownObject: "unknown_object",
  duplicatePath: "duplicate_path",
  staleDraftRevision: "stale_draft_revision",
  invalidObjectState: "invalid_object_state",
  objectMissing: "object_missing",
  sizeMismatch: "size_mismatch",
  hashMismatch: "hash_mismatch",
  notInDraft: "not_in_draft",
  reorderMismatch: "reorder_mismatch",
  emptyDraft: "empty_draft",
  draftNotReady: "draft_not_ready",
  limitExceeded: "limit_exceeded",
  rpcFailed: "intake_rpc_failed",
} as const;

export type IntakeErrorCode = (typeof INTAKE_ERROR)[keyof typeof INTAKE_ERROR];

export function isValidIntakeMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^[0-9]{4}(0[1-9]|1[0-2])$/.test(value);
}

export function isValidSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value.toLowerCase());
}

export type IntakePathResult =
  | { ok: true; pathKey: string; displayPath: string }
  | { ok: false; error: typeof INTAKE_ERROR.invalidPath; reason: string };

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Canonicalizes a selection-relative path into the pair the intake schema
 * expects:
 *  - displayPath: NFC-normalized, '/'-separated, case-preserving path shown
 *    to operators and frozen into version snapshots (display_name).
 *  - pathKey: lowercase NFC form of displayPath — the identity under which
 *    duplicates and macOS-style case collisions are detected. Two display
 *    paths that differ only by case map to one pathKey, so they can never
 *    map to two files on a case-insensitive SSD checkout.
 *
 * Separators are normalized ('\' → '/', leading '/' stripped); everything
 * else invalid ('.'/'..' segments, empty segments, control characters,
 * over-long paths) is rejected, never silently rewritten.
 */
export function canonicalizeIntakePath(input: unknown): IntakePathResult {
  if (typeof input !== "string" || input.length === 0) {
    return { ok: false, error: INTAKE_ERROR.invalidPath, reason: "empty" };
  }
  const nfc = input.normalize("NFC");
  if (hasControlCharacters(nfc)) {
    return { ok: false, error: INTAKE_ERROR.invalidPath, reason: "control_characters" };
  }
  const segments = nfc.replace(/\\/g, "/").replace(/^\/+/, "").split("/");
  if (segments.length === 0 || segments[segments.length - 1] === "") {
    return { ok: false, error: INTAKE_ERROR.invalidPath, reason: "empty_segment" };
  }
  for (const segment of segments) {
    if (segment === "") {
      return { ok: false, error: INTAKE_ERROR.invalidPath, reason: "empty_segment" };
    }
    if (segment === "." || segment === "..") {
      return { ok: false, error: INTAKE_ERROR.invalidPath, reason: "dot_segment" };
    }
  }
  const displayPath = segments.join("/");
  if (displayPath.length > MAX_INTAKE_DISPLAY_CHARS) {
    return { ok: false, error: INTAKE_ERROR.invalidPath, reason: "too_long" };
  }
  const pathKey = displayPath.toLowerCase().normalize("NFC");
  if (pathKey.length > MAX_INTAKE_PATH_CHARS) {
    return { ok: false, error: INTAKE_ERROR.invalidPath, reason: "too_long" };
  }
  return { ok: true, pathKey, displayPath };
}

export function intakeFileName(displayPath: string): string {
  const segments = displayPath.split("/");
  return segments[segments.length - 1] ?? displayPath;
}

// ---------------------------------------------------------------------------
// Workspace payload shapes (GET /api/settlement/intakes?month=YYYYMM)
// ---------------------------------------------------------------------------

export type IntakeObjectStatus = "uploading" | "finalized" | "quarantined";

export type IntakeDraftFile = {
  object_id: string;
  position: number;
  path_key: string;
  display_path: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  status: IntakeObjectStatus;
  uploaded_by: string;
  uploaded_at: string;
  locked_by_version: boolean;
};

export type IntakeVersionFile = {
  id: string;
  object_id: string;
  position: number;
  path_key: string;
  display_path: string;
  size_bytes: number;
  sha256: string;
};

export type IntakeVersionSummary = {
  id: string;
  version_no: number;
  file_count: number;
  total_size_bytes: number;
  manifest_sha256: string;
  submitted_by: string;
  created_at: string;
  files: IntakeVersionFile[];
};

export type IntakeWorkspace = {
  month_key: string;
  intake: {
    id: string;
    month_key: string;
    draft_revision: number;
    created_by: string;
    created_at: string;
  } | null;
  draft: {
    revision: number;
    files: IntakeDraftFile[];
  };
  versions: IntakeVersionSummary[];
};
