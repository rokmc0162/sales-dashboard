import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { canonicalizeIntakePath } from "../intake/contract";
import type { VersionSourceManifestEntry } from "./version-source-snapshot";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONTH_RE = /^(\d{4})(0[1-9]|1[0-2])$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const CHUNK_BYTES = 8 * 1024 * 1024;

export class LocalSyncArchiveError extends Error {
  constructor(public readonly code: "INVALID_INPUT" | "UNSAFE_PATH" | "SOURCE_CHANGED" | "ARCHIVE_CONFLICT" | "INTERRUPTED") {
    super(code);
    this.name = "LocalSyncArchiveError";
  }
}

export type LocalSyncArchiveFileEvidence = {
  relativePath: string;
  sizeBytes: number;
  sha256: string;
};

export type LocalSyncArchiveEvidence = {
  schemaVersion: 1;
  transport: "local-google-drive-sync";
  monthKey: string;
  versionNo: number;
  sourceVersionId: string;
  runId: string;
  files: LocalSyncArchiveFileEvidence[];
};

export type LocalSyncArchiveResult = {
  archiveDir: string;
  relativeArchivePath: string;
  evidenceSha256: string;
  reused: boolean;
  files: LocalSyncArchiveFileEvidence[];
};

export type ArchiveVersionToLocalSyncInput = {
  root: string;
  allowedBaseRoot: string;
  monthKey: string;
  versionNo: number;
  sourceVersionId: string;
  runId: string;
  snapshotDir: string;
  entries: VersionSourceManifestEntry[];
  officeVerifiedPath: string;
  evidencePath: string;
  canContinue?: () => boolean | Promise<boolean>;
};

function fail(code: LocalSyncArchiveError["code"]): never {
  throw new LocalSyncArchiveError(code);
}

function canonicalJson(value: LocalSyncArchiveEvidence): Buffer {
  return Buffer.from(JSON.stringify(value) + "\n", "utf8");
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

async function assertRealDirectoryWithoutLinks(value: string): Promise<string> {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) fail("UNSAFE_PATH");
  const stat = await fsp.lstat(value).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail("UNSAFE_PATH");
  const real = await fsp.realpath(value);
  if (real !== value) fail("UNSAFE_PATH");
  return real;
}

async function assertSourceFile(filePath: string, expectedRoot: string): Promise<void> {
  const resolved = path.resolve(filePath);
  if (!inside(expectedRoot, resolved)) fail("UNSAFE_PATH");
  const parent = path.dirname(resolved);
  if (await fsp.realpath(parent) !== parent) fail("UNSAFE_PATH");
  const stat = await fsp.lstat(resolved).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) fail("UNSAFE_PATH");
}

async function continueOrFail(callback?: () => boolean | Promise<boolean>): Promise<void> {
  if (callback && !(await callback())) fail("INTERRUPTED");
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await fsp.open(dir, fsConstants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function copyVerified(input: {
  source: string;
  destination: string;
  expectedSize?: number;
  expectedSha?: string;
  canContinue?: () => boolean | Promise<boolean>;
}): Promise<LocalSyncArchiveFileEvidence> {
  await continueOrFail(input.canContinue);
  const source = await fsp.open(input.source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let destination: fsp.FileHandle | null = null;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.size < 1) fail("SOURCE_CHANGED");
    if (input.expectedSize !== undefined && before.size !== input.expectedSize) fail("SOURCE_CHANGED");
    await fsp.mkdir(path.dirname(input.destination), { recursive: true, mode: 0o700 });
    destination = await fsp.open(input.destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, before.size));
    let offset = 0;
    while (offset < before.size) {
      await continueOrFail(input.canContinue);
      const length = Math.min(buffer.length, before.size - offset);
      const { bytesRead } = await source.read(buffer, 0, length, offset);
      if (bytesRead !== length) fail("SOURCE_CHANGED");
      const chunk = buffer.subarray(0, bytesRead);
      let written = 0;
      while (written < chunk.length) {
        const result = await destination.write(chunk, written, chunk.length - written, offset + written);
        if (result.bytesWritten < 1) fail("SOURCE_CHANGED");
        written += result.bytesWritten;
      }
      hash.update(chunk);
      offset += bytesRead;
    }
    await destination.sync();
    const after = await source.stat();
    const sha256 = hash.digest("hex");
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail("SOURCE_CHANGED");
    if (input.expectedSha !== undefined && sha256 !== input.expectedSha) fail("SOURCE_CHANGED");
    return { relativePath: "", sizeBytes: before.size, sha256 };
  } finally {
    await destination?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function hashFile(
  filePath: string,
  canContinue?: () => boolean | Promise<boolean>,
): Promise<{ sizeBytes: number; sha256: string }> {
  const parent = path.dirname(filePath);
  if (await fsp.realpath(parent) !== parent) fail("ARCHIVE_CONFLICT");
  const handle = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1) fail("ARCHIVE_CONFLICT");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, stat.size));
    let offset = 0;
    while (offset < stat.size) {
      await continueOrFail(canContinue);
      const length = Math.min(buffer.length, stat.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) fail("ARCHIVE_CONFLICT");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return { sizeBytes: stat.size, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

async function syncTreeDirectories(root: string): Promise<void> {
  const directories: string[] = [root];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) fail("UNSAFE_PATH");
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      directories.push(child);
      await visit(child);
    }
  };
  await visit(root);
  for (const directory of directories.reverse()) await syncDirectory(directory);
}

