// Pure filesystem snapshot module for settlement version sources.
//
// Materializes the frozen manifest of a submitted intake version (migration
// 029's settlement_intake_version_files fields) into an immutable
// <workRoot>/source-versions/<versionId>/ directory, or — when that directory
// already exists — verifies it byte-for-byte and reuses it only if identical.
// The module is deliberately DB-free: sources arrive through an injected
// openStream() callback, so it can be tested with in-memory streams and later
// wired to Supabase Storage without changes here.
//
// Layout of one snapshot directory:
//   source-versions/<versionId>/manifest.json   canonical ordered manifest
//   source-versions/<versionId>/files/<displayPath>  file bytes (nested dirs)
//
// Durability/atomicity: everything is written under a private, unique
// <workRoot>/.tmp/<runId>-<random>/ directory
// (same volume, so the final step is an atomic rename(2)), every file is
// fsynced, every directory is fsynced, and only then is the tree renamed to
// its final path. Cleanup touches only the unique directory owned by this
// invocation; it can never delete another attempt or leave a partial final.

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { canonicalizeIntakePath, MAX_INTAKE_FILES, MAX_INTAKE_FILE_BYTES, MAX_INTAKE_TOTAL_BYTES } from "../intake/contract";

export const SNAPSHOT_MANIFEST_NAME = "manifest.json";
export const SNAPSHOT_FILES_DIR = "files";

export type VersionSourceSnapshotErrorCode =
  | "INVALID_INPUT"
  | "INVALID_MANIFEST"
  | "SOURCE_MISMATCH"
  | "SOURCE_CHANGED"
  | "STALE_RUN";

export class VersionSourceSnapshotError extends Error {
  readonly code: VersionSourceSnapshotErrorCode;

  constructor(code: VersionSourceSnapshotErrorCode, message: string) {
    super(message);
    this.name = "VersionSourceSnapshotError";
    this.code = code;
  }
}

// One frozen settlement_intake_version_files row, as handed to the worker.
export type VersionSourceManifestEntry = {
  // Database identity of the frozen settlement_intake_version_files row.
  // Excluded from canonicalManifestBytes, whose contract mirrors migration 029.
  versionFileId: string;
  objectId: string;
  position: number;
  pathKey: string;
  displayPath: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
};

export type VersionSourceStream =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

export type CreateOrVerifyVersionSourceSnapshotInput = {
  versionId: string;
  runId: string;
  workRoot: string;
  entries: VersionSourceManifestEntry[];
  expectedManifestSha256: string;
  openStream: (
    entry: VersionSourceManifestEntry,
  ) => VersionSourceStream | Promise<VersionSourceStream>;
  // Advisory lease check called immediately before filesystem materialization.
  // Returning false discards the temp tree, but returning true is NOT a fence:
  // after this function returns, the caller MUST call the claim-token-fenced
  // snapshot-ready RPC successfully before parser/artifact/publication work.
  canFinalize?: () => boolean | Promise<boolean>;
};

export type VersionSourceSnapshotResult = {
  snapshotDir: string;
  manifestDigest: string;
  fileCount: number;
  totalBytes: number;
  reused: boolean;
};

// versionId/runId become single path segments; anything else is unsafe.
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
// Mirrors the storage_path CHECK in migration 029.
const STORAGE_PATH_RE = /^intake\/[0-9]{6}\/[0-9a-f]{32}\/[0-9a-f]{32}$/;

function fail(code: VersionSourceSnapshotErrorCode, message: string): never {
  throw new VersionSourceSnapshotError(code, message);
}

// PostgreSQL jsonb::text orders keys by UTF-8 byte length, then bytes, and
// emits a space after commas and colons. Migration 029 hashes exactly this
// representation, including object_id.
function postgresJsonbObject(fields: Record<string, string | number>): string {
  const keys = Object.keys(fields).sort((a, b) => {
    const aBytes = Buffer.from(a);
    const bBytes = Buffer.from(b);
    return aBytes.length - bBytes.length || Buffer.compare(aBytes, bBytes);
  });
  return `{${keys.map((key) => `${JSON.stringify(key)}: ${JSON.stringify(fields[key])}`).join(", ")}}`;
}

