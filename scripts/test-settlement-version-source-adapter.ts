import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  createPostgresVersionSourceFence,
  createPostgresVersionSourceStore,
  createPrivateStorageStreamOpener,
  loadFrozenVersionManifest,
  materializeClaimedVersionSnapshot,
  type FrozenVersionFileRow,
  type FrozenVersionRow,
  type VersionSourceStore,
} from "../src/features/settlement/lib/worker/version-source-adapter";
import {
  VersionSourceSnapshotError,
  type CreateOrVerifyVersionSourceSnapshotInput,
  type VersionSourceSnapshotResult,
} from "../src/features/settlement/lib/worker/version-source-snapshot";

const VERSION_ID = "11111111-2222-4333-8444-555555555555";
const JOB_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RUN_ID = "22222222-3333-4444-8555-666666666666";
const CLAIM_TOKEN = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
const KEY = "test-service-role-key";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileRow(position: number, bytes = Buffer.from(`row-${position}`)): FrozenVersionFileRow {
  const hex = position.toString(16).padStart(32, "0");
  return {
    id: `10000000-0000-4000-8000-${position.toString().padStart(12, "0")}`,
    object_id: `00000000-0000-4000-8000-${position.toString().padStart(12, "0")}`,
    position,
    path_key: `folder/file-${position}.csv`,
    display_name: `folder/File-${position}.csv`,
    size_bytes: bytes.byteLength,
    sha256: digest(bytes),
    storage_path: `intake/202607/${hex}/${hex}`,
  };
}

function versionFor(rows: FrozenVersionFileRow[], manifest = "a".repeat(64)): FrozenVersionRow {
  return {
    id: VERSION_ID,
    settlement_month: "2026-07-01",
    file_count: rows.length,
    total_size_bytes: rows.reduce((sum, row) => sum + Number(row.size_bytes), 0),
    manifest_sha256: manifest,
  };
}

function storeFor(rows: FrozenVersionFileRow[], version = versionFor(rows), calls: Array<[number, number]> = []): VersionSourceStore {
  return {
    getVersion: async () => version,
    listVersionFiles: async (_versionId, offset, limit) => {
      calls.push([offset, limit]);
      return rows.slice(offset, offset + limit);
    },
  };
}

function expectCode(code: VersionSourceSnapshotError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof VersionSourceSnapshotError);
    assert.equal(error.code, code);
    return true;
  };
}

async function testPaginationAndMapping(): Promise<void> {
  const rows = Array.from({ length: 200 }, (_, index) => fileRow(index));
  const calls: Array<[number, number]> = [];
  const result = await loadFrozenVersionManifest(storeFor(rows, versionFor(rows), calls), VERSION_ID);
  assert.deepEqual(calls, [[0, 100], [100, 100]]);
  assert.equal(result.entries.length, 200);
  assert.deepEqual(result.entries[135], {
    versionFileId: rows[135].id,
    objectId: rows[135].object_id,
    position: 135,
    pathKey: rows[135].path_key,
    displayPath: rows[135].display_name,
    sizeBytes: rows[135].size_bytes,
    sha256: rows[135].sha256,
    storagePath: rows[135].storage_path,
  });
  const stringRow = { ...rows[0], position: "0", size_bytes: String(rows[0].size_bytes) };
  const stringVersion = { ...versionFor([rows[0]]), file_count: "1", total_size_bytes: String(rows[0].size_bytes) };
  const stringBacked = await loadFrozenVersionManifest(storeFor([stringRow], stringVersion), VERSION_ID);
  assert.equal(stringBacked.entries[0].sizeBytes, Number(rows[0].size_bytes));
  console.log("ok: frozen manifest is paged 100+100 and mapped exactly");
}