async function verifyReplay(
  finalDir: string,
  expected: LocalSyncArchiveEvidence,
  canContinue?: () => boolean | Promise<boolean>,
): Promise<string> {
  const sidecarPath = path.join(finalDir, "archive-evidence.json");
  const stat = await fsp.lstat(sidecarPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail("ARCHIVE_CONFLICT");
  const bytes = await fsp.readFile(sidecarPath);
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { fail("ARCHIVE_CONFLICT"); }
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) fail("ARCHIVE_CONFLICT");
  for (const file of expected.files) {
    await continueOrFail(canContinue);
    const target = path.resolve(finalDir, file.relativePath);
    if (!inside(finalDir, target)) fail("ARCHIVE_CONFLICT");
    const actual = await hashFile(target, canContinue);
    if (actual.sizeBytes !== file.sizeBytes || actual.sha256 !== file.sha256) fail("ARCHIVE_CONFLICT");
  }
  return digest(bytes);
}

export async function archiveVersionToLocalSync(input: ArchiveVersionToLocalSyncInput): Promise<LocalSyncArchiveResult> {
  const month = MONTH_RE.exec(input.monthKey);
  if (!month || !Number.isInteger(input.versionNo) || input.versionNo < 1 || input.versionNo > 999_999 || !UUID_RE.test(input.sourceVersionId) || !UUID_RE.test(input.runId)) fail("INVALID_INPUT");
  if (!path.isAbsolute(input.allowedBaseRoot) || !path.isAbsolute(input.root) || !path.isAbsolute(input.snapshotDir)) fail("UNSAFE_PATH");
  const allowed = await assertRealDirectoryWithoutLinks(input.allowedBaseRoot);
  const root = await assertRealDirectoryWithoutLinks(input.root);
  if (!inside(allowed, root)) fail("UNSAFE_PATH");
  const snapshot = await assertRealDirectoryWithoutLinks(input.snapshotDir);
  if (!Array.isArray(input.entries) || input.entries.length < 1) fail("INVALID_INPUT");

  const seen = new Set<string>();
  let previous = -1;
  for (const entry of input.entries) {
    const canonical = canonicalizeIntakePath(entry.displayPath);
    if (!canonical.ok || canonical.displayPath !== entry.displayPath || canonical.pathKey !== entry.pathKey || seen.has(entry.pathKey) || entry.position <= previous || !SHA_RE.test(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1) fail("INVALID_INPUT");
    seen.add(entry.pathKey); previous = entry.position;
    await assertSourceFile(path.resolve(snapshot, "files", entry.displayPath), path.join(snapshot, "files"));
  }
  const manifestSource = path.join(snapshot, "manifest.json");
  await assertSourceFile(manifestSource, snapshot);
  await assertSourceFile(path.resolve(input.officeVerifiedPath), path.dirname(path.resolve(input.officeVerifiedPath)));
  await assertSourceFile(path.resolve(input.evidencePath), path.dirname(path.resolve(input.evidencePath)));

  const monthDir = `${month[1]}-${month[2]}`;
  const versionDir = `v${String(input.versionNo).padStart(3, "0")}-${input.sourceVersionId}`;
  const runDir = `run-${input.runId}`;
  const relativeArchivePath = `${monthDir}/${versionDir}/${runDir}`;
  const versionRoot = path.join(root, monthDir, versionDir);
  const finalDir = path.join(versionRoot, runDir);
  await fsp.mkdir(path.join(root, monthDir), { recursive: true, mode: 0o700 });
  if (await fsp.realpath(path.join(root, monthDir)) !== path.join(root, monthDir)) fail("UNSAFE_PATH");
  await fsp.mkdir(versionRoot, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (await fsp.realpath(versionRoot) !== versionRoot) fail("UNSAFE_PATH");

  const plan: Array<{ source: string; relativePath: string; expectedSize?: number; expectedSha?: string }> = [
    { source: manifestSource, relativePath: "manifest.json" },
    ...input.entries.map((entry) => ({ source: path.join(snapshot, "files", entry.displayPath), relativePath: `원본/${entry.displayPath}`, expectedSize: entry.sizeBytes, expectedSha: entry.sha256 })),
    { source: path.resolve(input.officeVerifiedPath), relativePath: "결과/office-verified.xlsx" },
    { source: path.resolve(input.evidencePath), relativePath: "결과/evidence.json" },
  ];

  const finalExists = await fsp.lstat(finalDir).catch(() => null);
  if (finalExists) {
    if (!finalExists.isDirectory() || finalExists.isSymbolicLink()) fail("ARCHIVE_CONFLICT");
    const files: LocalSyncArchiveFileEvidence[] = [];
    for (const item of plan) {
      const sourceHash = await hashFile(item.source, input.canContinue);
      if ((item.expectedSize !== undefined && sourceHash.sizeBytes !== item.expectedSize) || (item.expectedSha !== undefined && sourceHash.sha256 !== item.expectedSha)) fail("SOURCE_CHANGED");
      files.push({ relativePath: item.relativePath, ...sourceHash });
    }
    const expected: LocalSyncArchiveEvidence = { schemaVersion: 1, transport: "local-google-drive-sync", monthKey: input.monthKey, versionNo: input.versionNo, sourceVersionId: input.sourceVersionId, runId: input.runId, files };
    const evidenceSha256 = await verifyReplay(finalDir, expected, input.canContinue);
    return { archiveDir: finalDir, relativeArchivePath, evidenceSha256, reused: true, files };
  }

  const tempDir = path.join(versionRoot, `.${runDir}.tmp-${randomUUID()}`);
  await fsp.mkdir(tempDir, { mode: 0o700 });
  try {
    const files: LocalSyncArchiveFileEvidence[] = [];
    for (const item of plan) {
      const copied = await copyVerified({ source: item.source, destination: path.join(tempDir, item.relativePath), expectedSize: item.expectedSize, expectedSha: item.expectedSha, canContinue: input.canContinue });
      files.push({ ...copied, relativePath: item.relativePath });
    }
    const evidence: LocalSyncArchiveEvidence = { schemaVersion: 1, transport: "local-google-drive-sync", monthKey: input.monthKey, versionNo: input.versionNo, sourceVersionId: input.sourceVersionId, runId: input.runId, files };
    const sidecar = canonicalJson(evidence);
    const sidecarPath = path.join(tempDir, "archive-evidence.json");
    const handle = await fsp.open(sidecarPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(sidecar); await handle.sync(); } finally { await handle.close(); }
    await syncTreeDirectories(tempDir);
    await continueOrFail(input.canContinue);
    let reusedAfterRace = false;
    try {
      await fsp.rename(tempDir, finalDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      const winner = await fsp.lstat(finalDir).catch(() => null);
      if (!winner?.isDirectory() || winner.isSymbolicLink()) fail("ARCHIVE_CONFLICT");
      await verifyReplay(finalDir, evidence, input.canContinue);
      await fsp.rm(tempDir, { recursive: true, force: true });
      reusedAfterRace = true;
    }
    await syncDirectory(path.dirname(finalDir));
    const evidenceSha256 = await verifyReplay(finalDir, evidence, input.canContinue);
    return { archiveDir: finalDir, relativeArchivePath, evidenceSha256, reused: reusedAfterRace, files };
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
