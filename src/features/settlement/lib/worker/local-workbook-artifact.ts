import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type { InputV2FillResult } from "../export/input-v2-filler";
import type { LocalParseStageResult } from "./local-parse-stage";

const execFileAsync = promisify(execFile);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MAX_XLSX_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const CANDIDATE_NAME = "candidate.xlsx";
const OFFICE_NAME = "office-verified.xlsx";
const EVIDENCE_NAME = "evidence.json";

export type LocalWorkbookArtifactErrorCode = "INVALID_INPUT" | "INVALID_STAGE" | "WORKBOOK_FAILED" | "OFFICE_FAILED" | "ARTIFACT_CHANGED";
export class LocalWorkbookArtifactError extends Error {
  readonly code: LocalWorkbookArtifactErrorCode;
  constructor(code: LocalWorkbookArtifactErrorCode) { super(code); this.name = "LocalWorkbookArtifactError"; this.code = code; }
}
export type WorkbookShape = { sheetCount: number; rowCount: number };
export type OfficeVerification = { verifier: "libreoffice" | "injected"; version: string; reopened: WorkbookShape; archiveDigest: string };
type OfficeVerificationResult = OfficeVerification & { verifiedWorkbook: Buffer };
export type LocalWorkbookEvidence = {
  schemaVersion: 1; stageDigest: string; settlementMonth: string; detailRows: number;
  workbookSha256: string; workbookArchiveDigest: string; workbookSizeBytes: number;
  officeWorkbookSha256: string; officeWorkbookSizeBytes: number;
  reopened: WorkbookShape; office: OfficeVerification;
};
export type LocalWorkbookArtifactResult = {
  artifactDir: string; candidatePath: string; officePath: string; evidencePath: string;
  evidence: LocalWorkbookEvidence; reused: boolean;
};
type FillWorkbook = (input: { month: string; records: Record<string, unknown>[] }) => Promise<InputV2FillResult>;
type ValidateWorkbook = (buffer: Buffer) => Promise<WorkbookShape>;
type ArchiveDigest = (buffer: Buffer) => Promise<string>;
type OfficeVerifier = (input: { buffer: Buffer; workRoot: string; validateWorkbook: ValidateWorkbook; archiveDigest: ArchiveDigest }) => Promise<OfficeVerificationResult>;

function fail(code: LocalWorkbookArtifactErrorCode): never { throw new LocalWorkbookArtifactError(code); }
function sha256(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) fail("INVALID_INPUT"); return JSON.stringify(value); }
  if (!value || typeof value !== "object" || seen.has(value)) fail("INVALID_INPUT");
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) result = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail("INVALID_INPUT");
    const row = value as Record<string, unknown>;
    result = `{${Object.keys(row).sort().map((key) => row[key] === undefined ? fail("INVALID_INPUT") : `${JSON.stringify(key)}:${canonicalJson(row[key], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return result;
}
function cloneCanonical<T>(value: T): T { return JSON.parse(canonicalJson(value)) as T; }
async function syncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function privateDirectory(directory: string): Promise<string> {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || uid === undefined || stat.uid !== uid || (stat.mode & 0o077) !== 0) fail("INVALID_INPUT");
  const real = await fsp.realpath(directory);
  if (real !== path.resolve(directory)) fail("INVALID_INPUT");
  return real;
}
async function readPrivateFile(filePath: string, maxBytes: number, normalizeMode = false): Promise<Buffer> {
  let handle: fsp.FileHandle;
  try { handle = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
  catch { fail("ARTIFACT_CHANGED"); }
  try {
    let stat = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!stat.isFile() || uid === undefined || stat.uid !== uid || stat.size < 1 || stat.size > maxBytes) fail("ARTIFACT_CHANGED");
    if (normalizeMode && (stat.mode & 0o177) !== 0) {
      await handle.chmod(0o600);
      stat = await handle.stat();
    }
    if ((stat.mode & 0o177) !== 0) fail("ARTIFACT_CHANGED");
    const bytes = await handle.readFile();
    const finalStat = await handle.stat();
    if (bytes.byteLength !== stat.size || finalStat.dev !== stat.dev || finalStat.ino !== stat.ino
      || finalStat.size !== stat.size || finalStat.mtimeMs !== stat.mtimeMs) fail("ARTIFACT_CHANGED");
    return bytes;
  } finally { await handle.close().catch(() => fail("ARTIFACT_CHANGED")); }
}
async function validateBytes(buffer: Buffer, archiveDigest: ArchiveDigest, validateWorkbook: ValidateWorkbook): Promise<{ archiveDigest: string; reopened: WorkbookShape }> {
  let digest: string;
  let reopened: WorkbookShape;
  try {
    digest = await archiveDigest(Buffer.from(buffer));
    if (!SHA256_RE.test(digest)) fail("WORKBOOK_FAILED");
    reopened = await validateWorkbook(Buffer.from(buffer));
  } catch (error) {
    if (error instanceof LocalWorkbookArtifactError) throw error;
    fail("WORKBOOK_FAILED");
  }
  return { archiveDigest: digest, reopened };
}

