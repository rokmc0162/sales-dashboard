// Behavioral tests for the pure filesystem version-source snapshot module.
// Everything runs against throwaway temp directories and in-memory chunked
// streams — no Supabase, no network, no worker loop.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  createOrVerifyVersionSourceSnapshot,
  SNAPSHOT_MANIFEST_NAME,
  VersionSourceSnapshotError,
  type VersionSourceManifestEntry,
} from "../src/features/settlement/lib/worker/version-source-snapshot";

const VERSION_ID = "11111111-2222-4333-8444-555555555555";
const RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function storagePathFor(index: number): string {
  const hex = index.toString(16).padStart(32, "0");
  return `intake/202607/${hex}/${hex}`;
}

type Source = { entry: VersionSourceManifestEntry; bytes: Buffer };

function makeSource(position: number, displayPath: string, text: string): Source {
  const bytes = Buffer.from(text, "utf8");
  return {
    bytes,
    entry: {
      versionFileId: `10000000-0000-4000-8000-${position.toString().padStart(12, "0")}`,
      objectId: `00000000-0000-4000-8000-${position.toString().padStart(12, "0")}`,
      position,
      pathKey: displayPath.toLowerCase().normalize("NFC"),
      displayPath,
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      storagePath: storagePathFor(position),
    },
  };
}

// In-memory chunked stream; `yielded` proves how many chunks were consumed.
function chunkedStream(bytes: Uint8Array, chunkSize: number, counter?: { yielded: number }) {
  return (async function* () {
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      if (counter) counter.yielded += 1;
      yield bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    }
  })();
}

function openStreamFor(sources: Source[], counters?: { opens: number; yielded: number }) {
  return (entry: VersionSourceManifestEntry) => {
    if (counters) counters.opens += 1;
    const source = sources.find((s) => s.entry.storagePath === entry.storagePath);
    assert.ok(source, `openStream called for unknown entry ${entry.displayPath}`);
    return chunkedStream(source.bytes, 3, counters);
  };
}

async function withWorkRoot(run: (workRoot: string) => Promise<void>): Promise<void> {
  const workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vss-test-"));
  try {
    await run(workRoot);
  } finally {
    await fsp.rm(workRoot, { recursive: true, force: true });
  }
}

