/**
 * Deterministic assertions for the investigation UI helpers: KO/JA labels for
 * every status/stage and the pure root-cause candidate mapping. No DB, no DOM.
 * Run: node --import tsx scripts/test-settlement-investigation-ui.ts
 */
import assert from "node:assert/strict";

import {
  DIFF_INVESTIGATION_STATUSES,
  ROOT_CAUSE_STAGES,
} from "../src/features/settlement/lib/comparison/investigation";
import {
  INVESTIGATION_STATUS_LABELS,
  ROOT_CAUSE_STAGE_LABELS,
  hasConfirmedRootCause,
  investigationStatusLabel,
  rootCauseStageLabel,
  suggestRootCauseCandidates,
} from "../src/features/settlement/lib/comparison/investigation-ui";

const ko = (koText: string) => koText;
const ja = (_koText: string, jaText: string) => jaText;

// ── Labels ─────────────────────────────────────────────────────────────────

// Every enum value has a non-empty KO and JA label distinct from the raw key.
for (const status of DIFF_INVESTIGATION_STATUSES) {
  const label = INVESTIGATION_STATUS_LABELS[status];
  assert.ok(label, `missing status label: ${status}`);
  assert.ok(label.ko.length > 0 && label.ja.length > 0);
  assert.notEqual(investigationStatusLabel(status, ko), status);
  assert.equal(investigationStatusLabel(status, ko), label.ko);
  assert.equal(investigationStatusLabel(status, ja), label.ja);
}
for (const stage of ROOT_CAUSE_STAGES) {
  const label = ROOT_CAUSE_STAGE_LABELS[stage];
  assert.ok(label, `missing stage label: ${stage}`);
  assert.ok(label.ko.length > 0 && label.ja.length > 0);
  assert.notEqual(rootCauseStageLabel(stage, ko), stage);
  assert.equal(rootCauseStageLabel(stage, ko), label.ko);
  assert.equal(rootCauseStageLabel(stage, ja), label.ja);
}

// Spot checks so the maps cannot be silently shuffled.
assert.equal(investigationStatusLabel("question_pending", ko), "질문 대기");
assert.equal(investigationStatusLabel("cause_confirmed", ja), "原因確定");
assert.equal(rootCauseStageLabel("parser", ko), "파서");
assert.equal(rootCauseStageLabel("parser", ja), "パーサー");
assert.equal(rootCauseStageLabel("human_workbook", ko), "사람 작업본");

// A recorded stage/summary is only a confirmed cause once the lifecycle has
// reached cause_confirmed or later. All three pieces are required.
assert.equal(hasConfirmedRootCause("investigating", "parser", "원인 메모"), false);
assert.equal(hasConfirmedRootCause("cause_confirmed", null, "원인 메모"), false);
assert.equal(hasConfirmedRootCause("cause_confirmed", "parser", "   "), false);
assert.equal(hasConfirmedRootCause("cause_confirmed", "parser", "셀 오독"), true);
assert.equal(hasConfirmedRootCause("fix_in_progress", "parser", "셀 오독"), true);
assert.equal(hasConfirmedRootCause("verification_pending", "parser", "셀 오독"), true);
assert.equal(hasConfirmedRootCause("resolved", "parser", "셀 오독"), true);

// ── Candidate mapping ──────────────────────────────────────────────────────

function stages(category: Parameters<typeof suggestRootCauseCandidates>[0], field: string | null) {
  return suggestRootCauseCandidates(category, field).map((candidate) => candidate.stage);
}

// missing: parser / identity / carry trace, regardless of field.
assert.deepEqual(stages("missing", null), ["parser", "identity", "carry"]);
assert.deepEqual(stages("missing", "after_tax_income_jpy"), ["parser", "identity", "carry"]);

// extra: duplicate(upload) / identity / carry, regardless of field.
assert.deepEqual(stages("extra", null), ["upload", "identity", "carry"]);
assert.deepEqual(stages("extra", "channel"), ["upload", "identity", "carry"]);

// formula category always maps to the formula stage.
assert.deepEqual(stages("formula", "after_tax_income_jpy"), ["formula"]);
assert.deepEqual(stages("formula", null), ["formula"]);

// identity fields map to identity.
for (const field of ["unique_identifier", "channel_title_jp", "title_kr", "title_jp", "channel", "type"]) {
  assert.deepEqual(stages("field", field), ["identity"], `identity field: ${field}`);
}

// date fields map to transform (cadence hint lives in the candidate text).
for (const field of ["launch_date", "sales_month", "month", "settlement_month", "deposit_month", "statement_received", "updated"]) {
  assert.deepEqual(stages("field", field), ["transform"], `date field: ${field}`);
}
const dateCandidate = suggestRootCauseCandidates("field", "settlement_month")[0];
assert.ok(dateCandidate.ko.includes("케이던스"));

// amount/tax/RS fields map to parser / aggregation / formula.
for (const field of [
  "total_amount_jpy",
  "fee_jpy",
  "before_tax_jpy",
  "after_tax_jpy",
  "rs",
  "withholding_tax_jpy",
  "tax_jpy",
  "after_tax_income_jpy",
  "exchange_rate",
  "sales_krw",
  "vat_krw",
  "mg_begin",
  "allocation_rate",
]) {
  assert.deepEqual(stages("field", field), ["parser", "aggregation", "formula"], `amount field: ${field}`);
}

// Everything else falls back to unknown — including distribution_strategy,
// which contains "rate" as a substring and must NOT classify as an amount.
for (const field of ["company", "country", "note1", "note2", "distribution_strategy", "settlement_currency"]) {
  assert.deepEqual(stages("field", field), ["unknown"], `fallback field: ${field}`);
}
assert.deepEqual(stages("field", null), ["unknown"]);

// Candidates are deterministic, non-empty, use only valid stages, and never
// present themselves as a confirmed cause.
for (const category of ["missing", "extra", "field", "formula"] as const) {
  for (const field of [null, "after_tax_income_jpy", "channel", "settlement_month", "note1"]) {
    const first = suggestRootCauseCandidates(category, field);
    const second = suggestRootCauseCandidates(category, field);
    assert.deepEqual(first, second, `non-deterministic: ${category}/${field}`);
    assert.ok(first.length > 0, `empty candidates: ${category}/${field}`);
    for (const candidate of first) {
      assert.ok(
        ROOT_CAUSE_STAGES.includes(candidate.stage),
        `invalid stage ${candidate.stage} for ${category}/${field}`,
      );
      assert.ok(!candidate.ko.includes("확정"), "candidate text must not claim a confirmed cause");
      assert.ok(!candidate.ja.includes("確定"), "candidate text must not claim a confirmed cause");
    }
  }
}

console.log("test-settlement-investigation-ui: all assertions passed");