async function testManifestMetadataFailures(): Promise<void> {
  const rows = [fileRow(0), fileRow(1)];
  await assert.rejects(loadFrozenVersionManifest({
    getVersion: async () => null,
    listVersionFiles: async () => { throw new Error("must not list"); },
  }, VERSION_ID), expectCode("INVALID_MANIFEST"));

  await assert.rejects(
    loadFrozenVersionManifest(storeFor(rows.slice(0, 1), versionFor(rows)), VERSION_ID),
    expectCode("INVALID_MANIFEST"),
  );
  await assert.rejects(
    loadFrozenVersionManifest(storeFor(rows, { ...versionFor(rows), total_size_bytes: 999 }), VERSION_ID),
    expectCode("INVALID_MANIFEST"),
  );
  const duplicate = [fileRow(0), fileRow(0)];
  await assert.rejects(
    loadFrozenVersionManifest(storeFor(duplicate, versionFor(duplicate)), VERSION_ID),
    expectCode("INVALID_MANIFEST"),
  );
  const reverse = [fileRow(1), fileRow(0)];
  await assert.rejects(
    loadFrozenVersionManifest(storeFor(reverse, versionFor(reverse)), VERSION_ID),
    expectCode("INVALID_MANIFEST"),
  );
  console.log("ok: missing/count/size/duplicate/order metadata fails closed");
}

async function testPrivateStorageStreaming(): Promise<void> {
  const row = fileRow(0);
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const payload = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  });
  const opener = createPrivateStorageStreamOpener({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: KEY,
    fetch: async (url, init) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response(payload, { status: 200 });
    },
  });
  const stream = await opener({
    versionFileId: row.id,
    objectId: row.object_id,
    position: Number(row.position),
    pathKey: row.path_key,
    displayPath: row.display_name,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    storagePath: row.storage_path,
  });
  const chunks: number[] = [];
  for await (const chunk of stream as ReadableStream<Uint8Array>) chunks.push(...chunk);
  assert.deepEqual(chunks, [1, 2, 3]);
  assert.equal(seenUrl, `https://project.supabase.co/storage/v1/object/authenticated/settlement-intake/${row.storage_path}`);
  const headers = new Headers(seenInit?.headers);
  assert.equal(headers.get("apikey"), KEY);
  assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
  assert.equal(seenInit?.redirect, "error");
  assert.ok(seenInit?.signal instanceof AbortSignal);

  let cancelled = false;
  const errorBody = new ReadableStream({ cancel() { cancelled = true; } });
  const failing = createPrivateStorageStreamOpener({
    supabaseUrl: "http://localhost:54321",
    serviceRoleKey: KEY,
    fetch: async () => new Response(errorBody, { status: 404 }),
  });
  await assert.rejects(failing({ storagePath: row.storage_path } as never), expectCode("SOURCE_MISMATCH"));
  assert.equal(cancelled, true);
  let unsafeFetches = 0;
  const guarded = createPrivateStorageStreamOpener({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: KEY,
    fetch: async () => { unsafeFetches += 1; return new Response(null, { status: 200 }); },
  });
  await assert.rejects(guarded({ storagePath: "intake/202607/../secret" } as never), expectCode("INVALID_MANIFEST"));
  assert.equal(unsafeFetches, 0, "unsafe Storage paths must fail before fetch");
  assert.throws(
    () => createPrivateStorageStreamOpener({ supabaseUrl: "http://example.com", serviceRoleKey: KEY }),
    expectCode("INVALID_INPUT"),
  );
  console.log("ok: private Storage uses authenticated streaming GET and cancels failures");
}

function materialized(input: CreateOrVerifyVersionSourceSnapshotInput): VersionSourceSnapshotResult {
  return {
    snapshotDir: `/tmp/${input.versionId}`,
    manifestDigest: input.expectedManifestSha256,
    fileCount: input.entries.length,
    totalBytes: input.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    reused: false,
  };
}

