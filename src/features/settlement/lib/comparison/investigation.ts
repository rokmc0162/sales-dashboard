/**
 * Validation for the investigation PATCH fields and comment POST body. Pure
 * so it is testable without the routes: the investigation lifecycle tracks a
 * diff from "uninvestigated" through cause confirmation to resolution, and
 * comments form the append-only question/answer thread on a diff.
 */
import type {
  ComparisonCommentAuthorType,
  ComparisonInvestigationStatus,
  ComparisonRootCauseStage,
} from "../supabase/types";

export const DIFF_INVESTIGATION_STATUSES: readonly ComparisonInvestigationStatus[] = [
  "uninvestigated",
  "question_pending",
  "investigating",
  "cause_confirmed",
  "fix_in_progress",
  "verification_pending",
  "resolved",
];

export const ROOT_CAUSE_STAGES: readonly ComparisonRootCauseStage[] = [
  "source",
  "upload",
  "parser",
  "transform",
  "identity",
  "aggregation",
  "carry",
  "formula",
  "human_workbook",
  "unknown",
];

export const COMMENT_AUTHOR_TYPES: readonly ComparisonCommentAuthorType[] = [
  "operator",
  "hermes",
  "system",
];

export const ROOT_CAUSE_SUMMARY_MAX_LENGTH = 4000;
export const COMMENT_BODY_MAX_LENGTH = 4000;
export const COMMENT_LIST_LIMIT = 200;

export interface DiffInvestigationPatch {
  investigation_status?: ComparisonInvestigationStatus;
  root_cause_stage?: ComparisonRootCauseStage | null;
  root_cause_summary?: string | null;
}

export type DiffInvestigationValidation =
  | { ok: true; patch: DiffInvestigationPatch }
  | { ok: false; error: string };

/**
 * Extracts the three investigation fields from a PATCH body. An empty patch
 * is ok:true here — the route decides whether the combined review+
 * investigation patch is empty.
 */
export function validateDiffInvestigationPatch(body: unknown): DiffInvestigationValidation {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const { investigation_status, root_cause_stage, root_cause_summary } =
    body as Record<string, unknown>;
  const patch: DiffInvestigationPatch = {};

  if (investigation_status !== undefined) {
    if (
      typeof investigation_status !== "string" ||
      !DIFF_INVESTIGATION_STATUSES.includes(investigation_status as ComparisonInvestigationStatus)
    ) {
      return {
        ok: false,
        error: `investigation_status must be one of: ${DIFF_INVESTIGATION_STATUSES.join(", ")}`,
      };
    }
    patch.investigation_status = investigation_status as ComparisonInvestigationStatus;
  }

  if (root_cause_stage !== undefined) {
    if (root_cause_stage === null) {
      patch.root_cause_stage = null;
    } else if (
      typeof root_cause_stage === "string" &&
      ROOT_CAUSE_STAGES.includes(root_cause_stage as ComparisonRootCauseStage)
    ) {
      patch.root_cause_stage = root_cause_stage as ComparisonRootCauseStage;
    } else {
      return {
        ok: false,
        error: `root_cause_stage must be null or one of: ${ROOT_CAUSE_STAGES.join(", ")}`,
      };
    }
  }

  if (root_cause_summary !== undefined) {
    if (root_cause_summary === null) {
      patch.root_cause_summary = null;
    } else if (typeof root_cause_summary === "string") {
      if (root_cause_summary.length > ROOT_CAUSE_SUMMARY_MAX_LENGTH) {
        return {
          ok: false,
          error: `root_cause_summary must be at most ${ROOT_CAUSE_SUMMARY_MAX_LENGTH} characters`,
        };
      }
      patch.root_cause_summary = root_cause_summary;
    } else {
      return { ok: false, error: "root_cause_summary must be a string or null" };
    }
  }

  return { ok: true, patch };
}

export type CommentPostValidation =
  | { ok: true; body: string }
  | { ok: false; error: string };

/**
 * Validates a comment POST body. Only `body` is read — the author is always
 * assigned server-side (operator), so a client-supplied author_type is
 * ignored and can never spoof hermes/system authorship.
 */
export function validateCommentPost(body: unknown): CommentPostValidation {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const raw = (body as Record<string, unknown>).body;
  if (typeof raw !== "string") {
    return { ok: false, error: "body must be a string" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "body must not be blank" };
  }
  if (trimmed.length > COMMENT_BODY_MAX_LENGTH) {
    return { ok: false, error: `body must be at most ${COMMENT_BODY_MAX_LENGTH} characters` };
  }
  return { ok: true, body: trimmed };
}
