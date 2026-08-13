import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";

import { fillInputV2Template } from "../src/features/settlement/lib/export/input-v2-filler";
import type { LocalParseStageResult } from "../src/features/settlement/lib/worker/local-parse-stage";
import {
  HistoricalLedgerError,
  loadPrivateHistoricalBaseline,
  prepareHistoricalLedgerRecords,
  validateHistoricalLedgerWorkbook,
} from "../src/features/settlement/lib/worker/version-ledger-gate";

function record(title: string, amount: number): Record<string, unknown> {
  return {
    company: "RJ", clients: "合成取引先", channel: "synthetic", channel_title_jp: title,
    title_jp: title, title_kr: `KR-${title}`, type: "WT", distribution_strategy: "non-ex",
    country: "JP", settlement_currency: "JPY", vehicle_currency: "KRW",
    sales_month: "2026-06-01", settlement_month: "2026-06-30", settlement_batch: "2026-06-01",
    total_amount_jpy: amount, fee_jpy: 0, before_tax_jpy: amount, after_tax_jpy: amount,
    rs_rate: 0.5, before_tax_income_jpy: amount, withholding_tax_jpy: 0,
    consumption_tax_jpy: 0, after_tax_income_jpy_a: amount,
  };
}
function stage(rows: Record<string, unknown>[]): LocalParseStageResult {
  return {
    schemaVersion: 1, settlementMonth: "2026-07-01", files: [], rawRows: [],
    salesRows: rows.map((row, index) => ({ objectId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, position: index, sourceOrdinal: 0, record: row as never })),
    counts: { files: 0, rawRows: 0, salesRows: rows.length, summaryFiles: 0 }, digest: "a".repeat(64),
  };
}
async function rejects(run: () => Promise<unknown>) {
  await assert.rejects(run, (error: unknown) => error instanceof HistoricalLedgerError && error.message === "HISTORICAL_LEDGER_FAILED");
}
async function mutateWorkbook(buffer: Buffer, mutate: (workbook: ExcelJS.Workbook) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  mutate(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
async function main() {
  const [atomicSql, provenanceSql] = await Promise.all([
    readFile("supabase/migrations/034_settlement_atomic_publications.sql", "utf8"),
    readFile("supabase/migrations/036_settlement_historical_ledger_provenance.sql", "utf8"),
  ]);
  assert.match(atomicSql, /'settlement_publication:'\s*\|\|\s*v_intake\.month_key/);
  assert.match(provenanceSql, /'settlement_publication:'\s*\|\|\s*pg_catalog\.to_char\(v_run\.baseline_month,\s*'YYYYMM'\)/);
  assert.match(provenanceSql, /where c\.month = v_run\.baseline_month for update of c/);
  assert.match(provenanceSql, /elsif found then\s+raise exception 'settlement private baseline is no longer authoritative'/);
  assert.match(provenanceSql, /create or replace function public\.mark_settlement_processing_run_workbook_ready\([\s\S]*?p_office_row_count integer[\s\S]*?as 'select false'/);
  const priorRows = [record("作品A", 0), record("作品B", 0)];
  const prior = await fillInputV2Template({ month: "202606", records: priorRows });
  const bytes = Buffer.from(prior.buffer);
  const baseline = { publicationId: "00000000-0000-4000-8000-000000000001", month: "2026-06-01", sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
  const seen: string[] = [];
  const storage = {
    storage: {
      from: (bucket: string) => ({
        download: async (path: string) => {
          assert.equal(bucket, "upload-debug");
          seen.push(path);
          return { data: new Blob([new Uint8Array(bytes)]), error: null };
        },
      }),
    },
  };
  const privateBaseline = await loadPrivateHistoricalBaseline("2026-07-01", storage);
  assert.ok(privateBaseline, "valid private prior ledger is accepted");
  assert.deepEqual(seen, ["settlement-baselines/202606/input-jp-fin.xlsx"]);
  assert.equal(privateBaseline.month, "2026-06-01");
  assert.equal(privateBaseline.publicationId, null);
  assert.equal(privateBaseline.sha256, baseline.sha256);
  assert.equal(
    await loadPrivateHistoricalBaseline("2026-07-01", {
      storage: { from: () => ({ download: async () => ({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null }) }) },
    }),
    null,
    "unreadable private prior ledger fails closed",
  );
  const prepared = await prepareHistoricalLedgerRecords({ stage: stage([record("作品A", 100), record("作品C", 200)]), baseline });
  assert.equal(prepared.records.length, 3, "overlay + zero carry + append must reconstruct three rows");
  assert.equal(
    prepared.records.some((row) => Object.values(row).some((value) => value instanceof Date)),
    false,
    "prepared immutable ledger contains JSON-safe dates only",
  );
  const expected = await fillInputV2Template({ month: "202607", records: prepared.records });
  const validation = {
    month: "202607", records: prepared.records, fillWorkbook: fillInputV2Template,
    recalculateWorkbook: async (buffer: Buffer) => buffer,
  };
  await validateHistoricalLedgerWorkbook({ candidate: Buffer.from(expected.buffer), ...validation });
  const missing = await fillInputV2Template({ month: "202607", records: prepared.records.slice(0, -1) });
  await rejects(() => validateHistoricalLedgerWorkbook({ candidate: Buffer.from(missing.buffer), ...validation }));
  const electronic = expected.electronic_sheet;
  const forgedCompany = await mutateWorkbook(Buffer.from(expected.buffer), (workbook) => {
    workbook.getWorksheet(electronic)!.getCell("H6").value = "FORGED_COMPANY";
  });
  await rejects(() => validateHistoricalLedgerWorkbook({ candidate: forgedCompany, ...validation }));
  const forgedSubtotal = await mutateWorkbook(Buffer.from(expected.buffer), (workbook) => {
    workbook.getWorksheet(electronic)!.getCell("U1").value = { formula: "SUBTOTAL(9,U7:U7)", result: 999999 };
  });
  await rejects(() => validateHistoricalLedgerWorkbook({ candidate: forgedSubtotal, ...validation }));
  const forgedSparseSubtotal = await mutateWorkbook(Buffer.from(expected.buffer), (workbook) => {
    const cell = workbook.getWorksheet(electronic)!.getCell("BZ1");
    assert.equal(typeof cell.formula, "string", "synthetic workbook contains sparse BZ1 subtotal");
    cell.value = { formula: "SUBTOTAL(9,BZ999:BZ999)", result: 987654321 };
  });
  await rejects(() => validateHistoricalLedgerWorkbook({ candidate: forgedSparseSubtotal, ...validation }));
  const sparseFormulaError = await mutateWorkbook(Buffer.from(expected.buffer), (workbook) => {
    workbook.getWorksheet(electronic)!.getCell("BZ1").value = {
      formula: "SUBTOTAL(9,BZ6:BZ8)", result: { error: "#REF!" } as ExcelJS.CellErrorValue,
    };
  });
  await rejects(() => validateHistoricalLedgerWorkbook({
    candidate: sparseFormulaError,
    ...validation,
    fillWorkbook: async () => ({ ...expected, buffer: sparseFormulaError }),
  }));
  const forgedCachedResult = await mutateWorkbook(Buffer.from(expected.buffer), (workbook) => {
    const sheet = workbook.getWorksheet(electronic)!;
    let changed = false;
    sheet.eachRow((row) => row.eachCell((cell) => {
      if (changed || !cell.formula) return;
      cell.value = { formula: cell.formula, result: 987654321 };
      changed = true;
    }));
    assert.equal(changed, true, "synthetic workbook contains a formula result to forge");
  });
  await rejects(() => validateHistoricalLedgerWorkbook({ candidate: forgedCachedResult, ...validation }));
  const sharedExpected = await mutateWorkbook(Buffer.from(expected.buffer), (workbook) => {
    const sheet = workbook.addWorksheet("synthetic-shared-formula");
    sheet.fillFormula("A1:A3", "ROW()", [1, 2, 3]);
    sheet.fillFormula("B1:B3", "ROW()", [1, 2, 3]);
    sheet.state = "hidden";
  });
  const forgedSharedFormula = await mutateWorkbook(sharedExpected, (workbook) => {
    const sheet = workbook.getWorksheet("synthetic-shared-formula")!;
    const value = sheet.getCell("B2").value as { result?: unknown };
    const scalarResult = typeof value.result === "number" ? value.result : 0;
    sheet.getCell("B2").value = { sharedFormula: "A1", result: scalarResult };
  });
  await rejects(() => validateHistoricalLedgerWorkbook({
    candidate: forgedSharedFormula,
    ...validation,
    fillWorkbook: async () => ({ ...expected, buffer: sharedExpected }),
  }));
  const sameFormulaError = await mutateWorkbook(Buffer.from(expected.buffer), (workbook) => {
    workbook.getWorksheet(electronic)!.getCell("U1").value = {
      formula: "SUBTOTAL(9,U6:U8)", result: { error: "#REF!" } as ExcelJS.CellErrorValue,
    };
  });
  await rejects(() => validateHistoricalLedgerWorkbook({
    candidate: sameFormulaError,
    ...validation,
    fillWorkbook: async () => ({ ...expected, buffer: sameFormulaError }),
  }));
  const blankChannel = await mutateWorkbook(Buffer.from(expected.buffer), (workbook) => {
    workbook.getWorksheet(electronic)!.getCell("O6").value = "";
  });
  await rejects(() => validateHistoricalLedgerWorkbook({ candidate: blankChannel, ...validation }));
  const fullWidthNumeric = await mutateWorkbook(Buffer.from(expected.buffer), (workbook) => {
    workbook.getWorksheet(electronic)!.getCell("D6").value = "１２３";
    workbook.getWorksheet(electronic)!.getCell("F6").value = "１２３";
  });
  await rejects(() => validateHistoricalLedgerWorkbook({ candidate: fullWidthNumeric, ...validation }));
  await rejects(() => prepareHistoricalLedgerRecords({ stage: stage([record("作品A", 100)]), baseline: { ...baseline, sha256: "f".repeat(64) } }));
  await rejects(() => prepareHistoricalLedgerRecords({ stage: stage([record("作品A", 100)]), baseline: { ...baseline, month: "2026-05-01" } }));
  console.log("test-settlement-version-ledger-gate: all assertions passed");
}
void main();
