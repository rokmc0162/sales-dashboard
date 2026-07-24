/**
 * Lightweight display assertions for settlement comparison findings.
 * Run: node --import tsx scripts/test-settlement-comparison-display.ts
 */
import assert from "node:assert/strict";

import {
  categorySentence,
  displayValue,
  fieldLabel,
  numericDeltaText,
} from "../src/features/settlement/lib/comparison/display";

const ko = (koText: string) => koText;

{
  const digest = {
    row: 42,
    cells: {
      unique_identifier: "row-42",
      channel_title: "作品A",
      note2: "뒤쪽 메모",
      total_amount_jpy: 1200,
      channel_title_jp: "作品A",
      fee_jpy: { formula: "U42*0.1", value: 120 },
      before_tax_jpy: 1080,
      after_tax_jpy: 1068,
      tax_jpy: 12,
      rs: 0.55,
      clients: "cmoa",
      after_tax_income_jpy: 580,
      before_tax_income_jpy: 600,
      withholding_tax_jpy: 8,
      settlement_month: "2026-05",
      deposit_month: "2026-07",
      sales_month: "2026-04",
      channel: "cmoa",
      type: "WT",
      title_jp: "作品A 原題",
      title_kr: "작품A",
      month: "2026-05",
      launch_date: "2024-01-15",
      statement_received: "2026-06-10",
      company: "RVJP",
      country: "JP",
      settlement_currency: "JPY",
      vehicle_currency: "KRW",
      exchange_rate: 9.1,
      note1: "숨겨질 가능성이 있는 메모",
      updated: "2026-07-01",
      recoder: "system",
    },
  };
  const rendered = displayValue(digest, ko);
  assert.equal(rendered.absent, false);
  assert.equal(rendered.cells.length, 20, "row digest must be bounded");
  assert.ok(rendered.hiddenCellCount > 0, "hidden count must be reported when cells exceed cap");
  assert.equal(rendered.cells[0]?.field, "unique_identifier", "meaningful identity cells should come first");
  assert.ok(rendered.cells.some((cell) => cell.field === "channel_title_jp" && cell.text === "作品A"));
  assert.ok(rendered.cells.some((cell) => cell.field === "channel" && cell.text === "cmoa"));
  assert.ok(rendered.cells.some((cell) => cell.field === "type" && cell.text === "WT"));
  assert.ok(rendered.cells.some((cell) => cell.field === "clients" && cell.text === "cmoa"));
  assert.ok(rendered.cells.some((cell) => cell.field === "total_amount_jpy" && cell.text === "1,200"));
  assert.ok(rendered.cells.some((cell) => cell.field === "fee_jpy" && cell.text === "120" && cell.formula === "U42*0.1"));
  assert.ok(rendered.cells.some((cell) => cell.field === "before_tax_jpy" && cell.text === "1,080"));
  assert.ok(rendered.cells.some((cell) => cell.field === "after_tax_jpy" && cell.text === "1,068"));
  assert.ok(rendered.cells.some((cell) => cell.field === "rs" && cell.text === "0.55"));
  assert.ok(rendered.cells.some((cell) => cell.field === "before_tax_income_jpy" && cell.text === "600"));
  assert.ok(rendered.cells.some((cell) => cell.field === "withholding_tax_jpy" && cell.text === "8"));
  assert.ok(rendered.cells.some((cell) => cell.field === "tax_jpy" && cell.text === "12"));
  assert.ok(rendered.cells.some((cell) => cell.field === "sales_month" && cell.text === "2026-04"));
  assert.ok(rendered.cells.some((cell) => cell.field === "settlement_month" && cell.text === "2026-05"));
  assert.ok(rendered.cells.some((cell) => cell.field === "deposit_month" && cell.text === "2026-07"));
  assert.ok(!rendered.cells.some((cell) => cell.field === "note1"), "secondary metadata should yield to higher-value cells");
}

