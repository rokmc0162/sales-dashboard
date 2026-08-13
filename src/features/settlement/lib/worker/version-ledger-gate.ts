import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import type { SupabaseClient } from "@supabase/supabase-js";
import type postgres from "postgres";
import ExcelJS from "exceljs";


import {
  loadCarryForwardBaselineRowsFromBuffer,
  mergeCarryForwardRows,
} from "../export/input-v2-carry-forward";
import {
  ELECTRONIC_COL,
  INPUT_V2_FIRST_DATA_ROW,
  PUBLICATION_COL,
  type InputV2FillResult,
} from "../export/input-v2-filler";
import { carryBaselineStoragePath, previousSettlementMonth } from "../export/load-input-v2-records";
import type { Database } from "../supabase/types";
import type { LocalParseStageResult } from "./local-parse-stage";

const MAX_WORKBOOK_BYTES = 10_000_000;
const SHA256_RE = /^[0-9a-f]{64}$/;
const require = createRequire(import.meta.url);
const { slideFormula } = require("exceljs/lib/utils/shared-formula") as {
  slideFormula(formula: string, fromCell: string, toCell: string): string;
};

export class HistoricalLedgerError extends Error {
  constructor() {
    super("HISTORICAL_LEDGER_FAILED");
    this.name = "HistoricalLedgerError";
  }
}

export type HistoricalLedgerBaseline = {
  publicationId: string | null;
  month: string;
  sha256: string;
  bytes: Buffer;
};

export interface HistoricalLedgerStore {
  loadPrior(jobId: string, settlementMonth: string): Promise<HistoricalLedgerBaseline | null>;
}

type BaselineStorageClient = {
  storage: {
    from(bucket: string): {
      download(path: string): Promise<{ data: Blob | null; error: { message?: string } | null }>;
    };
  };
};

function fail(): never { throw new HistoricalLedgerError(); }
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function scalarCellValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined || typeof value === "string"
      || typeof value === "number" || typeof value === "boolean") return value ?? null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return String(value);
  if ("formula" in value || "sharedFormula" in value) {
    return {
      formula: typeof value.formula === "string" ? value.formula : null,
      sharedFormula: typeof (value as { sharedFormula?: unknown }).sharedFormula === "string"
        ? (value as { sharedFormula: string }).sharedFormula : null,
      result: "result" in value ? scalarCellValue(value.result as ExcelJS.CellValue) : null,
    };
  }
  if ("error" in value) return { error: String(value.error) };
  if ("richText" in value && Array.isArray(value.richText)) {
    return { richText: value.richText.map((part) => part.text).join("") };
  }
  if ("hyperlink" in value) return { text: String(value.text ?? ""), hyperlink: String(value.hyperlink ?? "") };
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function cellHasFormulaError(cell: ExcelJS.Cell): boolean {
  const value = cell.value;
  if (!value || typeof value !== "object") return false;
  if ("error" in value) return true;
  if ("formula" in value || "sharedFormula" in value) {
    const result = (value as { result?: unknown }).result;
    return !!result && typeof result === "object" && "error" in result;
  }
  return false;
}

function effectiveFormula(cell: ExcelJS.Cell): string | null {
  const value = cell.value;
  if (!value || typeof value !== "object") return null;
  if ("formula" in value && typeof value.formula === "string") return value.formula;
  if (!("sharedFormula" in value) || typeof value.sharedFormula !== "string") return null;
  const masterValue = cell.worksheet.getCell(value.sharedFormula).value;
  if (!masterValue || typeof masterValue !== "object" || !("formula" in masterValue)
      || typeof masterValue.formula !== "string") return null;
  return slideFormula(masterValue.formula, value.sharedFormula, cell.address);
}

function strictCellSnapshot(cell: ExcelJS.Cell): unknown {
  const value = cell.value;
  if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) {
    const formulaValue = value as { formula?: unknown; sharedFormula?: unknown; result?: unknown };
    return {
      formula: typeof formulaValue.formula === "string" ? formulaValue.formula : null,
      sharedFormula: typeof formulaValue.sharedFormula === "string" ? formulaValue.sharedFormula : null,
      effectiveFormula: effectiveFormula(cell),
      result: "result" in formulaValue ? scalarCellValue(formulaValue.result as ExcelJS.CellValue) : null,
    };
  }
  return scalarCellValue(value);
}

