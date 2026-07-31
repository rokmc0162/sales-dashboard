/** Pure UI-order assertions for the answer-workbook review table. */
import assert from "node:assert/strict";

import {
  flattenWorkbookOverlays,
  visibleWorkbookRows,
} from "../src/features/settlement/components/AnswerWorkbookReview";
import type {
  WorkbookReview,
  WorkbookReviewOverlay,
  WorkbookReviewRow,
} from "../src/features/settlement/lib/comparison/workbook-review";

function overlay(diffId: string): WorkbookReviewOverlay {
  return {
    diff_id: diffId,
    category: "field",
    field: "channel",
    review_status: "pending",
    review_note: null,
    investigation_status: "uninvestigated",
    root_cause_stage: null,
    root_cause_summary: null,
    candidate_location: null,
    golden_location: null,
    system_value: "system",
    answer_value: "answer",
  };
}

function row(rowNumber: number, rowOverlays: WorkbookReviewOverlay[], cellOverlays: WorkbookReviewOverlay[][]): WorkbookReviewRow {
  return {
    kind: "answer",
    sheet: "answer",
    row: rowNumber,
    address: `${rowNumber}:${rowNumber}`,
    row_overlays: rowOverlays,
    cells: cellOverlays.map((overlays, index) => ({
      field: index === 0 ? "channel" : "type",
      column: index + 1,
      address: `${index === 0 ? "A" : "B"}${rowNumber}`,
      state: "value",
      value: `${rowNumber}-${index}`,
      formula: null,
      known: true,
      overlays,
    })),
  };
}

const duplicate = overlay("duplicate");
const review: WorkbookReview = {
  sheet_name: "answer",
  columns: [
    { field: "channel", column: 1, letter: "A" },
    { field: "type", column: 2, letter: "B" },
  ],
  rows: [
    row(10, [], [[], []]),
    row(11, [overlay("row-first")], [[overlay("cell-second")], []]),
    row(12, [], [[duplicate], [duplicate, overlay("cell-third")]]),
    row(13, [], [[], []]),
  ],
  context_rows: 1,
  row_limit: 10,
  total_relevant_rows: 4,
  rows_truncated: false,
  diff_count: 4,
  shown_diff_count: 4,
};

assert.deepEqual(visibleWorkbookRows(review, true).map((item) => item.row), [10, 11, 12, 13]);
assert.deepEqual(visibleWorkbookRows(review, false).map((item) => item.row), [11, 12]);

const targets = flattenWorkbookOverlays(review, true);
assert.deepEqual(targets.map((target) => target.overlay.diff_id), [
  "row-first",
  "cell-second",
  "duplicate",
  "cell-third",
]);
assert.deepEqual(targets.map(({ rowIndex, cellIndex }) => [rowIndex, cellIndex]), [
  [1, null],
  [1, 0],
  [2, 0],
  [2, 1],
]);
assert.deepEqual(
  flattenWorkbookOverlays(review, false).map((target) => target.overlay.diff_id),
  targets.map((target) => target.overlay.diff_id),
  "hiding neutral context must not change difference order",
);

console.log("test-settlement-workbook-review-ui: all assertions passed");
