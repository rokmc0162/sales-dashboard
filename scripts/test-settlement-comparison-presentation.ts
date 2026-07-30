/**
 * Deterministic assertions for the grouped comparison presentation helpers.
 * Run: node --import tsx scripts/test-settlement-comparison-presentation.ts
 */
import assert from "node:assert/strict";

import { displayValue } from "../src/features/settlement/lib/comparison/display";
import {
  alignedRowTable,
  canApplyValueViewFilter,
  differenceText,
  groupCategories,
  groupCounts,
  groupCountsLabel,
  groupDiffs,
  groupIdentityKey,
  isValueDiffCategory,
  MAX_ALIGNED_ROWS,
  type PresentationDiff,
} from "../src/features/settlement/lib/comparison/presentation";

const ko = (koText: string) => koText;

function diff(partial: Partial<PresentationDiff>): PresentationDiff {
  return {
    id: undefined,
    category: "field",
    identity_channel: null,
    identity_type: null,
    identity_title: null,
    field: null,
    candidate_value: null,
    golden_value: null,
    ...partial,
  };
}

{
  // Grouping preserves first-appearance order and merges interleaved identities.
  const diffs = [
    diff({ identity_channel: "cmoa", identity_type: "WT", identity_title: "作品A", field: "fee_jpy" }),
    diff({ identity_channel: "piccoma", identity_type: "WT", identity_title: "作品B", category: "missing" }),
    diff({ identity_channel: "cmoa", identity_type: "WT", identity_title: "作品A", field: "rs" }),
  ];
  const groups = groupDiffs(diffs);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].title, "作品A");
  assert.equal(groups[0].diffs.length, 2);
  assert.deepEqual(groups[0].diffs.map((d) => d.field), ["fee_jpy", "rs"]);
  assert.equal(groups[1].title, "作品B");
}

{
  // Incomplete identities use stable row IDs and never merge unrelated rows.
  const blank = diff({ id: "blank-row", identity_title: "" });
  const nul = diff({ id: "null-row", identity_title: null });
  assert.notEqual(groupIdentityKey(blank), groupIdentityKey(nul));

  const a = diff({ identity_channel: "a", identity_type: 'b","c', identity_title: "title" });
  const b = diff({ identity_channel: 'a","b', identity_type: "c", identity_title: "title" });
  assert.notEqual(groupIdentityKey(a), groupIdentityKey(b));
  assert.equal(groupDiffs([a, b]).length, 2);

  assert.equal(
    groupDiffs([diff({ identity_title: "" }), diff({ identity_title: "" })]).length,
    2,
    "incomplete anonymous identities must remain separate",
  );
  // Complete identical identities still merge into one work group.
  assert.equal(
    groupDiffs([
      diff({ identity_channel: "cmoa", identity_type: "WT", identity_title: "作品A" }),
      diff({ identity_channel: "cmoa", identity_type: "WT", identity_title: "作品A" }),
    ]).length,
    1,
  );
}

{
  // Category summary keeps a fixed severity order and drops absent categories.
  const diffs = [
    diff({ category: "formula", field: "fee_jpy" }),
    diff({ category: "missing" }),
    diff({ category: "field", field: "rs" }),
  ];
  assert.deepEqual(groupCategories(diffs), ["missing", "field", "formula"]);
}

{
  // Count label: unique value fields, plus missing/extra row counts, KO/JA.
  const diffs = [
    diff({ category: "missing" }),
    diff({ category: "extra" }),
    diff({ category: "field", field: "fee_jpy" }),
    diff({ category: "field", field: "fee_jpy" }),
    diff({ category: "formula", field: "rs" }),
  ];
  const counts = groupCounts(diffs);
  assert.deepEqual(counts, { missing: 1, extra: 1, valueDiffs: 3, valueFieldCount: 2 });
  assert.equal(groupCountsLabel(counts, ko), "시스템 누락 1행 · 시스템 추가 1행 · 값 차이 2개 항목");
  assert.equal(
    groupCountsLabel(counts, (_koText, jaText) => jaText),
    "システム欠落1行 · システム追加1行 · 値の差2項目",
  );
  assert.equal(groupCountsLabel(groupCounts([diff({ category: "missing" })]), ko), "시스템 누락 1행");
}

