/**
 * Privacy-safe synthetic checks for the July (202607) intake routing fixes.
 * Run: node --import tsx scripts/test-july-intake-parser-routing.ts
 *
 * Web intake passes folder-prefixed display paths (202607/…/file.xlsx), so
 * platform detection and the piccoma_gaiakuhan filename gates must match on
 * the basename. All fixtures are synthetic — no real titles or amounts.
 */
import assert from "node:assert/strict";

import * as XLSX from "xlsx";

import { parseFile } from "../src/features/settlement/lib/parsers/index";
import { parseMechacomic } from "../src/features/settlement/lib/parsers/mechacomic";
import { detectPlatform } from "../src/features/settlement/lib/parsers/registry";
import { parsePiccomaGaiakuhan } from "../src/features/settlement/lib/parsers/piccoma-gaiakuhan";

function xlsxBuffer(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { bookType: "xlsx", type: "buffer" });
}

const MG_XLSX_PATH = "202607/ピッコマ/【請求書】ピッコマ「Synthetic」MG（株式会社RIVERSE）.xlsx";
const MG_PDF_PATH = "202607/ピッコマ/【請求書】ピッコマ「Synthetic」MG（株式会社RIVERSE）.pdf";
const REPORT_PATH =
  "202607/ピッコマ外販/外販お支払報告書 202608 （2026年7月〆報告分）_株式会社RIVERSE_ver1.xlsx";

function checkRouting() {
  // Folder-prefixed display paths as passed by the web intake.
  const cases: Array<[string, string]> = [
    ["202607/めちゃコミック/RIVERSE_202607.xlsx", "mechacomic"],
    ["202607/集英社/260727_支払報告書（集英社）.PDF", "shueisha"],
    [MG_XLSX_PATH, "piccoma_gaiakuhan"],
    [MG_PDF_PATH, "piccoma_gaiakuhan"],
    [REPORT_PATH, "piccoma_gaiakuhan"],
  ];
  for (const [filename, expected] of cases) {
    const det = detectPlatform({ filename });
    assert.equal(det.platform_code, expected, `${filename} routes to ${expected}`);
    assert.equal(det.confidence >= 0.5, true, `${filename} stays above manual-review threshold`);
  }

  // Bare basenames (legacy inputs) keep routing unchanged.
  assert.equal(detectPlatform({ filename: "RIVERSE_202604.xlsx" }).platform_code, "mechacomic");
  assert.equal(
    detectPlatform({ filename: "12345_支払通知書（集英社）.pdf" }).platform_code,
    "shueisha",
    "historical 通知書 naming still routes to shueisha",
  );
  assert.equal(
    detectPlatform({ filename: "【請求書】ピッコマEPUB外販ロイヤリティー_202604_株式会社RIVERSE.xlsx" }).platform_code,
    "piccoma_gaiakuhan",
  );
  assert.equal(
    detectPlatform({ filename: "外販お支払報告書 202604 （2026年3月〆報告分）_RIVERSE_ver2.xlsx" }).platform_code,
    "piccoma_gaiakuhan",
  );
}

