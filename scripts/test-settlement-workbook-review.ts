/**
 * Synthetic assertions for the bounded workbook-review projection.
 * Run: node --import tsx scripts/test-settlement-workbook-review.ts
 */
import assert from "node:assert/strict";

import type { ComparisonDiffFinding } from "../src/features/settlement/lib/comparison/compare";
import {
  buildWorkbookReview,
  MAX_WORKBOOK_REVIEW_CELLS,
  MAX_WORKBOOK_REVIEW_ROWS,
  MAX_WORKBOOK_REVIEW_TEXT_LENGTH,
  workbookReviewFingerprint,
} from "../src/features/settlement/lib/comparison/workbook-review";
import {
  COMPARE_FIELDS,
  excelCellAddress,
  type CellSnapshot,
  type CompareField,
  type InputRowSnapshot,
  type InputSheetSnapshot,
} from "../src/features/settlement/lib/comparison/workbook";
import { ELECTRONIC_COL } from "../src/features/settlement/lib/export/input-v2-filler";
import type {
  ComparisonDiffReviewStatus,
  SettlementComparisonDiffRow,
} from "../src/features/settlement/lib/supabase/types";

const SHEET = "input_電子_7月";
const SYSTEM_SHEET = "generated";
const identity = { channel: "cmoa", type: "WT", title: "作品A" };
const blankCell: CellSnapshot = {
  state: "blank",
  value: null,
  formula: null,
  known: true,
};

function row(
  rowNumber: number,
  values: Partial<Record<CompareField, CellSnapshot["value"]>> = {},
): InputRowSnapshot {
  const cells = Object.fromEntries(
    COMPARE_FIELDS.map((field) => [
      field,
      field in values
        ? { state: "value", value: values[field] ?? null, formula: null, known: true }
        : { ...blankCell },
    ]),
  ) as Record<CompareField, CellSnapshot>;
  return { rowNumber, identity: { ...identity }, identityKey: "cmoa\0wt\0作品a", cells };
}

function sheet(rows: InputRowSnapshot[]): InputSheetSnapshot {
  return { sheetName: SHEET, columns: { ...ELECTRONIC_COL }, rows };
}

function location(
  sheetName: string,
  rowNumber: number,
  column: number | null,
): NonNullable<ComparisonDiffFinding["golden_location"]> {
  return {
    sheet: sheetName,
    row: rowNumber,
    column,
    address: column === null ? `${rowNumber}:${rowNumber}` : excelCellAddress(rowNumber, column),
  };
}

function finding(partial: Partial<ComparisonDiffFinding> = {}): ComparisonDiffFinding {
  const field = "total_amount_jpy";
  return {
    category: "field",
    identity: { ...identity },
    field,
    candidate: 120,
    golden: 100,
    candidate_location: location(SYSTEM_SHEET, 10, ELECTRONIC_COL[field]),
    golden_location: location(SHEET, 10, ELECTRONIC_COL[field]),
    ...partial,
  };
}

function persisted(
  runtime: ComparisonDiffFinding,
  id: string,
  reviewStatus: ComparisonDiffReviewStatus = "pending",
  metadata: Partial<Pick<
    SettlementComparisonDiffRow,
    "review_note" | "investigation_status" | "root_cause_stage" | "root_cause_summary"
  >> = {},
  diffOrdinal = 0,
): SettlementComparisonDiffRow {
  return {
    id,
    run_id: "run-1",
    diff_ordinal: diffOrdinal,
    category: runtime.category,
    identity_channel: runtime.identity.channel || null,
    identity_type: runtime.identity.type || null,
    identity_title: runtime.identity.title || null,
    field: runtime.field,
    candidate_value: runtime.candidate,
    golden_value: runtime.golden,
    review_status: reviewStatus,
    review_note: metadata.review_note ?? null,
    reviewed_at: null,
    reviewed_by: null,
    investigation_status: metadata.investigation_status ?? "uninvestigated",
    root_cause_stage: metadata.root_cause_stage ?? null,
    root_cause_summary: metadata.root_cause_summary ?? null,
    created_at: "2026-07-31T00:00:00.000Z",
  };
}

// Fingerprints recursively sort object keys, including nested candidate/golden JSON.
{
  const a = workbookReviewFingerprint({
    category: "field",
    identity: ["cmoa", "WT", "作品A"],
    field: "fee_jpy",
    candidate: { z: 1, nested: { b: 2, a: [3, { y: true, x: false }] } },
    golden: { second: 2, first: 1 },
  });
  const b = workbookReviewFingerprint({
    category: "field",
    identity: ["cmoa", "WT", "作品A"],
    field: "fee_jpy",
    candidate: { nested: { a: [3, { x: false, y: true }], b: 2 }, z: 1 },
    golden: { first: 1, second: 2 },
  });
  assert.equal(a, b, "fingerprint must be canonical sorted JSON");
}

