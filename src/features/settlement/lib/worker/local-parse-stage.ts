import { createHash } from "node:crypto";
import { constants as fsConstants, type Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { LookupMaps, TransformContext, TransformResult } from "../aggregation/to-sales-records";
import { canonicalizeIntakePath, MAX_INTAKE_FILES, MAX_INTAKE_FILE_BYTES, MAX_INTAKE_TOTAL_BYTES } from "../intake/contract";
import type { ParseResult } from "../schema/sales";
import type { SalesRecordInsert } from "../supabase/types";
import type { VersionSourceManifestEntry } from "./version-source-snapshot";

const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_STAGE_ROWS = 1_000_000;

export type LocalParseStageErrorCode =
  | "INVALID_INPUT"
  | "INVALID_MANIFEST"
  | "SOURCE_CHANGED"
  | "PARSER_FAILED"
  | "UNSUPPORTED_SOURCE"
  | "NO_ROWS"
  | "TRANSFORM_FAILED"
  | "INVALID_STAGE_VALUE"
  | "LIMIT_EXCEEDED";

export class LocalParseStageError extends Error {
  readonly code: LocalParseStageErrorCode;

  constructor(code: LocalParseStageErrorCode) {
    super(code);
    this.name = "LocalParseStageError";
    this.code = code;
  }
}

export type LocalParseFileResult = {
  objectId: string;
  position: number;
  displayPath: string;
  platformCode: string;
  detectionConfidence: number;
  parsedRowCount: number;
  transformedRowCount: number;
  summaryOnly: boolean;
  warningCodes: string[];
};

export type LocalParseRawRow = {
  objectId: string;
  position: number;
  rowIndex: number;
  data: Record<string, unknown>;
};

export type LocalParseSalesRow = {
  objectId: string;
  position: number;
  sourceOrdinal: number;
  record: SalesRecordInsert;
};

export type LocalParseStageResult = {
  schemaVersion: 1;
  settlementMonth: string;
  files: LocalParseFileResult[];
  rawRows: LocalParseRawRow[];
  salesRows: LocalParseSalesRow[];
  counts: { files: number; rawRows: number; salesRows: number; summaryFiles: number };
  digest: string;
};

type ParseFile = (input: { filename: string; buffer: Buffer; folderName?: string }) =>
  Promise<ParseResult & { detection_confidence: number }>;
type ToSalesRecords = (rows: ParseResult["records"], context: TransformContext) => TransformResult;

export type BuildLocalParseStageInput = {
  snapshotDir: string;
  entries: VersionSourceManifestEntry[];
  settlementMonth: string;
  lookups: LookupMaps;
  parseFile: ParseFile;
  toSalesRecords: ToSalesRecords;
};

function fail(code: LocalParseStageErrorCode): never {
  throw new LocalParseStageError(code);
}

function hasUnsafeStageControl(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true;
  }
  return false;
}

function assertJsonValue(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && hasUnsafeStageControl(value)) fail("INVALID_STAGE_VALUE");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_STAGE_VALUE");
    return;
  }
  if (typeof value !== "object") fail("INVALID_STAGE_VALUE");
  const object = value as object;
  if (seen.has(object)) fail("INVALID_STAGE_VALUE");
  seen.add(object);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("INVALID_STAGE_VALUE");
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (hasUnsafeStageControl(key) || item === undefined) fail("INVALID_STAGE_VALUE");
      assertJsonValue(item, seen);
    }
  }
  seen.delete(object);
}

function canonicalJson(value: unknown): string {
  assertJsonValue(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

async function listSnapshotFiles(filesRoot: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); }
    catch { fail("SOURCE_CHANGED"); }
    for (const item of entries) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isSymbolicLink()) fail("SOURCE_CHANGED");
      if (item.isDirectory()) await visit(path.join(directory, item.name), relative);
      else if (item.isFile()) found.push(relative.normalize("NFC"));
      else fail("SOURCE_CHANGED");
    }
  };
  await visit(filesRoot, "");
  return found.sort();
}

