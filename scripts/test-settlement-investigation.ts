/**
 * Assertions for the settlement-difference investigation foundation:
 * validators, enum contracts, comment body rules, author-spoof rejection,
 * and the shape of migration 020 (no DB connection required).
 * Run: node --import tsx scripts/test-settlement-investigation.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  COMMENT_AUTHOR_TYPES,
  COMMENT_BODY_MAX_LENGTH,
  COMMENT_LIST_LIMIT,
  DIFF_INVESTIGATION_STATUSES,
  ROOT_CAUSE_STAGES,
  ROOT_CAUSE_SUMMARY_MAX_LENGTH,
  validateCommentPost,
  validateDiffInvestigationPatch,
} from "../src/features/settlement/lib/comparison/investigation";
import { validateDiffReviewPatch } from "../src/features/settlement/lib/comparison/review";
import {
  validateComparisonCommentAuthor,
  validateComparisonInvestigationStatus,
  validateComparisonRootCauseStage,
} from "../src/features/settlement/lib/comparison/store-validation";

// ── Enum contracts ─────────────────────────────────────────────────────────

assert.deepEqual(DIFF_INVESTIGATION_STATUSES, [
  "uninvestigated",
  "question_pending",
  "investigating",
  "cause_confirmed",
  "fix_in_progress",
  "verification_pending",
  "resolved",
]);
assert.deepEqual(ROOT_CAUSE_STAGES, [
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
]);
assert.deepEqual(COMMENT_AUTHOR_TYPES, ["operator", "hermes", "system"]);
assert.equal(ROOT_CAUSE_SUMMARY_MAX_LENGTH, 4000);
assert.equal(COMMENT_BODY_MAX_LENGTH, 4000);
assert.equal(COMMENT_LIST_LIMIT, 200, "comment list must be bounded to 200");

// ── Investigation patch validation ─────────────────────────────────────────

// Every allowed status/stage validates.
for (const status of DIFF_INVESTIGATION_STATUSES) {
  const r = validateDiffInvestigationPatch({ investigation_status: status });
  assert.deepEqual(r, { ok: true, patch: { investigation_status: status } });
  assert.equal(validateComparisonInvestigationStatus(status), status);
}
for (const stage of ROOT_CAUSE_STAGES) {
  const r = validateDiffInvestigationPatch({ root_cause_stage: stage });
  assert.deepEqual(r, { ok: true, patch: { root_cause_stage: stage } });
  assert.equal(validateComparisonRootCauseStage(stage), stage);
}
for (const author of COMMENT_AUTHOR_TYPES) {
  assert.equal(validateComparisonCommentAuthor(author), author);
}

// Unknown enum values are rejected everywhere.
assert.equal(validateDiffInvestigationPatch({ investigation_status: "done" }).ok, false);
assert.equal(validateDiffInvestigationPatch({ investigation_status: null }).ok, false);
assert.equal(validateDiffInvestigationPatch({ investigation_status: 3 }).ok, false);
assert.equal(validateDiffInvestigationPatch({ root_cause_stage: "network" }).ok, false);
assert.equal(validateDiffInvestigationPatch({ root_cause_stage: 3 }).ok, false);
assert.throws(() => validateComparisonInvestigationStatus("done"));
assert.throws(() => validateComparisonRootCauseStage("network"));
assert.throws(() => validateComparisonCommentAuthor("admin"));

// stage/summary are clearable with null; combined patch keeps all fields.
assert.deepEqual(validateDiffInvestigationPatch({ root_cause_stage: null }), {
  ok: true,
  patch: { root_cause_stage: null },
});
assert.deepEqual(validateDiffInvestigationPatch({ root_cause_summary: null }), {
  ok: true,
  patch: { root_cause_summary: null },
});
assert.deepEqual(
  validateDiffInvestigationPatch({
    investigation_status: "cause_confirmed",
    root_cause_stage: "parser",
    root_cause_summary: "파서가 세율 셀을 잘못 읽음",
  }),
  {
    ok: true,
    patch: {
      investigation_status: "cause_confirmed",
      root_cause_stage: "parser",
      root_cause_summary: "파서가 세율 셀을 잘못 읽음",
    },
  },
);

// Summary length bound: exactly 4000 ok, 4001 rejected, non-string rejected.
assert.equal(
  validateDiffInvestigationPatch({ root_cause_summary: "a".repeat(ROOT_CAUSE_SUMMARY_MAX_LENGTH) }).ok,
  true,
);
assert.equal(
  validateDiffInvestigationPatch({ root_cause_summary: "a".repeat(ROOT_CAUSE_SUMMARY_MAX_LENGTH + 1) }).ok,
  false,
);
assert.equal(validateDiffInvestigationPatch({ root_cause_summary: 42 }).ok, false);

// Non-object bodies are rejected; an object without investigation fields is an
// ok-but-empty patch (the route decides emptiness after merging with review).
assert.equal(validateDiffInvestigationPatch(null).ok, false);
assert.equal(validateDiffInvestigationPatch("resolved").ok, false);
assert.equal(validateDiffInvestigationPatch(["resolved"]).ok, false);
assert.deepEqual(validateDiffInvestigationPatch({}), { ok: true, patch: {} });
assert.deepEqual(validateDiffInvestigationPatch({ review_status: "resolved" }), {
  ok: true,
  patch: {},
});

// ── Review patch back-compat ───────────────────────────────────────────────

// Default behavior unchanged: empty review patch still rejected.
assert.equal(validateDiffReviewPatch({}).ok, false);
// allowEmpty (used by the route to merge with investigation fields) accepts it.
assert.deepEqual(validateDiffReviewPatch({}, { allowEmpty: true }), { ok: true, patch: {} });
assert.deepEqual(
  validateDiffReviewPatch({ investigation_status: "investigating" }, { allowEmpty: true }),
  { ok: true, patch: {} },
);
// Invalid review values still fail even with allowEmpty.
assert.equal(validateDiffReviewPatch({ review_status: "approved" }, { allowEmpty: true }).ok, false);
assert.deepEqual(validateDiffReviewPatch({ review_status: "resolved" }), {
  ok: true,
  patch: { review_status: "resolved" },
});

// ── Comment POST validation ────────────────────────────────────────────────

// Body is trimmed; blank and whitespace-only are rejected.
assert.deepEqual(validateCommentPost({ body: "  왜 다르죠?  " }), { ok: true, body: "왜 다르죠?" });
assert.equal(validateCommentPost({ body: "" }).ok, false);
assert.equal(validateCommentPost({ body: "   \n\t " }).ok, false);

// Length bound applies to the trimmed body: 4000 ok, 4001 rejected.
assert.equal(validateCommentPost({ body: `  ${"a".repeat(COMMENT_BODY_MAX_LENGTH)}  ` }).ok, true);
assert.equal(validateCommentPost({ body: "a".repeat(COMMENT_BODY_MAX_LENGTH + 1) }).ok, false);

// Missing/non-string body and non-object payloads are rejected.
assert.equal(validateCommentPost({}).ok, false);
assert.equal(validateCommentPost({ body: 42 }).ok, false);
assert.equal(validateCommentPost({ body: null }).ok, false);
assert.equal(validateCommentPost(null).ok, false);
assert.equal(validateCommentPost("질문").ok, false);
assert.equal(validateCommentPost(["질문"]).ok, false);

// Author spoof contract: a client-supplied author_type is never read — the
// validation result carries only the body, so the route can only ever attach
// the server-side "operator" author.
const spoofed = validateCommentPost({ body: "질문입니다", author_type: "hermes" });
assert.deepEqual(spoofed, { ok: true, body: "질문입니다" });
assert.ok(!("author_type" in (spoofed as object)), "validated comment must not carry author_type");

// ── Migration 020 contract ─────────────────────────────────────────────────

const migration = readFileSync(
  path.join(__dirname, "..", "supabase", "migrations", "020_settlement_investigations.sql"),
  "utf8",
);

// Idempotent guards.
assert.match(migration, /add column if not exists investigation_status text not null default 'uninvestigated'/);
assert.match(migration, /add column if not exists root_cause_stage text/);
assert.match(migration, /add column if not exists root_cause_summary text/);
assert.match(migration, /create table if not exists settlement_comparison_comments/);
assert.match(migration, /create index if not exists idx_comparison_comments_diff_time/);
assert.match(migration, /drop policy if exists/);

// Enum checks in SQL stay in lockstep with the TS constants.
for (const status of DIFF_INVESTIGATION_STATUSES) {
  assert.ok(migration.includes(`'${status}'`), `migration must allow investigation_status '${status}'`);
}
for (const stage of ROOT_CAUSE_STAGES) {
  assert.ok(migration.includes(`'${stage}'`), `migration must allow root_cause_stage '${stage}'`);
}
for (const author of COMMENT_AUTHOR_TYPES) {
  assert.ok(migration.includes(`'${author}'`), `migration must allow author_type '${author}'`);
}

// Comments table: FK cascade, non-blank bounded body, diff/time index.
assert.match(migration, /references settlement_comparison_diffs\(id\) on delete cascade/);
assert.match(migration, /btrim\(body\) <> '' and char_length\(body\) <= 4000/);
assert.match(migration, /on settlement_comparison_comments \(diff_id, created_at\)/);

// RLS: enabled, exactly two authenticated append-only policies (SELECT and
// INSERT), with no UPDATE/DELETE or anonymous policy.
assert.match(migration, /alter table settlement_comparison_comments enable row level security/);
const policies = migration.match(/create policy[\s\S]*?;/g) ?? [];
assert.equal(policies.length, 2, "migration must create SELECT and INSERT policies only");
assert.ok(policies.some((policy) => /for select/.test(policy)));
assert.ok(policies.some((policy) => /for insert with check/.test(policy)));
for (const policy of policies) {
  assert.match(policy, /auth\.role\(\) = 'authenticated'/);
  assert.ok(!/\banon\b/.test(policy), "no policy may reference the anon role");
  assert.ok(!/for (update|delete|all)/.test(policy), "comments must remain append-only");
}
assert.match(migration, /settlement_comparison_diffs_confirmed_requires_cause_check/);
assert.match(migration, /investigation_status not in[\s\S]*?'cause_confirmed'[\s\S]*?root_cause_stage is not null/);
assert.match(migration, /settlement_comparison_diffs_root_cause_summary_check/);

console.log("test-settlement-investigation: all assertions passed");