export async function verifyWorkbookWithLibreOffice(input: {
  buffer: Buffer; workRoot: string; validateWorkbook: ValidateWorkbook; archiveDigest: ArchiveDigest;
  sofficePath?: string; timeoutMs?: number;
}): Promise<OfficeVerificationResult> {
  const sourceBuffer = Buffer.from(input.buffer);
  const workRoot = String(input.workRoot);
  const validateWorkbook = input.validateWorkbook;
  const archiveDigest = input.archiveDigest;
  const sofficePath = String(input.sofficePath ?? "/opt/homebrew/bin/soffice");
  const timeout = Number(input.timeoutMs ?? 60_000);
  if (typeof validateWorkbook !== "function" || typeof archiveDigest !== "function" || !Number.isInteger(timeout) || timeout < 1 || timeout > 300_000) fail("OFFICE_FAILED");
  let attempt = "";
  let result: OfficeVerificationResult | null = null;
  let primaryError: unknown = null;
  try {
    const root = await privateDirectory(path.resolve(workRoot));
    attempt = path.join(root, `.office-${randomUUID()}`);
    const inputDir = path.join(attempt, "input");
    const outputDir = path.join(attempt, "output");
    const profileDir = path.join(attempt, "profile");
    await fsp.mkdir(inputDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(outputDir, { mode: 0o700 });
    await fsp.mkdir(profileDir, { mode: 0o700 });
    const sourcePath = path.join(inputDir, CANDIDATE_NAME);
    const source = await fsp.open(sourcePath, "wx", 0o600);
    try { await source.writeFile(sourceBuffer); await source.sync(); } finally { await source.close(); }
    const isolatedEnv = { ...process.env, HOME: attempt };
    const profileArg = `-env:UserInstallation=${pathToFileURL(profileDir).href}`;
    await execFileAsync(sofficePath, ["--headless", "--convert-to", "xlsx", "--outdir", outputDir, profileArg, sourcePath], {
      timeout, maxBuffer: 1024 * 1024, env: isolatedEnv,
    });
    const names = await fsp.readdir(outputDir);
    if (names.length !== 1 || names[0] !== CANDIDATE_NAME) fail("OFFICE_FAILED");
    let converted: Buffer;
    try { converted = await readPrivateFile(path.join(outputDir, CANDIDATE_NAME), MAX_XLSX_BYTES, true); }
    catch { fail("OFFICE_FAILED"); }
    const checked = await validateBytes(converted, archiveDigest, validateWorkbook).catch(() => fail("OFFICE_FAILED"));
    const versionResult = await execFileAsync(sofficePath, ["--headless", profileArg, "--version"], {
      timeout: Math.min(timeout, 10_000), maxBuffer: 64 * 1024, env: isolatedEnv,
    });
    result = { verifier: "libreoffice", version: String(versionResult.stdout).trim().slice(0, 200), reopened: checked.reopened, archiveDigest: checked.archiveDigest, verifiedWorkbook: Buffer.from(converted) };
  } catch (error) { primaryError = error; }
  if (attempt) {
    try { await fsp.rm(attempt, { recursive: true, force: true }); }
    catch { fail("OFFICE_FAILED"); }
    try { await fsp.lstat(attempt); fail("OFFICE_FAILED"); }
    catch (error) {
      if (error instanceof LocalWorkbookArtifactError) throw error;
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) fail("OFFICE_FAILED");
    }
  }
  if (primaryError || !result) fail("OFFICE_FAILED");
  return result;
}