function numericOnly(text: string): boolean {
  return /^[+-]?(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?(?:e[+-]?\d+)?$/i
    .test(text.normalize("NFKC").trim());
}

function displayedText(cell: ExcelJS.Cell): string {
  const value = scalarCellValue(cell.value);
  if (value && typeof value === "object" && "result" in value) return String(value.result ?? "").normalize("NFKC").trim();
  if (value && typeof value === "object" && "richText" in value) return String(value.richText ?? "").normalize("NFKC").trim();
  return typeof value === "string" || typeof value === "number" ? String(value).normalize("NFKC").trim() : "";
}

async function strictWorkbookSnapshot(buffer: Buffer, expected: InputV2FillResult): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheets = workbook.worksheets.map((sheet) => {
    const cells: Array<[string, unknown]> = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const snapshot = strictCellSnapshot(cell);
        if (cellHasFormulaError(cell)) fail();
        if (snapshot !== null) cells.push([cell.address, snapshot]);
      });
    });
    return {
      name: sheet.name,
      state: sheet.state,
      actualRows: sheet.actualRowCount,
      actualColumns: sheet.actualColumnCount,
      rows: sheet.rowCount,
      columns: sheet.columnCount,
      cells,
    };
  });
  const identityChecks = [
    { name: expected.electronic_sheet, rows: expected.electronic_rows, columns: ELECTRONIC_COL },
    { name: expected.publication_sheet, rows: expected.publication_rows, columns: PUBLICATION_COL },
  ];
  for (const check of identityChecks) {
    if (check.rows === 0) continue;
    const sheet = workbook.getWorksheet(check.name);
    if (!sheet) fail();
    for (let offset = 0; offset < check.rows; offset += 1) {
      const row = sheet.getRow(INPUT_V2_FIRST_DATA_ROW + offset);
      const channel = displayedText(row.getCell(check.columns.channel));
      const primaryTitle = displayedText(row.getCell(check.columns.channel_title_jp));
      const fallbackTitle = displayedText(row.getCell(check.columns.title_jp));
      const title = primaryTitle || fallbackTitle;
      if (!channel || !title || numericOnly(title) || (primaryTitle && numericOnly(primaryTitle))) fail();
    }
  }
  return JSON.stringify(sheets);
}

const CIVIL_DATE_FIELDS = new Set([
  "launch_date", "sales_month", "month", "accounting_month", "settlement_month",
  "settlement_batch", "statement_received", "deposit_month", "period_start", "period_end",
  "payment_date", "invoice_date",
]);

function jsonSafeLedgerValue(value: unknown, key = ""): unknown {
  if (value instanceof Date) {
    const civil = CIVIL_DATE_FIELDS.has(key) && value.getUTCHours() === 15
      ? new Date(value.getTime() + 9 * 60 * 60 * 1000)
      : value;
    return CIVIL_DATE_FIELDS.has(key) ? civil.toISOString().slice(0, 10) : civil.toISOString();
  }
  if (Array.isArray(value)) return value.map((item) => jsonSafeLedgerValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([childKey, item]) => [childKey, jsonSafeLedgerValue(item, childKey)]),
    );
  }
  return value;
}

function jsonSafeLedgerRecords(records: Record<string, unknown>[]): Record<string, unknown>[] {
  return records.map((record) => jsonSafeLedgerValue(record) as Record<string, unknown>);
}

export async function loadPrivateHistoricalBaseline(
  settlementMonth: string,
  supabase: BaselineStorageClient,
): Promise<HistoricalLedgerBaseline | null> {
  const prior = previousSettlementMonth(settlementMonth.slice(0, 7).replace("-", ""));
  if (!prior) return null;
  const priorIso = `${prior.slice(0, 4)}-${prior.slice(4, 6)}-01`;
  try {
    const { data, error } = await supabase.storage
      .from("upload-debug")
      .download(carryBaselineStoragePath(prior));
    if (error || !data || data.size < 1 || data.size > MAX_WORKBOOK_BYTES) return null;
    const bytes = Buffer.from(await data.arrayBuffer());
    if (bytes.byteLength !== data.size) return null;
    const rows = await loadCarryForwardBaselineRowsFromBuffer(bytes, prior);
    if (rows.length < 1) return null;
    return { publicationId: null, month: priorIso, sha256: sha256(bytes), bytes };
  } catch {
    return null;
  }
}

function sourceRecords(stage: LocalParseStageResult): Record<string, unknown>[] {
  return stage.salesRows
    .slice()
    .sort((a, b) => a.position - b.position || a.sourceOrdinal - b.sourceOrdinal || a.objectId.localeCompare(b.objectId))
    .map((row) => ({ ...row.record } as Record<string, unknown>))
    .filter((record) => !String(record.note2 ?? "").includes("SUMMARY_NON_AGGREGATED"));
}