async function checkMgInvoiceXlsx() {
  // Shared RIVERSE invoice template: header block + №-grid + footer.
  const buffer = xlsxBuffer({
    請求書: [
      ["請求書"],
      ["件名：ピッコマ「Synthetic」MG（2026年7月度）"],
      ["お支払期限", "2026年8月末日"],
      ["御請求金額", 1100000],
      [],
      ["№", "内容", "単価", "印税率", "数量", "金額"],
      [1, "「Synthetic」MG", 1000000, "-", 1, 1000000],
      ["", "", "", "小計", "", 1000000],
      ["", "", "", "消費税額（10%）", "", 100000],
      ["", "", "", "合計金額", "", 1100000],
      ["お振込先：Synthetic Bank"],
    ],
  });

  const result = await parsePiccomaGaiakuhan({ filename: MG_XLSX_PATH, buffer });
  assert.equal(result.platform_code, "piccoma_gaiakuhan", "MG invoice stays piccoma_gaiakuhan");
  assert.equal(result.errors.length, 0, `MG invoice XLSX parses cleanly: ${result.errors.join("; ")}`);
  assert.equal(result.records.length, 1, "MG invoice XLSX yields exactly one detail row");
  assert.equal(result.sales_month, "2026-07-01", "MG invoice sales month comes from 件名");
  assert.equal(result.settlement_month, "2026-08-01", "MG invoice settlement month comes from お支払期限");

  const row = result.records[0].data;
  assert.equal(row.type, "MG", "MG invoice rows carry honest type MG");
  assert.equal(row.client_code, "piccoma", "MG invoice rows carry the piccoma client");
  assert.equal(row.channel_code, "piccoma_gaiakuhan", "MG invoice rows carry the gaiakuhan channel");
  assert.equal(row.after_tax_jpy, 1000000, "MG item 金額 is tax-exclusive");
  assert.equal(row.total_amount_jpy, 1100000, "MG total adds 10% consumption tax");
  assert.equal(row.consumption_tax_jpy, 100000, "MG consumption tax is the 10% delta");
  assert.equal(row.source_file_kind, "invoice_xlsx", "MG XLSX is the authoritative invoice detail");
  assert.equal(String(row.note1).includes("ピッコマMG請求書"), true, "MG context note is preserved");
}

async function checkMgInvoicePdf() {
  // A text-layer-free PDF stub: the point is that the MG PDF is routed to the
  // invoice-common summary path (never aggregated, never silently ignored).
  const result = await parsePiccomaGaiakuhan({
    filename: MG_PDF_PATH,
    buffer: Buffer.from("%PDF-1.4\n%%EOF"),
  });
  assert.equal(result.platform_code, "piccoma_gaiakuhan", "MG PDF stays piccoma_gaiakuhan");
  assert.equal(result.records.length, 0, "unreadable MG PDF emits no rows");
  assert.equal(
    result.errors.some((e) => e.includes("no extractable text layer")),
    true,
    "MG PDF goes through the invoice-common summary parser",
  );
  assert.equal(
    result.errors.some((e) => e.includes("PDF file ignored")),
    false,
    "MG PDF is no longer dropped by the blanket PDF-ignore gate",
  );
}

async function checkEpubInvoiceUnchanged() {
  const buffer = xlsxBuffer({ Sheet1: [["dummy"]] });
  for (const filename of [
    "【請求書】ピッコマEPUB外販ロイヤリティー_202607_株式会社RIVERSE.xlsx",
    "202607/ピッコマ外販/【請求書】ピッコマEPUB外販ロイヤリティー_202607_株式会社RIVERSE.xlsx",
  ]) {
    const result = await parsePiccomaGaiakuhan({ filename, buffer });
    assert.equal(result.records.length, 0, `EPUB invoice stays cross-check only (${filename})`);
    assert.equal(
      result.errors.some((e) => e.includes("cross-check")),
      true,
      `EPUB invoice keeps its cross-check notice (${filename})`,
    );
  }

  const pdf = await parsePiccomaGaiakuhan({
    filename: "202607/ピッコマ外販/ピッコマEPUB外販ロイヤリティー_202607.pdf",
    buffer: Buffer.from("%PDF-1.4\n%%EOF"),
  });
  assert.equal(pdf.records.length, 0, "EPUB 外販 PDF stays ignored");
  assert.equal(
    pdf.errors.some((e) => e.includes("PDF file ignored")),
    true,
    "EPUB 外販 PDF keeps the ignore notice",
  );
}