function freezeStage(stageInput: LocalParseStageResult): { stage: LocalParseStageResult; records: Record<string, unknown>[] } {
  let stage: LocalParseStageResult;
  try { stage = cloneCanonical(stageInput); } catch { fail("INVALID_STAGE"); }
  if (stage.schemaVersion !== 1 || !SHA256_RE.test(stage.digest) || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(stage.settlementMonth)) fail("INVALID_STAGE");
  const { digest, ...body } = stage;
  if (sha256(Buffer.from(canonicalJson(body), "utf8")) !== digest) fail("INVALID_STAGE");
  if (!Array.isArray(stage.salesRows) || !stage.counts || stage.counts.salesRows !== stage.salesRows.length) fail("INVALID_STAGE");
  const identities = new Set<string>();
  for (const row of stage.salesRows) {
    if (!row || !Number.isInteger(row.position) || row.position < 0 || !Number.isInteger(row.sourceOrdinal) || row.sourceOrdinal < 0 || typeof row.objectId !== "string" || !row.record || typeof row.record !== "object") fail("INVALID_STAGE");
    const identity = `${row.position}:${row.objectId}:${row.sourceOrdinal}`;
    if (identities.has(identity)) fail("INVALID_STAGE");
    identities.add(identity);
  }
  const records = stage.salesRows.slice()
    .sort((a, b) => a.position - b.position || a.sourceOrdinal - b.sourceOrdinal || a.objectId.localeCompare(b.objectId))
    .map((row) => cloneCanonical(row.record as Record<string, unknown>))
    .filter((record) => !String(record.note2 ?? "").includes("SUMMARY_NON_AGGREGATED"));
  if (records.length < 1) fail("INVALID_STAGE");
  return { stage, records };
}
function evidenceMatchesStored(value: unknown, stage: LocalParseStageResult, detailRows: number, candidate: Buffer, checked: { archiveDigest: string; reopened: WorkbookShape }): value is LocalWorkbookEvidence {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<LocalWorkbookEvidence>;
  const office = row.office;
  return row.schemaVersion === 1 && row.stageDigest === stage.digest && row.settlementMonth === stage.settlementMonth
    && row.detailRows === detailRows && row.workbookSha256 === sha256(candidate)
    && row.workbookArchiveDigest === checked.archiveDigest && row.workbookSizeBytes === candidate.byteLength
    && SHA256_RE.test(row.officeWorkbookSha256 ?? "")
    && Number.isInteger(row.officeWorkbookSizeBytes) && (row.officeWorkbookSizeBytes ?? 0) > 0
    && row.reopened?.sheetCount === checked.reopened.sheetCount && row.reopened?.rowCount === checked.reopened.rowCount
    && !!office && (office.verifier === "libreoffice" || office.verifier === "injected")
    && typeof office.version === "string" && office.version.length > 0 && office.version.length <= 200
    && Number.isInteger(office.reopened?.sheetCount) && (office.reopened?.sheetCount ?? 0) > 0
    && Number.isInteger(office.reopened?.rowCount) && (office.reopened?.rowCount ?? 0) > 0
    && SHA256_RE.test(office.archiveDigest ?? "");
}