// Duplicate fingerprints map deterministically by ordinal, independent of persisted array order.
{
  const runtimeA = finding();
  const runtimeB = finding();
  const review = buildWorkbookReview(
    sheet([row(10, { total_amount_jpy: 100 })]),
    [runtimeA, runtimeB],
    [
      persisted(runtimeB, "duplicate-2", "resolved", {}, 1),
      persisted(runtimeA, "duplicate-1", "pending", {}, 0),
    ],
    { contextRows: 0 },
  );
  const cell = review.rows[0]?.cells.find((item) => item.field === "total_amount_jpy");
  assert.deepEqual(cell?.overlays.map((overlay) => overlay.diff_id), ["duplicate-1", "duplicate-2"]);
  assert.deepEqual(cell?.overlays.map((overlay) => overlay.review_status), ["pending", "resolved"]);
  assert.equal(review.diff_count, 2);
  assert.equal(review.shown_diff_count, 2);
}

// Hundreds of extras cannot starve a missing target row; unused answer slots are donated.
{
  const target = finding({
    category: "missing",
    field: null,
    candidate: null,
    golden: { row: 10, cells: {} },
    candidate_location: null,
    golden_location: location(SHEET, 10, null),
  });
  const extras = Array.from({ length: 400 }, (_, index) => finding({
    category: "extra",
    identity: { channel: "system", type: "WT", title: `extra-${index}` },
    field: null,
    candidate: { row: index + 1, cells: { channel: "system", title_jp: `extra-${index}` } },
    golden: null,
    candidate_location: location(SYSTEM_SHEET, index + 1, null),
    golden_location: null,
  }));
  const findings = [...extras, target];
  const persistedDiffs = findings
    .map((runtime, index) => persisted(runtime, `crowded-${index}`, "pending", {}, index))
    .reverse();
  const review = buildWorkbookReview(
    sheet([row(10)]),
    findings,
    persistedDiffs,
    { contextRows: 0, maxRows: MAX_WORKBOOK_REVIEW_ROWS },
  );
  assert.equal(review.rows[0]?.kind, "answer");
  assert.equal(review.rows[0]?.row_overlays[0]?.diff_id, "crowded-400");
  assert.ok(review.rows.some((item) => item.kind === "system-only"));
  assert.equal(review.shown_diff_count, review.rows.length);
  assert.equal(review.total_relevant_rows, 401);
  assert.equal(review.rows_truncated, true);
  assert.equal(review.total_relevant_rows - review.rows.length, 401 - review.row_limit);
}

// A field overlay sits on the exact answer cell and carries system value/status.
{
  const runtime = finding({ candidate: 125, golden: 100 });
  const review = buildWorkbookReview(
    sheet([row(10, { total_amount_jpy: 100 })]),
    [runtime],
    [persisted(runtime, "field-1", "golden_correct", {
      review_note: "n".repeat(MAX_WORKBOOK_REVIEW_TEXT_LENGTH + 20),
      investigation_status: "cause_confirmed",
      root_cause_stage: "formula",
      root_cause_summary: "s".repeat(MAX_WORKBOOK_REVIEW_TEXT_LENGTH + 20),
    })],
    { contextRows: 0 },
  );
  const answer = review.rows[0];
  const cell = answer?.cells.find((item) => item.field === "total_amount_jpy");
  assert.equal(answer?.kind, "answer");
  assert.equal(cell?.address, "U10");
  assert.equal(cell?.value, 100);
  assert.equal(cell?.overlays[0]?.system_value, 125);
  assert.equal(cell?.overlays[0]?.answer_value, 100);
  assert.equal(cell?.overlays[0]?.review_status, "golden_correct");
  assert.equal(cell?.overlays[0]?.review_note?.length, MAX_WORKBOOK_REVIEW_TEXT_LENGTH);
  assert.equal(cell?.overlays[0]?.review_note?.endsWith("…"), true);
  assert.equal(cell?.overlays[0]?.investigation_status, "cause_confirmed");
  assert.equal(cell?.overlays[0]?.root_cause_stage, "formula");
  assert.equal(cell?.overlays[0]?.root_cause_summary?.length, MAX_WORKBOOK_REVIEW_TEXT_LENGTH);
  assert.equal(cell?.overlays[0]?.root_cause_summary?.endsWith("…"), true);
  assert.equal(cell?.overlays[0]?.golden_location?.address, "U10");
}