function validateManifest(entries: VersionSourceManifestEntry[]): void {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_INTAKE_FILES) fail("INVALID_MANIFEST");
  const ids = new Set<string>();
  const positions = new Set<number>();
  const paths = new Set<string>();
  let previous = -1;
  let total = 0;
  for (const entry of entries) {
    if (!UUID_RE.test(entry.objectId) || ids.has(entry.objectId)) fail("INVALID_MANIFEST");
    if (!Number.isInteger(entry.position) || entry.position < 0 || entry.position <= previous || positions.has(entry.position)) fail("INVALID_MANIFEST");
    const canonical = canonicalizeIntakePath(entry.displayPath);
    if (!canonical.ok || canonical.displayPath !== entry.displayPath || canonical.pathKey !== entry.pathKey || paths.has(entry.pathKey)) fail("INVALID_MANIFEST");
    if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 1 || entry.sizeBytes > MAX_INTAKE_FILE_BYTES || !SHA256_RE.test(entry.sha256)) fail("INVALID_MANIFEST");
    ids.add(entry.objectId);
    positions.add(entry.position);
    paths.add(entry.pathKey);
    previous = entry.position;
    total += entry.sizeBytes;
    if (total > MAX_INTAKE_TOTAL_BYTES) fail("LIMIT_EXCEEDED");
  }
}

async function readVerifiedFile(snapshotRoot: string, entry: VersionSourceManifestEntry): Promise<Buffer> {
  try {
    const filePath = path.resolve(snapshotRoot, "files", entry.displayPath);
    const filesRoot = path.resolve(snapshotRoot, "files");
    if (!filePath.startsWith(filesRoot + path.sep)) fail("INVALID_MANIFEST");
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.sizeBytes) fail("SOURCE_CHANGED");
    const real = await fsp.realpath(filePath);
    if (real !== filePath) fail("SOURCE_CHANGED");
    let handle: fsp.FileHandle;
    try { handle = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
    catch { fail("SOURCE_CHANGED"); }
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== entry.sizeBytes) fail("SOURCE_CHANGED");
      const bytes = await handle.readFile();
      if (bytes.byteLength !== entry.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) fail("SOURCE_CHANGED");
      return bytes;
    } finally {
      await handle.close().catch(() => fail("SOURCE_CHANGED"));
    }
  } catch (error) {
    if (error instanceof LocalParseStageError) throw error;
    fail("SOURCE_CHANGED");
  }
}