async function checkReportWithFolderPrefix() {
  const buffer = xlsxBuffer({
    "【巻】外販お支払報告書": [
      ["外販お支払報告書"],
      [],
      ["対象年月", "販売先", "発行元", "対象作品", "巻数", "受領額", "分配料率", "分配金"],
      ["2026/07", "Synthetic Store", "RIVERSE", "Synthetic Title", 1, 1000, 60, 600],
      ["", "", "", "", "", 1000, "合計", 600],
    ],
  });

  const result = await parsePiccomaGaiakuhan({ filename: REPORT_PATH, buffer });
  assert.equal(result.records.length, 1, "report emits one consolidated row per title");
  assert.equal(
    result.errors.length,
    0,
    `folder-prefixed report path is not a filename mismatch: ${result.errors.join("; ")}`,
  );
  assert.equal(result.sales_month, "2026-07-01", "sales month comes from 〆報告分, not the folder prefix");
  assert.equal(result.settlement_month, "2026-08-01", "settlement month follows by one month");

  const row = result.records[0].data;
  assert.equal(row.after_tax_jpy, 1000, "Σ受領額 per title");
  assert.equal(row.total_amount_jpy, 1100, "total adds 10%");
  assert.equal(row.after_tax_income_jpy, 600, "Σ分配金 per title");
  assert.equal(row.consumption_tax_jpy, 60, "income consumption tax is 10%");
  assert.equal(row.before_tax_income_jpy, 660, "before-tax income adds the tax back");
  assert.equal(row.rs_rate, 0.6, "分配料率 60 → 0.60");
}

async function checkMechacomicBasenameMonth() {
  const detail = [
    [], [], [],
    ["シリーズ名", "作家名", "書名", "区分", "売上金額", "率", "支払", "種別"],
    ["Synthetic", "", "", "", 10, 30, 3, "巻"],
  ];
  const buffer = xlsxBuffer({ "スマートフォン明細": detail, "アプリ明細": detail.slice(0, 4) });
  const result = await parseMechacomic({
    filename: "202608/めちゃコミック/RIVERSE_202607.xlsx",
    buffer,
  });
  assert.equal(result.errors.length, 0);
  assert.equal(result.sales_month, "2026-07-01", "Mechacomic month comes from basename, not folder prefix");
  assert.equal(result.settlement_month, "2026-08-31");
  assert.equal(result.records[0].data.deposit_month, "2026-09-30");
}

async function checkDispatcherAndNegativeMgNames() {
  const buffer = xlsxBuffer({
    請求書: [
      ["件名：ピッコマ「Synthetic」MG（2026年7月度）"],
      ["お支払期限", "2026年8月末日"],
      ["№", "内容", "単価", "印税率", "数量", "金額"],
      [1, "Synthetic MG", 100, "-", 1, 100],
      ["お振込先：Synthetic Bank"],
    ],
  });
  const dispatched = await parseFile({ filename: MG_XLSX_PATH, buffer });
  assert.equal(dispatched.platform_code, "piccoma_gaiakuhan");
  assert.equal(dispatched.records.length, 1, "real dispatcher reaches MG invoice detail parser");
  assert.equal(dispatched.records[0].data.type, "MG");

  for (const invalid of [
    "【請求書】ピッコマ「Synthetic」MG（別会社）.xlsx",
    "【請求書】ピッコマ「Synthetic」MG（株式会社RIVERSE）.csv",
    "【請求書】ピッコマ「」MG（株式会社RIVERSE）.xlsx",
    "COPY_【請求書】ピッコマ「Synthetic」MG（株式会社RIVERSE）.xlsx",
  ]) {
    assert.equal(detectPlatform({ filename: invalid }).platform_code, "unknown", `${invalid} is outside the MG contract`);
  }
}

async function main() {
  checkRouting();
  await checkMechacomicBasenameMonth();
  await checkDispatcherAndNegativeMgNames();
  await checkMgInvoiceXlsx();
  await checkMgInvoicePdf();
  await checkEpubInvoiceUnchanged();
  await checkReportWithFolderPrefix();
  console.log("test-july-intake-parser-routing: all assertions passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