function canonicalManifestBytes(entries: VersionSourceManifestEntry[]): Buffer {
  const items = entries.map((entry) => postgresJsonbObject({
    position: entry.position,
    object_id: entry.objectId,
    path_key: entry.pathKey,
    display_name: entry.displayPath,
    size_bytes: entry.sizeBytes,
    sha256: entry.sha256,
    storage_path: entry.storagePath,
  }));
  return Buffer.from(`[${items.join(", ")}]`, "utf8");
}

// Validates the frozen manifest exactly as handed over: already-canonical
// display paths (nothing is silently rewritten), strictly ascending
// positions, DB-shaped sizes/hashes/storage paths, and no two entries whose
// NFC-lowercased path keys collide (such a pair cannot coexist on a
// case-insensitive filesystem).
function validateEntries(entries: VersionSourceManifestEntry[]): { totalBytes: number } {
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_INTAKE_FILES) {
    fail("INVALID_MANIFEST", `manifest must contain 1..${MAX_INTAKE_FILES} entries`);
  }
  const seenPathKeys = new Map<string, string>();
  const seenStoragePaths = new Set<string>();
  let totalBytes = 0;
  let previousPosition = -1;
  for (const entry of entries) {
    if (typeof entry.versionFileId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.versionFileId)) {
      fail("INVALID_MANIFEST", `invalid version_file_id for ${entry.displayPath}`);
    }
    if (typeof entry.objectId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.objectId)) {
      fail("INVALID_MANIFEST", `invalid object_id for ${entry.displayPath}`);
    }
    if (!Number.isInteger(entry.position) || entry.position < 0 || entry.position >= MAX_INTAKE_FILES) {
      fail("INVALID_MANIFEST", `invalid position ${entry.position}`);
    }
    if (entry.position <= previousPosition) {
      fail("INVALID_MANIFEST", `positions must be strictly ascending (saw ${entry.position} after ${previousPosition})`);
    }
    previousPosition = entry.position;
    if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 1 || entry.sizeBytes > MAX_INTAKE_FILE_BYTES) {
      fail("INVALID_MANIFEST", `invalid size_bytes for ${entry.displayPath}`);
    }
    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      fail("INVALID_MANIFEST", `invalid sha256 for ${entry.displayPath}`);
    }
    if (typeof entry.storagePath !== "string" || !STORAGE_PATH_RE.test(entry.storagePath)) {
      fail("INVALID_MANIFEST", `invalid storage_path for ${entry.displayPath}`);
    }
    if (seenStoragePaths.has(entry.storagePath)) {
      fail("INVALID_MANIFEST", `duplicate storage_path ${entry.storagePath}`);
    }
    seenStoragePaths.add(entry.storagePath);
    const canonical = canonicalizeIntakePath(entry.displayPath);
    if (!canonical.ok || canonical.displayPath !== entry.displayPath) {
      fail("INVALID_MANIFEST", `unsafe or non-canonical display path ${JSON.stringify(entry.displayPath)}`);
    }
    if (entry.pathKey !== canonical.pathKey) {
      fail("INVALID_MANIFEST", `frozen path_key does not match display path ${JSON.stringify(entry.displayPath)}`);
    }
    const collision = seenPathKeys.get(entry.pathKey);
    if (collision !== undefined) {
      fail("INVALID_MANIFEST", `case/NFC path collision between ${JSON.stringify(collision)} and ${JSON.stringify(entry.displayPath)}`);
    }
    seenPathKeys.set(entry.pathKey, entry.displayPath);
    totalBytes += entry.sizeBytes;
  }
  if (totalBytes > MAX_INTAKE_TOTAL_BYTES) {
    fail("INVALID_MANIFEST", "manifest exceeds the total size limit");
  }
  return { totalBytes };
}

function resolveInsideRoot(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    fail("INVALID_MANIFEST", `path ${JSON.stringify(relative)} escapes its root`);
  }
  return resolved;
}

async function* streamChunks(stream: VersionSourceStream): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in Object(stream)) {
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      yield chunk;
    }
    return;
  }
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    // Reached on early abort too (oversize stream): release the source.
    await reader.cancel().catch(() => {});
  }
}