export async function prepareHistoricalLedgerRecords(input: {
  stage: LocalParseStageResult;
  baseline: HistoricalLedgerBaseline;
}): Promise<{ records: Record<string, unknown>[]; priorPublicationId: string | null; priorSha256: string }> {
  const bytes = Buffer.from(input.baseline.bytes);
  if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(input.stage.settlementMonth)
      || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(input.baseline.month)
      || bytes.byteLength < 1 || bytes.byteLength > MAX_WORKBOOK_BYTES
      || !SHA256_RE.test(input.baseline.sha256) || sha256(bytes) !== input.baseline.sha256) fail();
  const expectedPrior = previousSettlementMonth(input.stage.settlementMonth.slice(0, 7).replace("-", ""));
  if (!expectedPrior || input.baseline.month.slice(0, 7).replace("-", "") !== expectedPrior) fail();
  let baselineRows: Record<string, unknown>[];
  try { baselineRows = await loadCarryForwardBaselineRowsFromBuffer(bytes, expectedPrior); } catch { fail(); }
  if (baselineRows.length < 1) fail();
  const merged = mergeCarryForwardRows(
    baselineRows,
    sourceRecords(input.stage),
    input.stage.settlementMonth.slice(0, 7).replace("-", ""),
  );
  if (merged.records.length < 1) fail();
  return {
    // ExcelJS baseline cells and carry cadence rules use Date objects. The
    // immutable artifact boundary intentionally accepts JSON values only, so
    // preserve their civil date while removing the runtime object identity.
    records: jsonSafeLedgerRecords(merged.records),
    priorPublicationId: input.baseline.publicationId,
    priorSha256: input.baseline.sha256,
  };
}

export async function validateHistoricalLedgerWorkbook(input: {
  candidate: Buffer;
  month: string;
  records: Record<string, unknown>[];
  fillWorkbook(args: { month: string; records: Record<string, unknown>[] }): Promise<InputV2FillResult>;
  recalculateWorkbook(buffer: Buffer): Promise<Buffer>;
}): Promise<void> {
  if (!/^\d{6}$/.test(input.month) || !Array.isArray(input.records) || input.records.length < 1
      || !Buffer.isBuffer(input.candidate) || input.candidate.byteLength < 1
      || input.candidate.byteLength > MAX_WORKBOOK_BYTES) fail();
  let expected: InputV2FillResult;
  try { expected = await input.fillWorkbook({ month: input.month, records: input.records.map((row) => ({ ...row })) }); }
  catch { fail(); }
  if (expected.rows_written !== input.records.length) fail();
  try {
    const recalculatedExpected = await input.recalculateWorkbook(Buffer.from(expected.buffer));
    if (!Buffer.isBuffer(recalculatedExpected) || recalculatedExpected.byteLength < 1
        || recalculatedExpected.byteLength > MAX_WORKBOOK_BYTES) fail();
    const [candidateSnapshot, expectedSnapshot] = await Promise.all([
      strictWorkbookSnapshot(Buffer.from(input.candidate), expected),
      strictWorkbookSnapshot(Buffer.from(recalculatedExpected), expected),
    ]);
    if (candidateSnapshot !== expectedSnapshot) fail();
  } catch (error) {
    if (error instanceof HistoricalLedgerError) throw error;
    fail();
  }
}

type Sql = postgres.Sql;
type PublicationRow = {
  id: string;
  month: string | Date;
  artifact_bucket: string;
  artifact_path: string;
  artifact_sha256: string;
  artifact_size_bytes: number | string;
};

export function createHistoricalLedgerStore(
  sql: Sql,
  supabase: SupabaseClient<Database>,
): HistoricalLedgerStore {
  return {
    async loadPrior(jobId, settlementMonth) {
      const prior = previousSettlementMonth(settlementMonth.slice(0, 7).replace("-", ""));
      if (!prior) return null;
      const priorIso = `${prior.slice(0, 4)}-${prior.slice(4, 6)}-01`;
      const rows = await sql<PublicationRow[]>`
        select p.id, p.month, p.artifact_bucket, p.artifact_path,
               p.artifact_sha256, p.artifact_size_bytes
          from public.settlement_jobs j
          join public.settlement_month_current c on c.month = ${priorIso}::date
          join public.settlement_publications p on p.id = c.publication_id
         where j.id = ${jobId}::uuid
           and j.month = ${settlementMonth}::date
           and p.month = ${priorIso}::date
         limit 1`;
      const row = rows[0];
      if (!row) return loadPrivateHistoricalBaseline(settlementMonth, supabase);
      if (!SHA256_RE.test(row.artifact_sha256)) return null;
      const expectedSize = Number(row.artifact_size_bytes);
      if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > MAX_WORKBOOK_BYTES) return null;
      const { data, error } = await supabase.storage.from(row.artifact_bucket).download(row.artifact_path);
      if (error || !data || data.size !== expectedSize) return null;
      const bytes = Buffer.from(await data.arrayBuffer());
      if (bytes.byteLength !== expectedSize || sha256(bytes) !== row.artifact_sha256) return null;
      return { publicationId: row.id, month: priorIso, sha256: row.artifact_sha256, bytes };
    },
  };
}