export async function generateLocalWorkbookArtifact(input: {
  stage: LocalParseStageResult; workRoot: string; runId: string; fillWorkbook: FillWorkbook;
  validateWorkbook: ValidateWorkbook; archiveDigest: ArchiveDigest; officeVerifier?: OfficeVerifier;
}): Promise<LocalWorkbookArtifactResult> {
  try {
    if (!input || !SAFE_ID_RE.test(input.runId) || typeof input.fillWorkbook !== "function" || typeof input.validateWorkbook !== "function" || typeof input.archiveDigest !== "function") fail("INVALID_INPUT");
    const runId = String(input.runId); const workRoot = String(input.workRoot);
    const fillWorkbook = input.fillWorkbook; const validateWorkbook = input.validateWorkbook; const archiveDigest = input.archiveDigest;
    const officeVerifier = input.officeVerifier ?? ((args: Parameters<OfficeVerifier>[0]) => verifyWorkbookWithLibreOffice(args));
    const frozen = freezeStage(input.stage); const month = frozen.stage.settlementMonth.slice(0, 7).replace("-", "");
    const root = await privateDirectory(path.resolve(workRoot));
    const runDir = await privateDirectory(path.join(await privateDirectory(path.join(root, "runs")), runId));
    const artifactDir = path.join(runDir, "artifact");
    try { await fsp.mkdir(artifactDir, { mode: 0o700 }); await syncDirectory(runDir); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    await privateDirectory(artifactDir).catch(() => fail("ARTIFACT_CHANGED"));
    const names = (await fsp.readdir(artifactDir)).sort();
    if (names.some((name) => name !== CANDIDATE_NAME && name !== OFFICE_NAME && name !== EVIDENCE_NAME)) fail("ARTIFACT_CHANGED");
    const candidatePath = path.join(artifactDir, CANDIDATE_NAME);
    const officePath = path.join(artifactDir, OFFICE_NAME);
    const evidencePath = path.join(artifactDir, EVIDENCE_NAME);
    let candidate: Buffer; let createdCandidate = false;
    if (names.includes(CANDIDATE_NAME)) {
      candidate = await readPrivateFile(candidatePath, MAX_XLSX_BYTES);
      let retryFill: InputV2FillResult;
      try { retryFill = await fillWorkbook({ month, records: cloneCanonical(frozen.records) }); } catch { fail("WORKBOOK_FAILED"); }
      const retryBytes = Buffer.from(retryFill.buffer);
      if (retryFill.rows_written !== frozen.records.length || retryBytes.byteLength < 1 || retryBytes.byteLength > MAX_XLSX_BYTES) fail("WORKBOOK_FAILED");
      const storedCheck = await validateBytes(candidate, archiveDigest, validateWorkbook).catch(() => fail("ARTIFACT_CHANGED"));
      const retryCheck = await validateBytes(retryBytes, archiveDigest, validateWorkbook).catch(() => fail("WORKBOOK_FAILED"));
      if (storedCheck.archiveDigest !== retryCheck.archiveDigest) fail("ARTIFACT_CHANGED");
    } else {
      let filled: InputV2FillResult;
      try { filled = await fillWorkbook({ month, records: cloneCanonical(frozen.records) }); } catch { fail("WORKBOOK_FAILED"); }
      const generated = Buffer.from(filled.buffer);
      if (filled.rows_written !== frozen.records.length || generated.byteLength < 1 || generated.byteLength > MAX_XLSX_BYTES) fail("WORKBOOK_FAILED");
      await validateBytes(generated, archiveDigest, validateWorkbook);
      const tempPath = path.join(runDir, `.candidate-${randomUUID()}.xlsx`);
      const temp = await fsp.open(tempPath, "wx", 0o600);
      try { await temp.writeFile(generated); await temp.sync(); } finally { await temp.close(); }
      try { await fsp.link(tempPath, candidatePath); createdCandidate = true; await syncDirectory(artifactDir); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
      finally { await fsp.rm(tempPath, { force: true }).catch(() => {}); }
      candidate = await readPrivateFile(candidatePath, MAX_XLSX_BYTES);
    }
    let checked: { archiveDigest: string; reopened: WorkbookShape };
    try { checked = await validateBytes(candidate, archiveDigest, validateWorkbook); }
    catch { fail(names.includes(CANDIDATE_NAME) ? "ARTIFACT_CHANGED" : "WORKBOOK_FAILED"); }
    if ((await fsp.readdir(artifactDir)).some((name) => name !== CANDIDATE_NAME && name !== OFFICE_NAME && name !== EVIDENCE_NAME)) fail("ARTIFACT_CHANGED");
    const hadEvidence = (await fsp.readdir(artifactDir)).includes(EVIDENCE_NAME);
    if (hadEvidence) {
      if (!(await fsp.readdir(artifactDir)).includes(OFFICE_NAME)) fail("ARTIFACT_CHANGED");
      const officeWorkbook = await readPrivateFile(officePath, MAX_XLSX_BYTES);
      const officeChecked = await validateBytes(officeWorkbook, archiveDigest, validateWorkbook).catch(() => fail("ARTIFACT_CHANGED"));
      const evidenceBytes = await readPrivateFile(evidencePath, MAX_EVIDENCE_BYTES);
      let evidence: unknown; try { evidence = JSON.parse(evidenceBytes.toString("utf8")); } catch { fail("ARTIFACT_CHANGED"); }
      if (!evidenceMatchesStored(evidence, frozen.stage, frozen.records.length, candidate, checked)) fail("ARTIFACT_CHANGED");
      if (evidence.office.archiveDigest !== officeChecked.archiveDigest
        || evidence.officeWorkbookSha256 !== sha256(officeWorkbook)
        || evidence.officeWorkbookSizeBytes !== officeWorkbook.byteLength
        || evidence.office.reopened.sheetCount !== officeChecked.reopened.sheetCount
        || evidence.office.reopened.rowCount !== officeChecked.reopened.rowCount) fail("ARTIFACT_CHANGED");
      let currentOffice: OfficeVerificationResult;
      try { currentOffice = await officeVerifier({ buffer: Buffer.from(candidate), workRoot, validateWorkbook, archiveDigest }); }
      catch { fail("OFFICE_FAILED"); }
      if (currentOffice.verifier !== evidence.office.verifier || currentOffice.version !== evidence.office.version
        || currentOffice.reopened.sheetCount !== evidence.office.reopened.sheetCount
        || currentOffice.reopened.rowCount !== evidence.office.reopened.rowCount) fail("ARTIFACT_CHANGED");
      const finalCandidate = await readPrivateFile(candidatePath, MAX_XLSX_BYTES);
      if (!finalCandidate.equals(candidate)) fail("ARTIFACT_CHANGED");
      return { artifactDir, candidatePath, officePath, evidencePath, evidence, reused: true };
    }
    let officeResult: OfficeVerificationResult;
    try { officeResult = await officeVerifier({ buffer: Buffer.from(candidate), workRoot, validateWorkbook, archiveDigest }); } catch { fail("OFFICE_FAILED"); }
    const { verifiedWorkbook, ...office } = officeResult;
    if (!Buffer.isBuffer(verifiedWorkbook) || verifiedWorkbook.byteLength < 1 || verifiedWorkbook.byteLength > MAX_XLSX_BYTES
      || !SHA256_RE.test(office.archiveDigest) || office.reopened.sheetCount < 1 || office.reopened.rowCount < 1) fail("OFFICE_FAILED");
    const verifiedCheck = await validateBytes(Buffer.from(verifiedWorkbook), archiveDigest, validateWorkbook).catch(() => fail("OFFICE_FAILED"));
    if (verifiedCheck.archiveDigest !== office.archiveDigest || verifiedCheck.reopened.sheetCount !== office.reopened.sheetCount || verifiedCheck.reopened.rowCount !== office.reopened.rowCount) fail("OFFICE_FAILED");
    const tempOffice = path.join(runDir, `.office-${randomUUID()}.xlsx`);
    const officeHandle = await fsp.open(tempOffice, "wx", 0o600);
    try { await officeHandle.writeFile(verifiedWorkbook); await officeHandle.sync(); } finally { await officeHandle.close(); }
    try { await fsp.link(tempOffice, officePath); await syncDirectory(artifactDir); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    finally { await fsp.rm(tempOffice, { force: true }).catch(() => {}); }
    const storedOffice = await readPrivateFile(officePath, MAX_XLSX_BYTES);
    const storedOfficeCheck = await validateBytes(storedOffice, archiveDigest, validateWorkbook).catch(() => fail("ARTIFACT_CHANGED"));
    if (storedOfficeCheck.archiveDigest !== office.archiveDigest) fail("ARTIFACT_CHANGED");
    const stableCandidate = await readPrivateFile(candidatePath, MAX_XLSX_BYTES);
    if (!stableCandidate.equals(candidate)) fail("ARTIFACT_CHANGED");
    const evidence: LocalWorkbookEvidence = {
      schemaVersion: 1, stageDigest: frozen.stage.digest, settlementMonth: frozen.stage.settlementMonth,
      detailRows: frozen.records.length, workbookSha256: sha256(candidate), workbookArchiveDigest: checked.archiveDigest,
      workbookSizeBytes: candidate.byteLength, officeWorkbookSha256: sha256(storedOffice),
      officeWorkbookSizeBytes: storedOffice.byteLength, reopened: checked.reopened, office: cloneCanonical(office),
    };
    const evidenceBytes = Buffer.from(canonicalJson(evidence), "utf8");
    const tempEvidence = path.join(runDir, `.evidence-${randomUUID()}.json`);
    const handle = await fsp.open(tempEvidence, "wx", 0o600);
    try { await handle.writeFile(evidenceBytes); await handle.sync(); } finally { await handle.close(); }
    try { await fsp.link(tempEvidence, evidencePath); await syncDirectory(artifactDir); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    finally { await fsp.rm(tempEvidence, { force: true }).catch(() => {}); }
    const stored = await readPrivateFile(evidencePath, MAX_EVIDENCE_BYTES);
    let parsed: unknown; try { parsed = JSON.parse(stored.toString("utf8")); } catch { fail("ARTIFACT_CHANGED"); }
    if (!evidenceMatchesStored(parsed, frozen.stage, frozen.records.length, candidate, checked)) fail("ARTIFACT_CHANGED");
    const finalCandidate = await readPrivateFile(candidatePath, MAX_XLSX_BYTES);
    if (!finalCandidate.equals(candidate)) fail("ARTIFACT_CHANGED");
    return { artifactDir, candidatePath, officePath, evidencePath, evidence: parsed, reused: !createdCandidate };
  } catch (error) {
    if (error instanceof LocalWorkbookArtifactError) throw error;
    fail("INVALID_INPUT");
  }
}