{
  const absent = displayValue(null, ko, true);
  assert.equal(absent.text, "이 행이 없습니다");
  assert.equal(absent.absent, true);

  const formulaValue = displayValue({ state: "formula", formula: "U1*0.1", value: 120 }, ko);
  assert.equal(formulaValue.text, "120");
  assert.equal(formulaValue.formula, "U1*0.1");

  const serializedValue = displayValue(JSON.stringify({ state: "value", value: "정상 값" }), ko);
  assert.equal(serializedValue.text, "정상 값");
  assert.equal(serializedValue.formula, undefined);

  const serializedFormula = displayValue(JSON.stringify({ state: "formula", formula: "U1*0.1", value: 120 }), ko);
  assert.equal(serializedFormula.text, "120");
  assert.equal(serializedFormula.formula, "U1*0.1");
}

{
  const serializedDigest = displayValue(
    JSON.stringify({
      row: 7,
      cells: {
        unique_identifier: "row-7",
        channel_title_jp: "作品B",
        fee_jpy: { state: "formula", formula: "U7*0.1", value: 70 },
        note1: "보조 메모",
      },
    }),
    ko,
  );
  assert.equal(serializedDigest.text, "행의 주요 셀");
  assert.ok(serializedDigest.cells.some((cell) => cell.field === "unique_identifier" && cell.text === "row-7"));
  assert.ok(serializedDigest.cells.some((cell) => cell.field === "channel_title_jp" && cell.text === "作品B"));
  assert.ok(serializedDigest.cells.some((cell) => cell.field === "fee_jpy" && cell.text === "70" && cell.formula === "U7*0.1"));
}

{
  const braceText = displayValue("{keep this literal text}", ko);
  assert.equal(braceText.text, "{keep this literal text}");

  const oversized = `{${"x".repeat(4_100)}}`;
  const oversizedValue = displayValue(oversized, ko);
  assert.equal(oversizedValue.text, `${oversized.slice(0, 89)}…`);
}

{
  assert.equal(fieldLabel("before_tax_income_jpy", ko), "세전 수익 JPY");
  assert.equal(fieldLabel("unknown_internal_name", ko), "Unknown Internal Name");
}

{
  assert.equal(numericDeltaText(1250, 1000, ko), "시스템-사람 +250");
  assert.equal(numericDeltaText({ state: "value", value: 800 }, { state: "value", value: 1000 }, ko), "시스템-사람 -200");
  assert.equal(
    numericDeltaText(
      JSON.stringify({ state: "formula", formula: "U2*0.1", value: 120 }),
      JSON.stringify({ state: "value", value: 100 }),
      ko,
    ),
    "시스템-사람 +20",
  );
}

{
  const missing = categorySentence(
    { category: "missing", field: null, candidate_value: null, golden_value: { row: 1, cells: {} } },
    ko,
  );
  assert.equal(missing, "사람 작업본에는 이 행이 있지만 시스템 정리본에는 없습니다.");

  const extra = categorySentence(
    { category: "extra", field: null, candidate_value: { row: 1, cells: {} }, golden_value: null },
    ko,
  );
  assert.equal(extra, "시스템 정리본에는 이 행이 있지만 사람 작업본에는 없습니다.");

  const field = categorySentence(
    { category: "field", field: "total_amount_jpy", candidate_value: 1200, golden_value: 1000 },
    ko,
  );
  assert.equal(field, "총액 JPY: 사람 작업본 1,000 → 시스템 정리본 1,200 (시스템-사람 +200)");

  const formula = categorySentence(
    {
      category: "formula",
      field: "fee_jpy",
      candidate_value: { state: "formula", formula: "U1*0.1", value: 120 },
      golden_value: { state: "value", value: 100 },
    },
    ko,
  );
  assert.match(formula, /수수료 JPY의 상태 또는 수식이 다릅니다/);

  const serializedField = categorySentence(
    {
      category: "field",
      field: "channel_title_jp",
      candidate_value: JSON.stringify({ state: "value", value: "作品B" }),
      golden_value: JSON.stringify({ state: "value", value: "作品A" }),
    },
    ko,
  );
  assert.equal(serializedField, "채널 작품명: 사람 작업본 作品A → 시스템 정리본 作品B");
}

console.log("settlement comparison display assertions passed");
