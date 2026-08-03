/**
 * Synthetic regression coverage for safe ExcelJS value extraction in the
 * carry-forward baseline reader and INPUT v2/v3 workbook filler.
 * Run: npm run test:input-v2-cell-values
 */
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import {
  cellValue,
  loadCarryForwardBaselineRowsFromBuffer,
} from "../src/features/settlement/lib/export/input-v2-carry-forward";
import { fillInputV2Template } from "../src/features/settlement/lib/export/input-v2-filler";

const FIRST_DATA_ROW = 6;
const BASELINE_SHEET = "input_電子_6月";

const formulaWithoutResult: ExcelJS.CellFormulaValue = { formula: "1+1" };
const sharedFormulaWithoutResult: ExcelJS.CellSharedFormulaValue = { sharedFormula: "A1" };
const hyperlink: ExcelJS.CellHyperlinkValue = {
  text: "Synthetic linked title",
  hyperlink: "https://example.test/title",
};
const richText: ExcelJS.CellRichTextValue = {
  richText: [{ text: "Synthetic " }, { text: "rich title" }],
};
const unsupported: ExcelJS.CellErrorValue = { error: "#VALUE!" };

async function buildBaselineWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(BASELINE_SHEET);
  for (let row = 1; row < FIRST_DATA_ROW; row += 1) {
    ws.getRow(row).getCell(1).value = `header ${row}`;
  }

  const row = ws.getRow(FIRST_DATA_ROW);
  row.getCell(2).value = richText;
  row.getCell(3).value = hyperlink;
  row.getCell(4).value = formulaWithoutResult;
  row.getCell(8).value = new Date("2026-01-02T00:00:00.000Z");
  row.getCell(15).value = "synthetic-channel";
  row.getCell(16).value = "synthetic-type";
  row.getCell(44).value = unsupported;
  row.getCell(45).value = { formula: "\"cached\"", result: "Cached formula text" };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function main() {
  assert.equal(cellValue(formulaWithoutResult), null, "formula without cached result is absent");
  assert.equal(
    cellValue(sharedFormulaWithoutResult),
    null,
    "shared formula without cached result is absent",
  );
  assert.equal(cellValue(hyperlink), "Synthetic linked title", "hyperlink uses display text");
  assert.equal(cellValue(richText), "Synthetic rich title", "rich text parts are joined");
  assert.equal(cellValue(unsupported), null, "unsupported ExcelJS object is absent");
  assert.equal(
    cellValue({ formula: "1+1", result: 2 }),
    2,
    "formula cached result is extracted recursively",
  );
  assert.equal(
    cellValue({ formula: "1/0", result: unsupported }),
    null,
    "formula with an unusable cached result is absent",
  );

  const baselineRows = await loadCarryForwardBaselineRowsFromBuffer(
    await buildBaselineWorkbook(),
  );
  assert.equal(baselineRows.length, 1, "synthetic baseline row is parsed");
  const [baseline] = baselineRows;
  assert.equal(baseline.channel_title_jp, "Synthetic rich title");
  assert.equal(baseline.title_kr, "Synthetic linked title");
  assert.equal(baseline.title_jp, null, "uncached baseline formula stays absent");
  assert.equal(baseline.note1, null, "unsupported baseline object stays absent");
  assert.equal(baseline.note2, "Cached formula text");
  assert.ok(baseline.launch_date instanceof Date, "baseline Date remains a Date");

  const channelTitle = "Synthetic fallback channel title";
  const result = await fillInputV2Template({
    month: "202606",
    records: [
      {
        unique_identifier: "synthetic-safe-values",
        channel_title_jp: {
          text: channelTitle,
          hyperlink: "https://example.test/fallback",
        } satisfies ExcelJS.CellHyperlinkValue,
        title_kr: unsupported,
        title_jp: sharedFormulaWithoutResult,
        clients: "synthetic-client",
        channel: "synthetic-channel",
        type: "synthetic-type",
        note1: richText,
        recoder: { unsupported: true },
      },
    ],
  });

  const generated = new ExcelJS.Workbook();
  await generated.xlsx.load(result.buffer as unknown as ExcelJS.Buffer);
  const ws = generated.getWorksheet(result.electronic_sheet);
  assert.ok(ws, `sheet ${result.electronic_sheet} exists in generated workbook`);
  const row = ws.getRow(FIRST_DATA_ROW);
  assert.equal(row.getCell(2).value, channelTitle, "channel title uses hyperlink text");
  assert.equal(row.getCell(3).value, channelTitle, "title_kr falls back to channel_title_jp");
  assert.equal(row.getCell(4).value, channelTitle, "title_jp falls back to channel_title_jp");
  assert.equal(row.getCell(45).value, "Synthetic rich title", "rich text is joined in output");
  assert.equal(row.getCell(6).value, null, "unsupported object is skipped in output");

  for (const sheet of generated.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (generatedRow) => {
      generatedRow.eachCell({ includeEmpty: false }, (cell) => {
        if (typeof cell.value !== "string") return;
        assert.ok(
          !cell.value.includes("[object Object]"),
          `literal [object Object] found in ${sheet.name}!${cell.address}`,
        );
      });
    });
  }

  console.log("OK: INPUT v2 safe ExcelJS cell-value regression passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