async function syncDirectory(dirPath: string): Promise<void> {
  const handle = await fsp.open(dirPath, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(dirPath: string, requireExactRealPath = false): Promise<string> {
  await fsp.mkdir(dirPath, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(dirPath);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stat.isDirectory() || stat.isSymbolicLink() || uid === undefined || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    fail("INVALID_INPUT", `unsafe private work directory ${dirPath}`);
  }
  const real = await fsp.realpath(dirPath);
  if (requireExactRealPath && real !== dirPath) {
    fail("INVALID_INPUT", `work directory resolves through a link: ${dirPath}`);
  }
  return real;
}

async function writeAll(handle: fsp.FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) fail("SOURCE_MISMATCH", "short filesystem write");
    offset += bytesWritten;
  }
}

// Streams one source into destPath while counting bytes and hashing, aborting
// as soon as the stream exceeds its frozen size. The file is fsynced before
// the handle closes so a later rename can only ever publish durable bytes.
async function writeVerifiedFile(
  destPath: string,
  entry: VersionSourceManifestEntry,
  stream: VersionSourceStream,
): Promise<void> {
  const handle = await fsp.open(destPath, "wx");
  try {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of streamChunks(stream)) {
      if (!(chunk instanceof Uint8Array)) {
        fail("INVALID_INPUT", `stream for ${entry.displayPath} yielded a non-binary chunk`);
      }
      size += chunk.byteLength;
      if (size > entry.sizeBytes) {
        fail("SOURCE_MISMATCH", `source ${entry.displayPath} is larger than its frozen size ${entry.sizeBytes}`);
      }
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0) fail("SOURCE_MISMATCH", `short write for ${entry.displayPath}`);
        offset += bytesWritten;
      }
    }
    if (size !== entry.sizeBytes) {
      fail("SOURCE_MISMATCH", `source ${entry.displayPath} yielded ${size} bytes, expected ${entry.sizeBytes}`);
    }
    const digest = hash.digest("hex");
    if (digest !== entry.sha256) {
      fail("SOURCE_MISMATCH", `source ${entry.displayPath} hashed to ${digest}, expected ${entry.sha256}`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hashExistingFile(filePath: string, expectedSize: number, label: string): Promise<string> {
  let handle: fsp.FileHandle;
  try {
    // O_NOFOLLOW: refuse to read through a symlink swapped in after lstat.
    handle = await fsp.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    fail("SOURCE_CHANGED", `snapshot file ${label} is unreadable or a symlink`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedSize) {
      fail("SOURCE_CHANGED", `snapshot file ${label} changed size`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1 << 16);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

// lstat-only recursive listing: symlinks and special files anywhere in the
// snapshot fail closed as SOURCE_CHANGED, never get followed.
async function walkSnapshot(
  root: string,
): Promise<{ files: Map<string, number>; dirs: Set<string> }> {
  const files = new Map<string, number>();
  const dirs = new Set<string>();
  const recurse = async (absDir: string, relDir: string): Promise<void> => {
    const dirents = await fsp.readdir(absDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = relDir === "" ? dirent.name : `${relDir}/${dirent.name}`;
      const abs = path.join(absDir, dirent.name);
      if (dirent.isSymbolicLink()) {
        fail("SOURCE_CHANGED", `snapshot contains a symlink at ${rel}`);
      }
      if (dirent.isDirectory()) {
        dirs.add(rel);
        await recurse(abs, rel);
      } else if (dirent.isFile()) {
        files.set(rel, (await fsp.lstat(abs)).size);
      } else {
        fail("SOURCE_CHANGED", `snapshot contains a special file at ${rel}`);
      }
    }
  };
  await recurse(root, "");
  return { files, dirs };
}

// Recursively verifies an existing source-versions/<versionId>/ tree against
// the expected manifest: exact file set (no missing, no extra, no stray
// directories), exact sizes and hashes, and byte-identical manifest.json.
// Any divergence throws SOURCE_CHANGED; only an identical snapshot is reused.
async function verifyExistingSnapshot(
  finalDir: string,
  entries: VersionSourceManifestEntry[],
  manifestBytes: Buffer,
): Promise<void> {
  const rootStat = await fsp.lstat(finalDir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail("SOURCE_CHANGED", "existing snapshot path is not a directory");
  }
  const rootReal = await fsp.realpath(finalDir);
  if (rootReal !== finalDir) fail("SOURCE_CHANGED", "existing snapshot resolves through a link");
  const expectedFiles = new Map<string, VersionSourceManifestEntry | null>();
  const expectedDirs = new Set<string>([SNAPSHOT_FILES_DIR]);
  expectedFiles.set(SNAPSHOT_MANIFEST_NAME, null);
  for (const entry of entries) {
    const segments = entry.displayPath.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      expectedDirs.add(`${SNAPSHOT_FILES_DIR}/${segments.slice(0, i).join("/")}`);
    }
    expectedFiles.set(`${SNAPSHOT_FILES_DIR}/${entry.displayPath}`, entry);
  }

  const actual = await walkSnapshot(finalDir);
  for (const rel of actual.dirs) {
    if (!expectedDirs.has(rel)) fail("SOURCE_CHANGED", `unexpected directory ${rel} in snapshot`);
  }
  for (const rel of expectedDirs) {
    if (!actual.dirs.has(rel)) fail("SOURCE_CHANGED", `missing directory ${rel} in snapshot`);
  }
  for (const rel of actual.files.keys()) {
    if (!expectedFiles.has(rel)) fail("SOURCE_CHANGED", `unexpected file ${rel} in snapshot`);
  }
  for (const [rel, entry] of expectedFiles) {
    const expectedSize = entry === null ? manifestBytes.byteLength : entry.sizeBytes;
    const actualSize = actual.files.get(rel);
    if (actualSize === undefined) fail("SOURCE_CHANGED", `missing file ${rel} in snapshot`);
    if (actualSize !== expectedSize) fail("SOURCE_CHANGED", `file ${rel} changed size`);
    const abs = resolveInsideRoot(finalDir, rel);
    if (entry === null) {
      const digest = await hashExistingFile(abs, expectedSize, rel);
      const expectedDigest = createHash("sha256").update(manifestBytes).digest("hex");
      if (digest !== expectedDigest) fail("SOURCE_CHANGED", "snapshot manifest.json changed");
    } else {
      const digest = await hashExistingFile(abs, expectedSize, rel);
      if (digest !== entry.sha256) fail("SOURCE_CHANGED", `file ${rel} changed contents`);
    }
  }
  const rootAfter = await fsp.lstat(finalDir);
  if (!rootAfter.isDirectory() || rootAfter.isSymbolicLink() || rootAfter.dev !== rootStat.dev || rootAfter.ino !== rootStat.ino) {
    fail("SOURCE_CHANGED", "snapshot directory changed while it was being verified");
  }
  if (await fsp.realpath(finalDir) !== rootReal) {
    fail("SOURCE_CHANGED", "snapshot directory target changed while it was being verified");
  }
}

// Best-effort pointer for the fenced processing run: which snapshot this run
// resolved, so run forensics do not depend on re-deriving the manifest.
async function writeRunSnapshotReference(
  workRoot: string,
  runId: string,
  versionId: string,
  result: VersionSourceSnapshotResult,
): Promise<void> {
  const runDir = path.join(workRoot, "runs", runId);
  await fsp.mkdir(runDir, { recursive: true, mode: 0o700 });
  const refPath = path.join(runDir, "source-snapshot.json");
  const refTempPath = path.join(runDir, `.source-snapshot-${process.pid}-${randomUUID()}.tmp`);
  const bytes = Buffer.from(
    JSON.stringify({
      version_id: versionId,
      run_id: runId,
      snapshot_path: `source-versions/${versionId}`,
      manifest_digest: result.manifestDigest,
      file_count: result.fileCount,
      total_bytes: result.totalBytes,
      reused: result.reused,
    }),
    "utf8",
  );
  const handle = await fsp.open(refTempPath, "wx", 0o600);
  try {
    await writeAll(handle, bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(refTempPath, refPath);
  } catch (error) {
    await fsp.rm(refTempPath, { force: true }).catch(() => {});
    throw error;
  }
  await syncDirectory(runDir);
  await syncDirectory(path.join(workRoot, "runs"));
  await syncDirectory(workRoot);
}

export async function createOrVerifyVersionSourceSnapshot(
  input: CreateOrVerifyVersionSourceSnapshotInput,
): Promise<VersionSourceSnapshotResult> {
  const { versionId, runId, entries, openStream } = input;
  if (!SAFE_ID_RE.test(versionId)) fail("INVALID_INPUT", "unsafe versionId");
  if (!SAFE_ID_RE.test(runId)) fail("INVALID_INPUT", "unsafe runId");
  if (typeof input.workRoot !== "string" || input.workRoot.length === 0) {
    fail("INVALID_INPUT", "workRoot is required");
  }
  const requestedWorkRoot = path.resolve(input.workRoot);
  const workRoot = await ensurePrivateDirectory(requestedWorkRoot);
  const tmpRoot = path.join(workRoot, ".tmp");
  const sourceVersionsDir = path.join(workRoot, "source-versions");
  const runsDir = path.join(workRoot, "runs");
  await ensurePrivateDirectory(tmpRoot, true);
  await ensurePrivateDirectory(sourceVersionsDir, true);
  await ensurePrivateDirectory(runsDir, true);
  await syncDirectory(workRoot);

  const { totalBytes } = validateEntries(entries);
  const manifestBytes = canonicalManifestBytes(entries);
  const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
  if (!SHA256_RE.test(input.expectedManifestSha256) || manifestDigest !== input.expectedManifestSha256) {
    fail("INVALID_MANIFEST", "frozen rows do not reproduce the submitted version manifest");
  }
  const result: VersionSourceSnapshotResult = {
    snapshotDir: path.join(workRoot, "source-versions", versionId),
    manifestDigest,
    fileCount: entries.length,
    totalBytes,
    reused: false,
  };

  const finalExists = await fsp
    .lstat(result.snapshotDir)
    .then(() => true, () => false);
  if (finalExists) {
    await verifyExistingSnapshot(result.snapshotDir, entries, manifestBytes);
    result.reused = true;
    await writeRunSnapshotReference(workRoot, runId, versionId, result);
    return result;
  }

  // Each invocation owns one unguessable temp directory. Even two accidental
  // attempts with the same run id cannot delete or write into each other.
  const tmpRunDir = await fsp.mkdtemp(path.join(tmpRoot, `${runId}-`));
  await fsp.chmod(tmpRunDir, 0o700);
  try {
    const tmpSnapshotDir = path.join(tmpRunDir, "snapshot");
    const tmpFilesDir = path.join(tmpSnapshotDir, SNAPSHOT_FILES_DIR);
    await fsp.mkdir(tmpFilesDir, { recursive: true });

    for (const entry of entries) {
      const destPath = resolveInsideRoot(tmpFilesDir, entry.displayPath);
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await writeVerifiedFile(destPath, entry, await openStream(entry));
    }

    const manifestPath = path.join(tmpSnapshotDir, SNAPSHOT_MANIFEST_NAME);
    const manifestHandle = await fsp.open(manifestPath, "wx");
    try {
      await writeAll(manifestHandle, manifestBytes);
      await manifestHandle.sync();
    } finally {
      await manifestHandle.close();
    }

    // Fsync every directory in the temp tree so entries (file names) are as
    // durable as the file contents before the tree becomes visible.
    const tmpTree = await walkSnapshot(tmpSnapshotDir);
    await syncDirectory(tmpSnapshotDir);
    for (const relDir of tmpTree.dirs) {
      await syncDirectory(path.join(tmpSnapshotDir, relDir));
    }

    // Advisory optimization only. The fenced snapshot-ready RPC remains the
    // sole authority that may publish this run in PostgreSQL after rename.
    // A stale process can at most leave the same immutable version snapshot;
    // it cannot advance processing without the current claim token.
    if (input.canFinalize && !(await input.canFinalize())) {
      fail("STALE_RUN", `run ${runId} lost its lease before materializing version ${versionId}`);
    }

    try {
      await fsp.rename(tmpSnapshotDir, result.snapshotDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") throw error;
      // Lost a publish race: another run finalized this version first. Reuse
      // its snapshot only if it is byte-identical to what we just built.
      await verifyExistingSnapshot(result.snapshotDir, entries, manifestBytes);
      result.reused = true;
    }
    await syncDirectory(sourceVersionsDir);
    await syncDirectory(tmpRunDir);
    await syncDirectory(tmpRoot);
    await syncDirectory(workRoot);
    await fsp.rm(tmpRunDir, { recursive: true, force: true });
    await syncDirectory(tmpRoot);
  } catch (error) {
    await fsp.rm(tmpRunDir, { recursive: true, force: true }).catch(() => {});
    await syncDirectory(tmpRoot).catch(() => {});
    throw error;
  }

  await writeRunSnapshotReference(workRoot, runId, versionId, result);
  return result;
}