{
  // Difference column text: signed numeric delta (system - human) or concise fallback.
  assert.equal(differenceText(diff({ candidate_value: 1200, golden_value: 1000 }), ko), "+200");
  assert.equal(differenceText(diff({ candidate_value: 800, golden_value: 1000 }), ko), "-200");
  assert.equal(
    differenceText(
      diff({
        category: "formula",
        candidate_value: JSON.stringify({ state: "formula", formula: "U2*0.1", value: 120 }),
        golden_value: JSON.stringify({ state: "value", value: 100 }),
      }),
      ko,
    ),
    "+20",
  );
  assert.equal(
    differenceText(diff({ category: "formula", candidate_value: { state: "blank" }, golden_value: 100 }), ko),
    "수식/상태 다름",
  );
  assert.equal(differenceText(diff({ candidate_value: "作品B", golden_value: "作品A" }), ko), "내용 다름");
  assert.equal(differenceText(diff({ category: "missing" }), ko), "시스템에 행 없음");
  assert.equal(differenceText(diff({ category: "extra" }), ko), "사람 작업본에 행 없음");
}

{
  // Aligned rows for a missing row: human side present, system side explicitly absent.
  const human = displayValue(
    { row: 3, cells: { unique_identifier: "row-3", total_amount_jpy: 1200, fee_jpy: { formula: "U3*0.1", value: 120 } } },
    ko,
  );
  const system = displayValue(null, ko, true);
  const table = alignedRowTable(human, system);
  assert.equal(system.absent, true);
  assert.equal(table.rows.length, 3);
  assert.equal(table.hiddenCount, 0);
  assert.equal(table.rows[0].field, "unique_identifier", "priority order must carry into aligned rows");
  assert.deepEqual(table.rows.map((row) => row.system), [null, null, null]);
  const fee = table.rows.find((row) => row.field === "fee_jpy");
  assert.equal(fee?.human?.text, "120");
  assert.equal(fee?.human?.formula, "U3*0.1");
  assert.equal(fee?.label, "수수료 JPY");
}

{
  // Aligned rows merge both sides by field; side-only fields keep the other side null.
  const human = displayValue({ row: 1, cells: { total_amount_jpy: 1000, note1: "사람 메모" } }, ko);
  const system = displayValue({ row: 1, cells: { total_amount_jpy: 1200, note2: "시스템 메모" } }, ko);
  const table = alignedRowTable(human, system);
  assert.deepEqual(table.rows.map((row) => row.field), ["total_amount_jpy", "note1", "note2"]);
  assert.equal(table.rows[0].human?.text, "1,000");
  assert.equal(table.rows[0].system?.text, "1,200");
  assert.equal(table.rows[1].system, null);
  assert.equal(table.rows[2].human, null);
}

{
  // Aligned rows stay bounded and report the hidden remainder.
  const manyCells = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`extra_field_${String(i).padStart(2, "0")}`, i]));
  const human = displayValue({ row: 1, cells: manyCells }, ko);
  const system = displayValue(null, ko, true);
  const table = alignedRowTable(human, system);
  assert.equal(table.rows.length, MAX_ALIGNED_ROWS);
  assert.equal(table.hiddenCount, 10);
}

{
  // Value-diff view filter is only offered when the current page is the complete set.
  assert.equal(canApplyValueViewFilter({ category: "", offset: 0, totalDiffs: 91, pageSize: 100 }), true);
  assert.equal(canApplyValueViewFilter({ category: "", offset: 0, totalDiffs: 101, pageSize: 100 }), false);
  assert.equal(canApplyValueViewFilter({ category: "", offset: 100, totalDiffs: 91, pageSize: 100 }), false);
  assert.equal(canApplyValueViewFilter({ category: "field", offset: 0, totalDiffs: 12, pageSize: 100 }), false);
  assert.equal(isValueDiffCategory("field"), true);
  assert.equal(isValueDiffCategory("formula"), true);
  assert.equal(isValueDiffCategory("missing"), false);
  assert.equal(isValueDiffCategory("extra"), false);
}

console.log("settlement comparison presentation assertions passed");