export async function buildLocalParseStage(input: BuildLocalParseStageInput): Promise<LocalParseStageResult> {
  let settlementMonth: string;
  let snapshotDir: string;
  let entries: VersionSourceManifestEntry[];
  let lookups: LookupMaps;
  let parseFile: ParseFile;
  let transformRows: ToSalesRecords;
  try {
    if (!input || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(input.settlementMonth)) fail("INVALID_INPUT");
    settlementMonth = String(input.settlementMonth);
    snapshotDir = String(input.snapshotDir);
    entries = cloneCanonical(input.entries);
    validateManifest(entries);
    lookups = {
      clientIds: new Map(input.lookups.clientIds),
      channelIds: new Map(input.lookups.channelIds),
      titleIds: input.lookups.titleIds ? new Map(input.lookups.titleIds) : undefined,
      clientAliasesToCode: input.lookups.clientAliasesToCode ? new Map(input.lookups.clientAliasesToCode) : undefined,
    };
    if (typeof input.parseFile !== "function" || typeof input.toSalesRecords !== "function") fail("INVALID_INPUT");
    parseFile = input.parseFile;
    transformRows = input.toSalesRecords;
  } catch (error) {
    if (error instanceof LocalParseStageError) throw error;
    fail("INVALID_INPUT");
  }
  const absoluteRoot = path.resolve(snapshotDir);
  let rootStat;
  try {
    rootStat = await fsp.lstat(absoluteRoot);
  } catch {
    fail("INVALID_INPUT");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("INVALID_INPUT");
  try {
    if (await fsp.realpath(absoluteRoot) !== absoluteRoot) fail("INVALID_INPUT");
  } catch (error) {
    if (error instanceof LocalParseStageError) throw error;
    fail("INVALID_INPUT");
  }
  const expectedFiles = entries.map((entry) => entry.displayPath).sort();
  const actualFiles = await listSnapshotFiles(path.join(absoluteRoot, "files"));
  if (canonicalJson(actualFiles) !== canonicalJson(expectedFiles)) fail("SOURCE_CHANGED");

  const files: LocalParseFileResult[] = [];
  const rawRows: LocalParseRawRow[] = [];
  const salesRows: LocalParseSalesRow[] = [];

  for (const entry of entries) {
    const bytes = await readVerifiedFile(absoluteRoot, entry);
    let parsed: Awaited<ReturnType<ParseFile>>;
    try {
      parsed = await parseFile({ filename: entry.displayPath, buffer: bytes });
    } catch {
      fail("PARSER_FAILED");
    }
    if (!parsed || typeof parsed.platform_code !== "string" || !Array.isArray(parsed.errors) || !Array.isArray(parsed.records)) fail("PARSER_FAILED");
    if (parsed.platform_code === "unknown" || parsed.platform_code.trim() === "") fail("UNSUPPORTED_SOURCE");
    if (!Number.isFinite(parsed.detection_confidence) || parsed.detection_confidence < 0 || parsed.detection_confidence > 1) fail("PARSER_FAILED");
    if (parsed.errors.length > 0) fail("PARSER_FAILED");
    if (parsed.records.length === 0) fail("NO_ROWS");
    if (rawRows.length + parsed.records.length > MAX_STAGE_ROWS) fail("LIMIT_EXCEEDED");
    const rowIndexes = new Set<number>();
    for (const row of parsed.records) {
      if (!row || !Number.isInteger(row.row_index) || row.row_index < 0 || rowIndexes.has(row.row_index)) fail("INVALID_STAGE_VALUE");
      rowIndexes.add(row.row_index);
      assertJsonValue(row.data);
    }
    const parsedForTransform = cloneCanonical(parsed.records);
    let transformed: TransformResult;
    try {
      transformed = transformRows(parsedForTransform, {
        settlement_month: settlementMonth,
        forceSettlementMonth: true,
        sales_month: parsed.sales_month,
        platform_code: parsed.platform_code,
        lookups,
      });
    } catch {
      fail("TRANSFORM_FAILED");
    }
    if (!transformed || !Array.isArray(transformed.errors) || !Array.isArray(transformed.inserts)) fail("TRANSFORM_FAILED");
    if (transformed.errors.length > 0 || transformed.inserts.length !== parsed.records.length) fail("TRANSFORM_FAILED");
    if (salesRows.length + transformed.inserts.length > MAX_STAGE_ROWS) fail("LIMIT_EXCEEDED");
    transformed.inserts.forEach((record) => assertJsonValue(record));
    const summaryOnly = parsed.records.every((row) => row.data.is_summary === true);
    files.push({
      objectId: entry.objectId,
      position: entry.position,
      displayPath: entry.displayPath,
      platformCode: parsed.platform_code,
      detectionConfidence: parsed.detection_confidence,
      parsedRowCount: parsed.records.length,
      transformedRowCount: transformed.inserts.length,
      summaryOnly,
      warningCodes: [],
    });
    parsed.records.forEach((row) => rawRows.push({ objectId: entry.objectId, position: entry.position, rowIndex: row.row_index, data: cloneCanonical(row.data) }));
    transformed.inserts.forEach((record, sourceOrdinal) => salesRows.push({ objectId: entry.objectId, position: entry.position, sourceOrdinal, record: cloneCanonical(record) }));
  }

  const finalRootStat = await fsp.lstat(absoluteRoot).catch(() => fail("SOURCE_CHANGED"));
  if (finalRootStat.dev !== rootStat.dev || finalRootStat.ino !== rootStat.ino) fail("SOURCE_CHANGED");
  const finalFiles = await listSnapshotFiles(path.join(absoluteRoot, "files"));
  if (canonicalJson(finalFiles) !== canonicalJson(expectedFiles)) fail("SOURCE_CHANGED");
  const body = {
    schemaVersion: 1 as const,
    settlementMonth,
    files,
    rawRows,
    salesRows,
    counts: { files: files.length, rawRows: rawRows.length, salesRows: salesRows.length, summaryFiles: files.filter((file) => file.summaryOnly).length },
  };
  const digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return { ...body, digest };
}

export const __test = { canonicalJson, assertJsonValue };