function expectCode(code: VersionSourceSnapshotError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof VersionSourceSnapshotError, `expected VersionSourceSnapshotError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

async function exists(p: string): Promise<boolean> {
  return fsp.lstat(p).then(() => true, () => false);
}

async function assertTmpEmpty(workRoot: string): Promise<void> {
  const tmpRoot = path.join(await fsp.realpath(workRoot), ".tmp");
  assert.deepEqual(await fsp.readdir(tmpRoot), []);
}

const NESTED_SOURCES = [
  makeSource(0, "reports/2026/07/Piccoma.csv", "series,revenue\nalpha,1200\n"),
  makeSource(2, "reports/2026/07/deep/LINE Manga.csv", "series,revenue\nbeta,3400\n"),
  makeSource(5, "notes.txt", "top-level note"),
];

function pgJsonbObject(fields: Record<string, string | number>): string {
  const keys = Object.keys(fields).sort((a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return `{${keys.map((key) => `${JSON.stringify(key)}: ${JSON.stringify(fields[key])}`).join(", ")}}`;
}

function manifestText(entries: VersionSourceManifestEntry[]): string {
  return `[${entries.map((entry) => pgJsonbObject({
    position: entry.position,
    object_id: entry.objectId,
    path_key: entry.pathKey,
    display_name: entry.displayPath,
    size_bytes: entry.sizeBytes,
    sha256: entry.sha256,
    storage_path: entry.storagePath,
  })).join(", ")}]`;
}

function manifestSha256(entries: VersionSourceManifestEntry[]): string {
  return sha256Hex(Buffer.from(manifestText(entries), "utf8"));
}

async function buildSnapshot(workRoot: string, runId = RUN_ID) {
  const entries = NESTED_SOURCES.map((s) => s.entry);
  return createOrVerifyVersionSourceSnapshot({
    versionId: VERSION_ID,
    runId,
    workRoot,
    entries,
    expectedManifestSha256: manifestSha256(entries),
    openStream: openStreamFor(NESTED_SOURCES),
  });
}

async function testNestedSuccessWithMultipleChunks(): Promise<void> {
  await withWorkRoot(async (workRoot) => {
    const counters = { opens: 0, yielded: 0 };
    const result = await createOrVerifyVersionSourceSnapshot({
      versionId: VERSION_ID,
      runId: RUN_ID,
      workRoot,
      entries: NESTED_SOURCES.map((s) => s.entry),
      expectedManifestSha256: manifestSha256(NESTED_SOURCES.map((s) => s.entry)),
      openStream: openStreamFor(NESTED_SOURCES, counters),
      canFinalize: () => true,
    });

    assert.equal(result.reused, false);
    assert.equal(result.fileCount, 3);
    assert.equal(result.totalBytes, NESTED_SOURCES.reduce((sum, s) => sum + s.bytes.byteLength, 0));
    assert.equal(counters.opens, 3);
    assert.ok(counters.yielded > 3, "each source must be delivered in multiple chunks");
    assert.equal(result.snapshotDir, path.join(await fsp.realpath(workRoot), "source-versions", VERSION_ID));

    for (const source of NESTED_SOURCES) {
      const onDisk = await fsp.readFile(path.join(result.snapshotDir, "files", source.entry.displayPath));
      assert.ok(onDisk.equals(source.bytes), `bytes for ${source.entry.displayPath} must round-trip`);
    }

    // Canonical manifest: ordered array, migration-029 jsonb key order.
    const manifestBytes = await fsp.readFile(path.join(result.snapshotDir, SNAPSHOT_MANIFEST_NAME));
    assert.equal(sha256Hex(manifestBytes), result.manifestDigest);
    const expectedManifest = manifestText(NESTED_SOURCES.map((s) => s.entry));
    assert.equal(manifestBytes.toString("utf8"), expectedManifest);

    // Run metadata references the snapshot; the run temp is gone.
    const runRef = JSON.parse(
      await fsp.readFile(path.join(workRoot, "runs", RUN_ID, "source-snapshot.json"), "utf8"),
    );
    assert.equal(runRef.snapshot_path, `source-versions/${VERSION_ID}`);
    assert.equal(runRef.manifest_digest, result.manifestDigest);
    await assertTmpEmpty(workRoot);

    console.log("ok: nested snapshot succeeds and streams in multiple chunks");
  });
}

async function testReplayReusesWithoutStreaming(): Promise<void> {
  await withWorkRoot(async (workRoot) => {
    await buildSnapshot(workRoot);
    const counters = { opens: 0, yielded: 0 };
    const replay = await createOrVerifyVersionSourceSnapshot({
      versionId: VERSION_ID,
      runId: "replay-run-1",
      workRoot,
      entries: NESTED_SOURCES.map((s) => s.entry),
      expectedManifestSha256: manifestSha256(NESTED_SOURCES.map((s) => s.entry)),
      openStream: openStreamFor(NESTED_SOURCES, counters),
    });
    assert.equal(replay.reused, true);
    assert.equal(counters.opens, 0, "an identical existing snapshot must be reused without streaming");
    assert.equal(await exists(path.join(workRoot, "runs", "replay-run-1", "source-snapshot.json")), true);
    console.log("ok: replay verifies and reuses the identical snapshot");
  });
}

async function testUnsafeAndCollidingPathsRejected(): Promise<void> {
  await withWorkRoot(async (workRoot) => {
    const attempt = (sources: Source[]) =>
      createOrVerifyVersionSourceSnapshot({
        versionId: VERSION_ID,
        runId: RUN_ID,
        workRoot,
        entries: sources.map((s) => s.entry),
        expectedManifestSha256: manifestSha256(sources.map((s) => s.entry)),
        openStream: openStreamFor(sources),
      });

    await assert.rejects(attempt([makeSource(0, "../evil.csv", "x")]), expectCode("INVALID_MANIFEST"));
    await assert.rejects(attempt([makeSource(0, "a\\b.csv", "x")]), expectCode("INVALID_MANIFEST"));
    await assert.rejects(attempt([makeSource(0, "/abs.csv", "x")]), expectCode("INVALID_MANIFEST"));
    // Lowercase collision (case-insensitive filesystems) and NFC collision
    // (NFD input is not canonical) both fail closed.
    await assert.rejects(
      attempt([makeSource(0, "Data.csv", "x"), makeSource(1, "data.csv", "y")]),
      expectCode("INVALID_MANIFEST"),
    );
    await assert.rejects(attempt([makeSource(0, "café.csv", "x")]), expectCode("INVALID_MANIFEST"));

    const wrongFrozenPath = makeSource(0, "Folder/Data.csv", "x");
    wrongFrozenPath.entry.pathKey = "other/data.csv";
    let opened = 0;
    await assert.rejects(
      createOrVerifyVersionSourceSnapshot({
        versionId: VERSION_ID,
        runId: RUN_ID,
        workRoot,
        entries: [wrongFrozenPath.entry],
        expectedManifestSha256: manifestSha256([wrongFrozenPath.entry]),
        openStream: () => { opened += 1; return chunkedStream(wrongFrozenPath.bytes, 1); },
      }),
      expectCode("INVALID_MANIFEST"),
    );
    assert.equal(opened, 0, "a mismatched frozen path_key must fail before opening Storage");

    assert.equal(await exists(path.join(workRoot, "source-versions", VERSION_ID)), false);
    console.log("ok: unsafe, non-canonical, and colliding paths are rejected");
  });
}

async function testSizeAndHashMismatch(): Promise<void> {
  await withWorkRoot(async (workRoot) => {
    const short = makeSource(0, "short.csv", "0123456789");
    short.entry.sizeBytes = 12; // stream ends 2 bytes early
    await assert.rejects(
      createOrVerifyVersionSourceSnapshot({
        versionId: VERSION_ID,
        runId: RUN_ID,
        workRoot,
        entries: [short.entry],
        expectedManifestSha256: manifestSha256([short.entry]),
        openStream: () => chunkedStream(short.bytes, 3),
      }),
      expectCode("SOURCE_MISMATCH"),
    );

    // Oversize streams abort before draining the source.
    const long = makeSource(1, "long.csv", "0123456789");
    long.entry.sizeBytes = 4;
    const counter = { yielded: 0 };
    await assert.rejects(
      createOrVerifyVersionSourceSnapshot({
        versionId: VERSION_ID,
        runId: RUN_ID,
        workRoot,
        entries: [long.entry],
        expectedManifestSha256: manifestSha256([long.entry]),
        openStream: () => chunkedStream(long.bytes, 2, counter),
      }),
      expectCode("SOURCE_MISMATCH"),
    );
    assert.ok(counter.yielded < 5, "oversize stream must be aborted early, not drained");

    const wrongHash = makeSource(2, "hash.csv", "payload");
    wrongHash.entry.sha256 = "0".repeat(64);
    await assert.rejects(
      createOrVerifyVersionSourceSnapshot({
        versionId: VERSION_ID,
        runId: RUN_ID,
        workRoot,
        entries: [wrongHash.entry],
        expectedManifestSha256: manifestSha256([wrongHash.entry]),
        openStream: () => chunkedStream(wrongHash.bytes, 3),
      }),
      expectCode("SOURCE_MISMATCH"),
    );

    await assertTmpEmpty(workRoot);
    assert.equal(await exists(path.join(workRoot, "source-versions", VERSION_ID)), false);
    console.log("ok: size overrun, size shortfall, and hash mismatch fail without residue");
  });
}

async function testPartialStreamCleanupAndRetry(): Promise<void> {
  await withWorkRoot(async (workRoot) => {
    const failing = async function* (): AsyncGenerator<Uint8Array> {
      yield NESTED_SOURCES[0].bytes.subarray(0, 4);
      throw new Error("storage connection reset");
    };
    await assert.rejects(
      createOrVerifyVersionSourceSnapshot({
        versionId: VERSION_ID,
        runId: RUN_ID,
        workRoot,
        entries: NESTED_SOURCES.map((s) => s.entry),
      expectedManifestSha256: manifestSha256(NESTED_SOURCES.map((s) => s.entry)),
        openStream: (entry) =>
          entry.storagePath === NESTED_SOURCES[0].entry.storagePath
            ? failing()
            : openStreamFor(NESTED_SOURCES)(entry),
      }),
      /storage connection reset/,
    );
    await assertTmpEmpty(workRoot);
    assert.equal(await exists(path.join(workRoot, "source-versions", VERSION_ID)), false);

    // The same run retries cleanly after the transient failure.
    const retried = await buildSnapshot(workRoot);
    assert.equal(retried.reused, false);
    console.log("ok: partial stream failure cleans its temp and the run can retry");
  });
}

async function testTamperedFinalFailsClosed(): Promise<void> {
  const rebuild = (workRoot: string) => buildSnapshot(workRoot, "verify-run");

  await withWorkRoot(async (workRoot) => {
    const { snapshotDir } = await buildSnapshot(workRoot);
    const target = path.join(snapshotDir, "files", "notes.txt");
    await fsp.writeFile(target, "top-level nose"); // same length, new bytes
    await assert.rejects(rebuild(workRoot), expectCode("SOURCE_CHANGED"));
    console.log("ok: mutated snapshot file fails closed");
  });

  await withWorkRoot(async (workRoot) => {
    const { snapshotDir } = await buildSnapshot(workRoot);
    await fsp.rm(path.join(snapshotDir, "files", "notes.txt"));
    await assert.rejects(rebuild(workRoot), expectCode("SOURCE_CHANGED"));
    console.log("ok: missing snapshot file fails closed");
  });

  await withWorkRoot(async (workRoot) => {
    const { snapshotDir } = await buildSnapshot(workRoot);
    await fsp.writeFile(path.join(snapshotDir, "files", "extra.csv"), "surprise");
    await assert.rejects(rebuild(workRoot), expectCode("SOURCE_CHANGED"));
    console.log("ok: extra snapshot file fails closed");
  });

  await withWorkRoot(async (workRoot) => {
    const { snapshotDir } = await buildSnapshot(workRoot);
    const target = path.join(snapshotDir, "files", "notes.txt");
    const aside = path.join(workRoot, "aside.txt");
    await fsp.copyFile(target, aside);
    await fsp.rm(target);
    await fsp.symlink(aside, target); // identical contents, but via symlink
    await assert.rejects(rebuild(workRoot), expectCode("SOURCE_CHANGED"));
    console.log("ok: symlinked snapshot file fails closed even with identical bytes");
  });
}

async function testStaleFinalizePreventsRename(): Promise<void> {
  await withWorkRoot(async (workRoot) => {
    let asked = 0;
    await assert.rejects(
      createOrVerifyVersionSourceSnapshot({
        versionId: VERSION_ID,
        runId: RUN_ID,
        workRoot,
        entries: NESTED_SOURCES.map((s) => s.entry),
      expectedManifestSha256: manifestSha256(NESTED_SOURCES.map((s) => s.entry)),
        openStream: openStreamFor(NESTED_SOURCES),
        canFinalize: () => {
          asked += 1;
          return false;
        },
      }),
      expectCode("STALE_RUN"),
    );
    assert.equal(asked, 1);
    assert.equal(await exists(path.join(workRoot, "source-versions", VERSION_ID)), false);
    await assertTmpEmpty(workRoot);
    console.log("ok: stale advisory check prevents materialization and cleans up");
  });
}

async function testManifestDigestMustMatchDatabase(): Promise<void> {
  await withWorkRoot(async (workRoot) => {
    let opened = 0;
    await assert.rejects(
      createOrVerifyVersionSourceSnapshot({
        versionId: VERSION_ID,
        runId: RUN_ID,
        workRoot,
        entries: NESTED_SOURCES.map((s) => s.entry),
        expectedManifestSha256: "0".repeat(64),
        openStream: (entry) => { opened += 1; return openStreamFor(NESTED_SOURCES)(entry); },
      }),
      expectCode("INVALID_MANIFEST"),
    );
    assert.equal(opened, 0, "manifest mismatch must fail before any Storage stream opens");
    console.log("ok: DB manifest digest mismatch is rejected before download");
  });
}

async function testPrivateRootAndConcurrentSameRun(): Promise<void> {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), "vss-root-test-"));
  try {
    const realRoot = path.join(parent, "real");
    const linkedRoot = path.join(parent, "linked");
    await fsp.mkdir(realRoot, { mode: 0o700 });
    await fsp.symlink(realRoot, linkedRoot);
    const entries = NESTED_SOURCES.map((s) => s.entry);
    await assert.rejects(
      createOrVerifyVersionSourceSnapshot({
        versionId: VERSION_ID,
        runId: RUN_ID,
        workRoot: linkedRoot,
        entries,
        expectedManifestSha256: manifestSha256(entries),
        openStream: openStreamFor(NESTED_SOURCES),
      }),
      expectCode("INVALID_INPUT"),
    );
  } finally {
    await fsp.rm(parent, { recursive: true, force: true });
  }

  await withWorkRoot(async (workRoot) => {
    const entries = NESTED_SOURCES.map((s) => s.entry);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const concurrentOpen = (entry: VersionSourceManifestEntry) => (async function* () {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
      const source = NESTED_SOURCES.find((item) => item.entry.storagePath === entry.storagePath);
      assert.ok(source);
      yield source.bytes;
    })();
    const run = () => createOrVerifyVersionSourceSnapshot({
      versionId: VERSION_ID,
      runId: RUN_ID,
      workRoot,
      entries,
      expectedManifestSha256: manifestSha256(entries),
      openStream: concurrentOpen,
    });
    const results = await Promise.all([run(), run()]);
    assert.equal(results.filter((result) => result.reused).length, 1);
    await assertTmpEmpty(workRoot);
    const ref = JSON.parse(await fsp.readFile(path.join(await fsp.realpath(workRoot), "runs", RUN_ID, "source-snapshot.json"), "utf8"));
    assert.equal(ref.version_id, VERSION_ID);
    console.log("ok: private root rejects symlinks and concurrent same-run attempts stay isolated");
  });
}

async function main(): Promise<void> {
  await testPrivateRootAndConcurrentSameRun();
  await testManifestDigestMustMatchDatabase();
  await testNestedSuccessWithMultipleChunks();
  await testReplayReusesWithoutStreaming();
  await testUnsafeAndCollidingPathsRejected();
  await testSizeAndHashMismatch();
  await testPartialStreamCleanupAndRetry();
  await testTamperedFinalFailsClosed();
  await testStaleFinalizePreventsRename();
  console.log("test-settlement-version-source-snapshot: all assertions passed");
}

void main();
