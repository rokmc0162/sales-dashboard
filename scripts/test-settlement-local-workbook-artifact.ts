import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import ExcelJS from "exceljs";
import JSZip from "jszip";

import { fillInputV2Template, type InputV2FillResult } from "../src/features/settlement/lib/export/input-v2-filler";
import type { SalesRecordInsert } from "../src/features/settlement/lib/supabase/types";
import {
  generateLocalWorkbookArtifact,
  LocalWorkbookArtifactError,
  verifyWorkbookWithLibreOffice,
  type LocalWorkbookArtifactErrorCode,
} from "../src/features/settlement/lib/worker/local-workbook-artifact";
import type { LocalParseStageResult } from "../src/features/settlement/lib/worker/local-parse-stage";
import { validateSettlementWorkbook, xlsxArchiveDigest } from "../src/features/settlement/lib/worker/run-job";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
}
function sha(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function record(note2: string | null, title: string): SalesRecordInsert {
  return {
    title_jp: title, note2, company: "SYN", sales_month: "2026-07-01",
    settlement_month: "2026-07-01", settlement_batch: "2026-07-01", country: "JP",
    type: "WT", distribution_strategy: "non-ex", settlement_currency: "JPY",
    vehicle_currency: "KRW", total_amount_jpy: 1, fee_jpy: 0, before_tax_jpy: 1,
    after_tax_jpy: 1, rs_rate: 1, before_tax_income_jpy: 1, withholding_tax_jpy: 0,
    consumption_tax_jpy: 0, after_tax_income_jpy_a: 1, mg_begin: 0, mg_increase: 0,
    mg_decrease: 0, mg_end: 0,
  } as SalesRecordInsert;
}
function stage(): LocalParseStageResult {
  const body = {
    schemaVersion: 1 as const,
    settlementMonth: "2026-07-01",
    files: [], rawRows: [],
    salesRows: [
      { objectId: "00000000-0000-4000-8000-000000000002", position: 2, sourceOrdinal: 0, record: record("SUMMARY_NON_AGGREGATED", "summary") },
      { objectId: "00000000-0000-4000-8000-000000000001", position: 0, sourceOrdinal: 1, record: record(null, "second") },
      { objectId: "00000000-0000-4000-8000-000000000001", position: 0, sourceOrdinal: 0, record: record(null, "first") },
    ],
    counts: { files: 0, rawRows: 0, salesRows: 3, summaryFiles: 0 },
  };
  return { ...body, digest: sha(Buffer.from(canonicalJson(body), "utf8")) };
}
async function workbookBuffer(first = "first", second = "second"): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("INPUT");
  sheet.addRow(["title"]);
  for (let row = 2; row < 6; row += 1) sheet.addRow([]);
  sheet.addRow([null, null, null, first]);
  sheet.addRow([null, null, null, second]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
async function workbookWithFormula(includeFormula: boolean): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("INPUT");
  for (let row = 1; row < 6; row += 1) sheet.addRow([]);
  sheet.addRow([null, null, null, "first"]);
  sheet.addRow([null, null, null, "second"]);
  if (includeFormula) {
    sheet.getCell("E6").value = { formula: "1+1", result: 2 };
    sheet.getCell("E7").value = { formula: "2+2", result: 4 };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
async function expectCode(run: () => Promise<unknown>, code: LocalWorkbookArtifactErrorCode): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof LocalWorkbookArtifactError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

async function main(): Promise<void> {
  const createdRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "local-workbook-artifact-"));
  const root = await fsp.realpath(createdRoot);
  await fsp.chmod(root, 0o700);
  try {
    const fixedBuffer = await workbookBuffer();
    const seen: Array<{ month: string; titles: string[] }> = [];
    const fillWorkbook = async ({ month, records }: { month: string; records: Record<string, unknown>[] }): Promise<InputV2FillResult> => {
      seen.push({ month, titles: records.map((item) => String(item.title_jp)) });
      return {
        buffer: fixedBuffer, fill_ms: 1, rows_written: records.length,
        electronic_rows: records.length, publication_rows: 0,
        electronic_sheet: "INPUT", publication_sheet: "INPUT_出版_7月",
        carry_rows: 0, overlay_rows: 0, append_rows: records.length, drop_rows: 0,
      };
    };
    const injectedOffice = async (...args: unknown[]) => {
      void args;
      return ({
        verifier: "injected" as const, version: "test", reopened: { sheetCount: 1, rowCount: 3 },
        archiveDigest: await xlsxArchiveDigest(fixedBuffer), verifiedWorkbook: Buffer.from(fixedBuffer),
      });
    };
    const deps = { stage: stage(), workRoot: root, runId: "run-1", fillWorkbook, validateWorkbook: validateSettlementWorkbook, archiveDigest: xlsxArchiveDigest, officeVerifier: injectedOffice };
    const first = await generateLocalWorkbookArtifact(deps);
    assert.equal(first.reused, false);
    assert.deepEqual(seen[0], { month: "202607", titles: ["first", "second"] }, "summary rows excluded and source order deterministic");
    assert.equal(first.evidence.detailRows, 2);
    assert.equal((await fsp.stat(first.artifactDir)).mode & 0o777, 0o700);
    assert.equal((await fsp.stat(first.candidatePath)).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(first.evidencePath)).mode & 0o777, 0o600);

    const replay = await generateLocalWorkbookArtifact(deps);
    assert.equal(replay.reused, true);
    assert.equal(replay.evidence.workbookSha256, first.evidence.workbookSha256);

    await fsp.rm(first.evidencePath);
    const resumedCandidateOnly = await generateLocalWorkbookArtifact(deps);
    assert.equal(resumedCandidateOnly.reused, true, "candidate-only crash residue is verified before evidence completion");
    assert.equal(resumedCandidateOnly.evidence.workbookArchiveDigest, first.evidence.workbookArchiveDigest);

    const concurrent = await Promise.all(Array.from({ length: 4 }, () => generateLocalWorkbookArtifact({ ...deps, runId: "run-race" })));
    assert.equal(new Set(concurrent.map((item) => item.evidence.workbookSha256)).size, 1, "concurrent writers converge on one candidate");

    const evidenceTamper = await generateLocalWorkbookArtifact({ ...deps, runId: "evidence-tamper" });
    const tamperedEvidence = JSON.parse(await fsp.readFile(evidenceTamper.evidencePath, "utf8")) as Record<string, unknown>;
    tamperedEvidence.detailRows = 999;
    await fsp.writeFile(evidenceTamper.evidencePath, JSON.stringify(tamperedEvidence));
    await expectCode(() => generateLocalWorkbookArtifact({ ...deps, runId: "evidence-tamper" }), "ARTIFACT_CHANGED");

    const officeTamper = await generateLocalWorkbookArtifact({ ...deps, runId: "office-tamper" });
    const officeEvidence = JSON.parse(await fsp.readFile(officeTamper.evidencePath, "utf8")) as { office: { version: string } };
    officeEvidence.office.version = "forged-valid-looking-version";
    await fsp.writeFile(officeTamper.evidencePath, JSON.stringify(officeEvidence));
    await expectCode(() => generateLocalWorkbookArtifact({ ...deps, runId: "office-tamper" }), "ARTIFACT_CHANGED");

    const officeFileTamper = await generateLocalWorkbookArtifact({ ...deps, runId: "office-file-tamper" });
    await fsp.writeFile(path.join(officeFileTamper.artifactDir, "office-verified.xlsx"), "changed");
    await expectCode(() => generateLocalWorkbookArtifact({ ...deps, runId: "office-file-tamper" }), "ARTIFACT_CHANGED");

    const coordinatedTamper = await generateLocalWorkbookArtifact({ ...deps, runId: "coordinated-tamper" });
    const forgedWorkbook = await workbookBuffer("forged-first", "forged-second");
    const forgedDigest = await xlsxArchiveDigest(forgedWorkbook);
    const forgedEvidence = JSON.parse(await fsp.readFile(coordinatedTamper.evidencePath, "utf8")) as {
      workbookSha256: string; workbookArchiveDigest: string; workbookSizeBytes: number;
      reopened: { sheetCount: number; rowCount: number };
      office: { archiveDigest: string; reopened: { sheetCount: number; rowCount: number } };
    };
    forgedEvidence.workbookSha256 = sha(forgedWorkbook);
    forgedEvidence.workbookArchiveDigest = forgedDigest;
    forgedEvidence.workbookSizeBytes = forgedWorkbook.byteLength;
    forgedEvidence.reopened = { sheetCount: 1, rowCount: 3 };
    forgedEvidence.office.archiveDigest = forgedDigest;
    forgedEvidence.office.reopened = { sheetCount: 1, rowCount: 3 };
    await fsp.writeFile(coordinatedTamper.candidatePath, forgedWorkbook);
    await fsp.writeFile(path.join(coordinatedTamper.artifactDir, "office-verified.xlsx"), forgedWorkbook);
    await fsp.writeFile(coordinatedTamper.evidencePath, JSON.stringify(forgedEvidence));
    await expectCode(() => generateLocalWorkbookArtifact({ ...deps, runId: "coordinated-tamper" }), "ARTIFACT_CHANGED");

    const raceArtifact = await generateLocalWorkbookArtifact({ ...deps, runId: "candidate-race" });
    await fsp.rm(raceArtifact.evidencePath);
    await expectCode(() => generateLocalWorkbookArtifact({
      ...deps,
      runId: "candidate-race",
      officeVerifier: async (args) => {
        await fsp.writeFile(raceArtifact.candidatePath, "changed-during-office");
        return injectedOffice(args);
      },
    }), "ARTIFACT_CHANGED");

    await fsp.writeFile(first.candidatePath, "changed");
    await expectCode(() => generateLocalWorkbookArtifact(deps), "ARTIFACT_CHANGED");

    await expectCode(() => generateLocalWorkbookArtifact({ ...deps, runId: "bad-row-count", fillWorkbook: async (input) => ({ ...await fillWorkbook(input), rows_written: 99 }) }), "WORKBOOK_FAILED");
    await expectCode(() => generateLocalWorkbookArtifact({ ...deps, runId: "bad-office", officeVerifier: async () => { throw new Error("sensitive"); } }), "OFFICE_FAILED");
    const invalidStage = stage(); invalidStage.salesRows[0].record.title_jp = "mutated";
    await expectCode(() => generateLocalWorkbookArtifact({ ...deps, runId: "bad-stage", stage: invalidStage }), "INVALID_STAGE");
    const onlySummary = stage(); onlySummary.salesRows = [onlySummary.salesRows[0]];
    const onlySummaryBody = { ...onlySummary };
    delete (onlySummaryBody as Partial<LocalParseStageResult>).digest;
    onlySummary.digest = sha(Buffer.from(canonicalJson(onlySummaryBody), "utf8"));
    await expectCode(() => generateLocalWorkbookArtifact({ ...deps, runId: "only-summary", stage: onlySummary }), "INVALID_STAGE");

    const officeRoot = path.join(root, "office-real");
    const office = await verifyWorkbookWithLibreOffice({
      buffer: fixedBuffer, workRoot: officeRoot,
      validateWorkbook: validateSettlementWorkbook, archiveDigest: xlsxArchiveDigest,
      sofficePath: "/opt/homebrew/bin/soffice", timeoutMs: 60_000,
    });
    assert.equal(office.verifier, "libreoffice");
    assert.match(office.version, /LibreOffice/i);
    assert.equal(office.reopened.sheetCount, 1);
    assert.ok(office.reopened.rowCount >= 3);
    assert.match(office.archiveDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(await fsp.readdir(officeRoot), [], "office temp profile and output are cleaned");

    const realPipeline = await generateLocalWorkbookArtifact({
      stage: stage(),
      workRoot: path.join(root, "real-pipeline"),
      runId: "run-real",
      fillWorkbook: fillInputV2Template,
      validateWorkbook: validateSettlementWorkbook,
      archiveDigest: xlsxArchiveDigest,
    });
    assert.equal(realPipeline.reused, false);
    assert.equal(realPipeline.evidence.detailRows, 2);
    assert.equal(realPipeline.evidence.office.verifier, "libreoffice");
    assert.match(realPipeline.evidence.office.version, /LibreOffice/i);
    assert.ok(realPipeline.evidence.reopened.sheetCount >= 1);
    assert.ok(realPipeline.evidence.reopened.rowCount >= 1);
    assert.equal((await fsp.readFile(realPipeline.candidatePath)).byteLength, realPipeline.evidence.workbookSizeBytes);
    const publishedBytes = await fsp.readFile(realPipeline.officePath);
    const reopenedPublished = new ExcelJS.Workbook();
    await reopenedPublished.xlsx.load(publishedBytes as unknown as ExcelJS.Buffer);
    const inputSheet = reopenedPublished.worksheets.find((sheet) => /^input_電子_/.test(sheet.name));
    assert.ok(inputSheet, "published workbook must retain the generated INPUT sheet");
    assert.equal(inputSheet.getRow(6).getCell(4).text, "first");
    assert.equal(inputSheet.getRow(7).getCell(4).text, "second");
    const publishedZip = await JSZip.loadAsync(publishedBytes, { checkCRC32: true });
    for (const entry of Object.values(publishedZip.files)) {
      if (!/^xl\/worksheets\/sheet\d+[.]xml$/.test(entry.name)) continue;
      const xml = await entry.async("string");
      assert.doesNotMatch(xml, /<f[^>]*t="array"[^>]*ref="([A-Z]+3)"[^>]*>[^<]*_xludf[.]XLOOKUP\([^<]*#ref!/i,
        `${entry.name} must not contain the known dead single-cell array lookup`);
    }
    const realReplay = await generateLocalWorkbookArtifact({
      stage: stage(), workRoot: path.join(root, "real-pipeline"), runId: "run-real",
      fillWorkbook: fillInputV2Template, validateWorkbook: validateSettlementWorkbook, archiveDigest: xlsxArchiveDigest,
    });
    assert.equal(realReplay.reused, true, "real filler and LibreOffice evidence replay deterministically");
    assert.equal(realReplay.evidence.workbookArchiveDigest, realPipeline.evidence.workbookArchiveDigest);

    const blankBuffer = await workbookBuffer("", "");
    await expectCode(() => generateLocalWorkbookArtifact({
      ...deps,
      runId: "blank-rendered-data",
      fillWorkbook: async ({ records }) => ({
        buffer: blankBuffer, fill_ms: 1, rows_written: records.length,
        electronic_rows: records.length, publication_rows: 0,
        electronic_sheet: "INPUT", publication_sheet: "INPUT_出版_7月",
        carry_rows: 0, overlay_rows: 0, append_rows: records.length, drop_rows: 0,
      }),
    }), "WORKBOOK_FAILED");

    const formulaCandidate = await workbookWithFormula(true);
    const formulaStrippedOffice = await workbookWithFormula(false);
    await expectCode(() => generateLocalWorkbookArtifact({
      ...deps,
      runId: "office-stripped-formulas",
      fillWorkbook: async ({ records }) => ({
        buffer: formulaCandidate, fill_ms: 1, rows_written: records.length,
        electronic_rows: records.length, publication_rows: 0,
        electronic_sheet: "INPUT", publication_sheet: "INPUT_出版_7月",
        carry_rows: 0, overlay_rows: 0, append_rows: records.length, drop_rows: 0,
      }),
      officeVerifier: async () => ({
        verifier: "injected", version: "formula-stripping-office",
        reopened: await validateSettlementWorkbook(formulaStrippedOffice),
        archiveDigest: await xlsxArchiveDigest(formulaStrippedOffice),
        verifiedWorkbook: formulaStrippedOffice,
      }),
    }), "OFFICE_FAILED");

    console.log("test-settlement-local-workbook-artifact: all assertions passed");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