async function testFencedOrchestration(): Promise<void> {
  const rows = [fileRow(0)];
  const events: string[] = [];
  const base = {
    jobId: JOB_ID,
    runId: RUN_ID,
    sourceVersionId: VERSION_ID,
    workerId: "worker-1",
    claimToken: CLAIM_TOKEN,
    workRoot: "/tmp/work",
    leaseSeconds: 60,
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: KEY,
  };
  const result = await materializeClaimedVersionSnapshot(base, {
    store: storeFor(rows),
    fence: {
      heartbeat: async () => { events.push("heartbeat"); return true; },
      markSnapshotReady: async (input) => {
        events.push("ready");
        assert.equal(input.manifestSha256, "a".repeat(64));
        assert.equal(input.fileCount, 1);
        return true;
      },
    },
    materialize: async (input) => {
      events.push("materialize");
      assert.equal(await input.canFinalize?.(), true);
      return materialized(input);
    },
  });
  assert.equal(result.snapshotReady, true);
  assert.equal(result.settlementMonth, "2026-07-01");
  assert.deepEqual(result.entries, rows.map((row) => ({
    versionFileId: row.id,
    objectId: row.object_id,
    position: Number(row.position),
    pathKey: row.path_key,
    displayPath: row.display_name,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    storagePath: row.storage_path,
  })));
  assert.deepEqual(events, ["heartbeat", "materialize", "heartbeat", "ready"]);

  let loaded = false;
  await assert.rejects(materializeClaimedVersionSnapshot(base, {
    store: { getVersion: async () => { loaded = true; return versionFor(rows); }, listVersionFiles: async () => rows },
    fence: { heartbeat: async () => false, markSnapshotReady: async () => true },
    materialize: async (input) => materialized(input),
  }), expectCode("STALE_RUN"));
  assert.equal(loaded, false);

  let readyCalls = 0;
  await assert.rejects(materializeClaimedVersionSnapshot(base, {
    store: storeFor(rows),
    fence: {
      heartbeat: async () => true,
      markSnapshotReady: async () => { readyCalls += 1; return true; },
    },
    materialize: async (input) => ({ ...materialized(input), fileCount: 2 }),
  }), expectCode("SOURCE_MISMATCH"));
  assert.equal(readyCalls, 0, "mismatched snapshot evidence must never reach the DB ready fence");

  await assert.rejects(materializeClaimedVersionSnapshot(base, {
    store: storeFor(rows),
    fence: { heartbeat: async () => true, markSnapshotReady: async () => false },
    materialize: async (input) => materialized(input),
  }), expectCode("STALE_RUN"));
  console.log("ok: heartbeat and snapshot-ready both require the exact active fence");
}

async function testPostgresWrappers(): Promise<void> {
  const row = fileRow(0);
  const replies: unknown[] = [
    [versionFor([row])],
    [row],
    [{ ok: true }],
    [{ ok: true }],
  ];
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(replies.shift());
  }) as never;
  const store = createPostgresVersionSourceStore(sql);
  const fence = createPostgresVersionSourceFence(sql);
  await store.getVersion(VERSION_ID);
  await store.listVersionFiles(VERSION_ID, 100, 75);
  const identity = {
    jobId: JOB_ID,
    runId: RUN_ID,
    sourceVersionId: VERSION_ID,
    workerId: "worker-1",
    claimToken: CLAIM_TOKEN,
  };
  assert.equal(await fence.heartbeat({ ...identity, leaseSeconds: 60 }), true);
  assert.equal(await fence.markSnapshotReady({
    ...identity,
    manifestSha256: "a".repeat(64),
    fileCount: 1,
    totalBytes: Number(row.size_bytes),
  }), true);

  assert.match(calls[0].text, /select v\.id, m\.month::text as settlement_month/);
  assert.match(calls[0].text, /join public\.settlement_intake_months m on m\.id = v\.intake_id/);
  assert.match(calls[0].text, /settlement_intake_versions/);
  assert.deepEqual(calls[0].values, [VERSION_ID]);
  assert.match(calls[1].text, /select id, object_id, position, path_key, display_name, size_bytes, sha256, storage_path/);
  assert.match(calls[1].text, /order by position asc/);
  assert.deepEqual(calls[1].values, [VERSION_ID, 100, 75]);
  assert.match(calls[2].text, /heartbeat_settlement_processing_run/);
  assert.deepEqual(calls[2].values, [JOB_ID, RUN_ID, "worker-1", CLAIM_TOKEN, 60]);
  assert.match(calls[3].text, /mark_settlement_processing_run_snapshot_ready/);
  assert.deepEqual(calls[3].values, [JOB_ID, RUN_ID, "worker-1", CLAIM_TOKEN, "a".repeat(64), 1, Number(row.size_bytes)]);
  console.log("ok: PostgreSQL wrappers use exact frozen projections and claim-fence argument order");
}

async function main(): Promise<void> {
  await testPostgresWrappers();
  await testPaginationAndMapping();
  await testManifestMetadataFailures();
  await testPrivateStorageStreaming();
  await testFencedOrchestration();
  console.log("test-settlement-version-source-adapter: all assertions passed");
}

void main();