// A missing finding is a whole-answer-row overlay, not a cell overlay.
{
  const digest = { row: 20, cells: { channel: "cmoa", total_amount_jpy: 500 } };
  const runtime = finding({
    category: "missing",
    field: null,
    candidate: null,
    golden: digest,
    candidate_location: null,
    golden_location: location(SHEET, 20, null),
  });
  const review = buildWorkbookReview(
    sheet([row(20, { channel: "cmoa", total_amount_jpy: 500 })]),
    [runtime],
    [persisted(runtime, "missing-1", "needs_review")],
    { contextRows: 0 },
  );
  assert.equal(review.rows[0]?.kind, "answer");
  assert.equal(review.rows[0]?.address, "20:20");
  assert.equal(review.rows[0]?.row_overlays[0]?.diff_id, "missing-1");
  assert.equal(review.rows[0]?.row_overlays[0]?.system_value, null);
  assert.deepEqual(review.rows[0]?.row_overlays[0]?.answer_value, digest);
  assert.ok(review.rows[0]?.cells.every((cell) => cell.overlays.length === 0));
}

// An extra finding becomes a separate system-only row projected into answer columns.
{
  const digest = { row: 7, cells: { channel: "piccoma", total_amount_jpy: 777 } };
  const runtime = finding({
    category: "extra",
    identity: { channel: "piccoma", type: "WT", title: "作品B" },
    field: null,
    candidate: digest,
    golden: null,
    candidate_location: location(SYSTEM_SHEET, 7, null),
    golden_location: null,
  });
  const review = buildWorkbookReview(sheet([]), [runtime], [persisted(runtime, "extra-1")]);
  const extra = review.rows[0];
  assert.equal(extra?.kind, "system-only");
  assert.equal(extra?.sheet, SYSTEM_SHEET);
  assert.equal(extra?.address, "7:7");
  assert.equal(extra?.row_overlays[0]?.diff_id, "extra-1");
  assert.equal(extra?.cells.find((cell) => cell.field === "total_amount_jpy")?.value, 777);
  assert.ok(extra?.cells.every((cell) => cell.address === null));
}

// ±2 context uses row-number distance while preserving original answer row order.
{
  const answerRows = [row(22), row(18), row(21), row(19), row(20), row(30)];
  const runtime = finding({
    category: "missing",
    field: null,
    candidate: null,
    golden: { row: 20, cells: {} },
    candidate_location: null,
    golden_location: location(SHEET, 20, null),
  });
  const review = buildWorkbookReview(sheet(answerRows), [runtime], [persisted(runtime, "context-1")]);
  assert.deepEqual(review.rows.map((item) => item.row), [22, 18, 21, 19, 20]);
  assert.equal(review.context_rows, 2);
}

// Row output is bounded by both the configured maximum and the cell budget.
{
  const answerRows = Array.from({ length: 500 }, (_, index) => row(index + 1));
  const runtime = finding({
    category: "missing",
    field: null,
    candidate: null,
    golden: { row: 250, cells: {} },
    candidate_location: null,
    golden_location: location(SHEET, 250, null),
  });
  const review = buildWorkbookReview(
    sheet(answerRows),
    [runtime],
    [persisted(runtime, "bounded-1")],
    { contextRows: 999, maxRows: 999 },
  );
  const expectedLimit = Math.min(
    MAX_WORKBOOK_REVIEW_ROWS,
    Math.floor(MAX_WORKBOOK_REVIEW_CELLS / COMPARE_FIELDS.length),
  );
  assert.equal(review.row_limit, expectedLimit);
  assert.equal(review.rows.length, expectedLimit);
  assert.equal(review.total_relevant_rows, 500);
  assert.equal(review.rows_truncated, true);
  assert.equal(review.shown_diff_count, 1, "the target row must survive distance-prioritized truncation");
}

// Runtime/persisted sets must match exactly in both directions.
{
  const runtime = finding();
  const golden = sheet([row(10, { total_amount_jpy: 100 })]);
  assert.throws(
    () => buildWorkbookReview(golden, [runtime], []),
    /finding counts differ/,
  );
  assert.throws(
    () => buildWorkbookReview(golden, [], [persisted(runtime, "leftover-1")]),
    /finding counts differ/,
  );
}

// Ordinals must be contiguous and the fingerprint at each ordinal must match runtime output.
{
  const runtimeA = finding({ candidate: 1 });
  const runtimeB = finding({ candidate: 2 });
  const golden = sheet([row(10, { total_amount_jpy: 100 })]);
  assert.throws(
    () => buildWorkbookReview(golden, [runtimeA, runtimeB], [
      persisted(runtimeA, "ordinal-a", "pending", {}, 0),
      persisted(runtimeB, "ordinal-b", "pending", {}, 0),
    ]),
    /ordinals must be unique and contiguous/,
  );
  assert.throws(
    () => buildWorkbookReview(golden, [runtimeA, runtimeB], [
      persisted(runtimeB, "fingerprint-a", "pending", {}, 0),
      persisted(runtimeA, "fingerprint-b", "pending", {}, 1),
    ]),
    /fingerprint mismatch at ordinal 0/,
  );
}

console.log("test-settlement-workbook-review: all assertions passed");
