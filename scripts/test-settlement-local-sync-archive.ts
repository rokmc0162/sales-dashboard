import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { archiveVersionToLocalSync, LocalSyncArchiveError } from "../src/features/settlement/lib/worker/local-sync-archive";
import type { VersionSourceManifestEntry } from "../src/features/settlement/lib/worker/version-source-snapshot";

const TEST_ROOT = path.resolve(`.tmp/local-sync-archive-${process.pid}-${randomUUID()}`);
const BASE = path.join(TEST_ROOT, "allowed");
const ROOT = path.join(BASE, "Sales_RVJP");
const SNAPSHOT = path.join(TEST_ROOT, "snapshot");
const ARTIFACT = path.join(TEST_ROOT, "artifact");
const VERSION_ID = "30000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function makeEntry(position: number, displayPath: string, bytes: Buffer): VersionSourceManifestEntry {
  return {
    versionFileId: `50000000-0000-4000-8000-${position.toString().padStart(12, "0")}`,
    objectId: `60000000-0000-4000-8000-${position.toString().padStart(12, "0")}`,
    position,
    pathKey: displayPath.toLowerCase().normalize("NFC"),
    displayPath,
    sizeBytes: bytes.length,
    sha256: sha(bytes),
    storagePath: `intake/202608/${position.toString(16).padStart(32, "0")}/${position.toString(16).padStart(32, "0")}`,
  };
}

async function fixture() {
  await fsp.mkdir(path.join(SNAPSHOT, "files", "Folder", "nested"), { recursive: true, mode: 0o700 });
  await fsp.mkdir(ARTIFACT, { recursive: true, mode: 0o700 });
  const first = Buffer.from("first-source");
  const second = Buffer.from("second-source");
  const entries = [makeEntry(0, "first.csv", first), makeEntry(1, "Folder/nested/second.pdf", second)];
  await Promise.all([
    fsp.writeFile(path.join(SNAPSHOT, "manifest.json"), Buffer.from("manifest"), { mode: 0o600 }),
    fsp.writeFile(path.join(SNAPSHOT, "files", entries[0].displayPath), first, { mode: 0o600 }),
    fsp.writeFile(path.join(SNAPSHOT, "files", entries[1].displayPath), second, { mode: 0o600 }),
    fsp.writeFile(path.join(ARTIFACT, "office-verified.xlsx"), Buffer.from("workbook"), { mode: 0o600 }),
    fsp.writeFile(path.join(ARTIFACT, "evidence.json"), Buffer.from("{\"ok\":true}\n"), { mode: 0o600 }),
  ]);
  return entries;
}

function input(entries: VersionSourceManifestEntry[], canContinue?: () => boolean | Promise<boolean>) {
  return {
    root: ROOT,
    allowedBaseRoot: BASE,
    monthKey: "202608",
    versionNo: 1,
    sourceVersionId: VERSION_ID,
    runId: RUN_ID,
    snapshotDir: SNAPSHOT,
    entries,
    officeVerifiedPath: path.join(ARTIFACT, "office-verified.xlsx"),
    evidencePath: path.join(ARTIFACT, "evidence.json"),
    canContinue,
  };
}

function expectCode(code: LocalSyncArchiveError["code"]) {
  return (error: unknown) => error instanceof LocalSyncArchiveError && error.code === code;
}

async function main() {
  await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  await fsp.mkdir(ROOT, { recursive: true, mode: 0o700 });
  try {
    const entries = await fixture();
    const first = await archiveVersionToLocalSync(input(entries));
    assert.equal(first.reused, false);
    assert.equal(first.relativeArchivePath, `2026-08/v001-${VERSION_ID}/run-${RUN_ID}`);
    assert.equal(await fsp.readFile(path.join(first.archiveDir, "원본", "Folder", "nested", "second.pdf"), "utf8"), "second-source");
    assert.equal(await fsp.readFile(path.join(first.archiveDir, "결과", "office-verified.xlsx"), "utf8"), "workbook");
    assert.equal((await fsp.stat(path.join(first.archiveDir, "manifest.json"))).mode & 0o777, 0o600);
    let replayHeartbeats = 0;
    const replay = await archiveVersionToLocalSync(input(entries, () => { replayHeartbeats += 1; return true; }));
    assert.equal(replay.reused, true);
    assert.ok(replayHeartbeats >= entries.length + 4, "replay hashing must keep the lease alive");
    assert.equal(replay.evidenceSha256, first.evidenceSha256);

    const concurrentVersion = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const concurrentRun = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const concurrentInput = {
      ...input(entries),
      sourceVersionId: concurrentVersion,
      runId: concurrentRun,
    };
    const concurrent = await Promise.all([
      archiveVersionToLocalSync(concurrentInput),
      archiveVersionToLocalSync(concurrentInput),
    ]);
    assert.equal(concurrent.every((item) => item.relativeArchivePath === concurrent[0].relativeArchivePath), true);
    assert.equal(concurrent.some((item) => item.reused), true, "one concurrent creator must converge by exact replay");
    assert.deepEqual((await fsp.readdir(path.dirname(concurrent[0].archiveDir))).sort(), [`run-${concurrentRun}`]);

    await fsp.writeFile(path.join(first.archiveDir, "원본", "first.csv"), "tampered");
    await assert.rejects(archiveVersionToLocalSync(input(entries)), expectCode("ARCHIVE_CONFLICT"));
    await fsp.rm(first.archiveDir, { recursive: true, force: true });

    const linked = path.join(SNAPSHOT, "files", "linked.csv");
    await fsp.symlink(path.join(SNAPSHOT, "files", "first.csv"), linked);
    const linkedEntry = makeEntry(0, "linked.csv", Buffer.from("first-source"));
    await assert.rejects(archiveVersionToLocalSync(input([linkedEntry])), expectCode("UNSAFE_PATH"));
    await fsp.rm(linked);

    const traversal = { ...entries[0], displayPath: "../escape.csv", pathKey: "../escape.csv" };
    await assert.rejects(archiveVersionToLocalSync(input([traversal])), expectCode("INVALID_INPUT"));
    const collision = [{ ...entries[0], displayPath: "first.csv", pathKey: "first.csv" }, { ...entries[1], position: 1, displayPath: "FIRST.CSV", pathKey: "first.csv" }];
    await assert.rejects(archiveVersionToLocalSync(input(collision)), expectCode("INVALID_INPUT"));

    let calls = 0;
    await assert.rejects(archiveVersionToLocalSync(input(entries, () => ++calls < 3)), expectCode("INTERRUPTED"));
    const versionRoot = path.join(ROOT, "2026-08", `v001-${VERSION_ID}`);
    const children = await fsp.readdir(versionRoot).catch(() => []);
    assert.deepEqual(children, [], "interruption must leave no final run or owned temp directory");

    const rootLink = path.join(BASE, "linked-root");
    await fsp.symlink(ROOT, rootLink);
    await assert.rejects(archiveVersionToLocalSync({ ...input(entries), root: rootLink }), expectCode("UNSAFE_PATH"));

    console.log("test-settlement-local-sync-archive: all assertions passed");
  } finally {
    await fsp.rm(TEST_ROOT, { recursive: true, force: true });
  }
}

void main();
