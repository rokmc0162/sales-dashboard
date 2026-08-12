import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { LocalParseStageError, type LocalParseStageResult } from "./local-parse-stage";

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const STAGE_FILE = "stage.json";

export type LocalStagePersistenceResult = {
  stagingDir: string;
  stagePath: string;
  sha256: string;
  sizeBytes: number;
  reused: boolean;
};

function fail(code: "INVALID_INPUT" | "SOURCE_CHANGED" | "INVALID_STAGE_VALUE"): never {
  throw new LocalParseStageError(code);
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_STAGE_VALUE");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") fail("INVALID_STAGE_VALUE");
  if (seen.has(value)) fail("INVALID_STAGE_VALUE");
  seen.add(value);
  if (Array.isArray(value)) {
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("INVALID_STAGE_VALUE");
  const row = value as Record<string, unknown>;
  const result = `{${Object.keys(row).sort().map((key) => {
    if (row[key] === undefined) fail("INVALID_STAGE_VALUE");
    return `${JSON.stringify(key)}:${canonicalJson(row[key], seen)}`;
  }).join(",")}}`;
  seen.delete(value);
  return result;
}

function stageBytes(stage: LocalParseStageResult): Buffer {
  const { digest, ...body } = stage;
  const expected = createHash("sha256").update(canonicalJson(body)).digest("hex");
  if (digest !== expected) fail("INVALID_STAGE_VALUE");
  return Buffer.from(canonicalJson(stage), "utf8");
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function ensurePrivateDirectory(directory: string): Promise<string> {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(directory);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || uid === undefined || stat.uid !== uid || (stat.mode & 0o077) !== 0) fail("INVALID_INPUT");
  const real = await fsp.realpath(directory);
  if (real !== path.resolve(directory)) fail("INVALID_INPUT");
  return real;
}

async function inspectStagingDirectory(stagingDir: string, allowEmpty: boolean): Promise<string[]> {
  try {
    const dirStat = await fsp.lstat(stagingDir);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || uid === undefined || dirStat.uid !== uid || (dirStat.mode & 0o077) !== 0) fail("SOURCE_CHANGED");
    if ((await fsp.realpath(stagingDir)) !== stagingDir) fail("SOURCE_CHANGED");
    const names = await fsp.readdir(stagingDir);
    if ((!allowEmpty || names.length > 0) && (names.length !== 1 || names[0] !== STAGE_FILE)) fail("SOURCE_CHANGED");
    return names;
  } catch (error) {
    if (error instanceof LocalParseStageError) throw error;
    fail("SOURCE_CHANGED");
  }
}

async function verifyExisting(stagingDir: string, expected: Buffer): Promise<LocalStagePersistenceResult> {
  await inspectStagingDirectory(stagingDir, false);
  const stagePath = path.join(stagingDir, STAGE_FILE);
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(stagePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    fail("SOURCE_CHANGED");
  }
  try {
    const stat = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!stat.isFile() || uid === undefined || stat.uid !== uid || (stat.mode & 0o177) !== 0) fail("SOURCE_CHANGED");
    const actual = await handle.readFile();
    if (!actual.equals(expected)) fail("SOURCE_CHANGED");
    return {
      stagingDir,
      stagePath,
      sha256: createHash("sha256").update(actual).digest("hex"),
      sizeBytes: actual.byteLength,
      reused: true,
    };
  } finally {
    await handle.close().catch(() => fail("SOURCE_CHANGED"));
  }
}

async function persistLocalParseStageInternal(input: {
  workRoot: string;
  runId: string;
  stage: LocalParseStageResult;
}): Promise<LocalStagePersistenceResult> {
  if (!input || !SAFE_ID_RE.test(input.runId)) fail("INVALID_INPUT");
  const workRoot = String(input.workRoot);
  const runId = String(input.runId);
  const bytes = Buffer.from(stageBytes(input.stage));
  const root = await ensurePrivateDirectory(path.resolve(workRoot));
  const runsDir = await ensurePrivateDirectory(path.join(root, "runs"));
  const runDir = await ensurePrivateDirectory(path.join(runsDir, runId));
  const stagingDir = path.join(runDir, "staging");
  try {
    await fsp.mkdir(stagingDir, { mode: 0o700 });
    await syncDirectory(runDir);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const names = await inspectStagingDirectory(stagingDir, true);
  const stagingIdentity = await fsp.lstat(stagingDir);
  if (names.length === 1) return verifyExisting(stagingDir, bytes);

  const tempPath = path.join(runDir, `.stage-${randomUUID()}.json`);
  try {
    const handle = await fsp.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const finalPath = path.join(stagingDir, STAGE_FILE);
    try {
      await fsp.link(tempPath, finalPath);
      await syncDirectory(stagingDir);
      await syncDirectory(runDir);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const finalIdentity = await fsp.lstat(stagingDir);
    if (finalIdentity.dev !== stagingIdentity.dev || finalIdentity.ino !== stagingIdentity.ino) fail("SOURCE_CHANGED");
    const result = await verifyExisting(stagingDir, bytes);
    return { ...result, reused: false };
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function persistLocalParseStage(input: {
  workRoot: string;
  runId: string;
  stage: LocalParseStageResult;
}): Promise<LocalStagePersistenceResult> {
  try {
    return await persistLocalParseStageInternal(input);
  } catch (error) {
    if (error instanceof LocalParseStageError) throw error;
    fail("INVALID_INPUT");
  }
}

export const __test = { stageBytes };
