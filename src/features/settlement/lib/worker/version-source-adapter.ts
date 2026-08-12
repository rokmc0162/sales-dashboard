import type postgres from "postgres";

import {
  createOrVerifyVersionSourceSnapshot,
  VersionSourceSnapshotError,
  type CreateOrVerifyVersionSourceSnapshotInput,
  type VersionSourceManifestEntry,
  type VersionSourceSnapshotResult,
  type VersionSourceStream,
} from "./version-source-snapshot";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const STORAGE_PATH_RE = /^intake\/[0-9]{6}\/[0-9a-f]{32}\/[0-9a-f]{32}$/;
const PAGE_SIZE = 100;
const INTAKE_BUCKET = "settlement-intake";
const DEFAULT_TIMEOUT_MS = 120_000;

type Sql = postgres.Sql;

export type FrozenVersionRow = {
  id: string;
  settlement_month: string;
  file_count: number | string;
  total_size_bytes: number | string;
  manifest_sha256: string;
};

export type FrozenVersionFileRow = {
  object_id: string;
  position: number | string;
  path_key: string;
  display_name: string;
  size_bytes: number | string;
  sha256: string;
  storage_path: string;
};

export interface VersionSourceStore {
  getVersion(versionId: string): Promise<FrozenVersionRow | null>;
  listVersionFiles(versionId: string, offset: number, limit: number): Promise<FrozenVersionFileRow[]>;
}

export interface VersionSourceFence {
  heartbeat(input: VersionClaimIdentity & { leaseSeconds: number }): Promise<boolean>;
  markSnapshotReady(input: VersionClaimIdentity & {
    manifestSha256: string;
    fileCount: number;
    totalBytes: number;
  }): Promise<boolean>;
}

export type VersionClaimIdentity = {
  jobId: string;
  runId: string;
  sourceVersionId: string;
  workerId: string;
  claimToken: string;
};

export type MaterializeClaimedVersionInput = VersionClaimIdentity & {
  workRoot: string;
  leaseSeconds: number;
  supabaseUrl: string;
  serviceRoleKey: string;
  storageTimeoutMs?: number;
};

export interface VersionSourceAdapterDependencies {
  store: VersionSourceStore;
  fence: VersionSourceFence;
  fetch?: typeof fetch;
  materialize?: (
    input: CreateOrVerifyVersionSourceSnapshotInput,
  ) => Promise<VersionSourceSnapshotResult>;
}

export type SnapshotReadyResult = VersionSourceSnapshotResult & {
  snapshotReady: true;
  settlementMonth: string;
  entries: VersionSourceManifestEntry[];
};

function fail(code: "INVALID_INPUT" | "INVALID_MANIFEST" | "SOURCE_MISMATCH" | "STALE_RUN", message: string): never {
  throw new VersionSourceSnapshotError(code, message);
}

function requireUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) fail("INVALID_INPUT", `invalid ${label}`);
}

function databaseInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number"
    ? value
    : (/^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : Number.NaN);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail("INVALID_MANIFEST", `invalid ${label}`);
  return parsed;
}

function requireClaim(input: MaterializeClaimedVersionInput): void {
  requireUuid(input.jobId, "job id");
  requireUuid(input.runId, "run id");
  requireUuid(input.sourceVersionId, "source version id");
  requireUuid(input.claimToken, "claim token");
  if (!input.workerId || input.workerId.length > 128) fail("INVALID_INPUT", "invalid worker id");
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 30 || input.leaseSeconds > 14_400) {
    fail("INVALID_INPUT", "invalid lease seconds");
  }
}

function validateSupabaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("INVALID_INPUT", "invalid Supabase URL");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    fail("INVALID_INPUT", "Supabase URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) fail("INVALID_INPUT", "unsafe Supabase URL");
  return url;
}

function storageObjectUrl(base: URL, storagePath: string): URL {
  if (!STORAGE_PATH_RE.test(storagePath)) fail("INVALID_MANIFEST", "invalid frozen Storage path");
  const encoded = storagePath.split("/").map(encodeURIComponent).join("/");
  return new URL(`/storage/v1/object/authenticated/${INTAKE_BUCKET}/${encoded}`, base);
}

export function createPrivateStorageStreamOpener(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): (entry: VersionSourceManifestEntry) => Promise<VersionSourceStream> {
  const base = validateSupabaseUrl(input.supabaseUrl);
  if (!input.serviceRoleKey) fail("INVALID_INPUT", "service-role key is required");
  const fetchImpl = input.fetch ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    fail("INVALID_INPUT", "invalid Storage timeout");
  }
  return async (entry) => {
    const response = await fetchImpl(storageObjectUrl(base, entry.storagePath), {
      method: "GET",
      headers: {
        apikey: input.serviceRoleKey,
        Authorization: `Bearer ${input.serviceRoleKey}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel().catch(() => {});
      fail("SOURCE_MISMATCH", `private source download failed with status ${response.status}`);
    }
    return response.body;
  };
}

export async function loadFrozenVersionManifest(
  store: VersionSourceStore,
  versionId: string,
): Promise<{ version: FrozenVersionRow; entries: VersionSourceManifestEntry[] }> {
  requireUuid(versionId, "source version id");
  const version = await store.getVersion(versionId);
  if (!version || version.id !== versionId) fail("INVALID_MANIFEST", "unknown source version");
  if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(version.settlement_month)) {
    fail("INVALID_MANIFEST", "invalid frozen settlement month");
  }
  const fileCount = databaseInteger(version.file_count, "frozen file count");
  const totalSize = databaseInteger(version.total_size_bytes, "frozen total size");
  if (fileCount < 1 || fileCount > 200) {
    fail("INVALID_MANIFEST", "invalid frozen file count");
  }
  if (totalSize < 1) {
    fail("INVALID_MANIFEST", "invalid frozen total size");
  }
  if (!SHA256_RE.test(version.manifest_sha256)) fail("INVALID_MANIFEST", "invalid frozen manifest digest");

  const rows: FrozenVersionFileRow[] = [];
  for (let offset = 0; offset < fileCount; offset += PAGE_SIZE) {
    const limit = Math.min(PAGE_SIZE, fileCount - offset);
    const page = await store.listVersionFiles(versionId, offset, limit);
    if (page.length > limit) fail("INVALID_MANIFEST", "version file page exceeded its requested bound");
    rows.push(...page);
    if (page.length !== limit) break;
  }
  if (rows.length !== fileCount) fail("INVALID_MANIFEST", "frozen version file count mismatch");

  let prior = -1;
  let total = 0;
  const objects = new Set<string>();
  const entries = rows.map((row): VersionSourceManifestEntry => {
    const position = databaseInteger(row.position, "frozen position");
    const sizeBytes = databaseInteger(row.size_bytes, "frozen file size");
    if (position <= prior) {
      fail("INVALID_MANIFEST", "frozen version positions are not strictly ascending");
    }
    prior = position;
    if (objects.has(row.object_id)) fail("INVALID_MANIFEST", "duplicate frozen object id");
    objects.add(row.object_id);
    total += sizeBytes;
    return {
      objectId: row.object_id,
      position,
      pathKey: row.path_key,
      displayPath: row.display_name,
      sizeBytes,
      sha256: row.sha256,
      storagePath: row.storage_path,
    };
  });
  if (total !== totalSize) fail("INVALID_MANIFEST", "frozen version total size mismatch");
  return { version, entries };
}

export async function materializeClaimedVersionSnapshot(
  input: MaterializeClaimedVersionInput,
  deps: VersionSourceAdapterDependencies,
): Promise<SnapshotReadyResult> {
  requireClaim(input);
  const identity: VersionClaimIdentity = {
    jobId: input.jobId,
    runId: input.runId,
    sourceVersionId: input.sourceVersionId,
    workerId: input.workerId,
    claimToken: input.claimToken,
  };
  if (!(await deps.fence.heartbeat({ ...identity, leaseSeconds: input.leaseSeconds }))) {
    fail("STALE_RUN", "claim fence rejected before source snapshot");
  }
  const { version, entries } = await loadFrozenVersionManifest(deps.store, input.sourceVersionId);
  const heartbeat = () => deps.fence.heartbeat({ ...identity, leaseSeconds: input.leaseSeconds });
  const materialize = deps.materialize ?? createOrVerifyVersionSourceSnapshot;
  const result = await materialize({
    versionId: input.sourceVersionId,
    runId: input.runId,
    workRoot: input.workRoot,
    entries,
    expectedManifestSha256: version.manifest_sha256,
    openStream: createPrivateStorageStreamOpener({
      supabaseUrl: input.supabaseUrl,
      serviceRoleKey: input.serviceRoleKey,
      fetch: deps.fetch,
      timeoutMs: input.storageTimeoutMs,
    }),
    canFinalize: heartbeat,
  });
  const expectedTotalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (
    result.manifestDigest !== version.manifest_sha256
    || result.fileCount !== entries.length
    || result.totalBytes !== expectedTotalBytes
  ) {
    fail("SOURCE_MISMATCH", "snapshot evidence does not match the frozen source version");
  }
  const ready = await deps.fence.markSnapshotReady({
    ...identity,
    manifestSha256: result.manifestDigest,
    fileCount: result.fileCount,
    totalBytes: result.totalBytes,
  });
  if (!ready) fail("STALE_RUN", "claim fence rejected snapshot-ready evidence");
  return {
    ...result,
    snapshotReady: true,
    settlementMonth: version.settlement_month,
    entries: entries.map((entry) => ({ ...entry })),
  };
}

export function createPostgresVersionSourceFence(sql: Sql): VersionSourceFence {
  return {
    async heartbeat(input) {
      const rows = await sql<Array<{ ok: boolean }>>`
        select public.heartbeat_settlement_processing_run(
          ${input.jobId}::uuid,
          ${input.runId}::uuid,
          ${input.workerId}::text,
          ${input.claimToken}::uuid,
          ${input.leaseSeconds}::integer
        ) as ok
      `;
      return rows[0]?.ok === true;
    },
    async markSnapshotReady(input) {
      const rows = await sql<Array<{ ok: boolean }>>`
        select public.mark_settlement_processing_run_snapshot_ready(
          ${input.jobId}::uuid,
          ${input.runId}::uuid,
          ${input.workerId}::text,
          ${input.claimToken}::uuid,
          ${input.manifestSha256}::text,
          ${input.fileCount}::integer,
          ${input.totalBytes}::bigint
        ) as ok
      `;
      return rows[0]?.ok === true;
    },
  };
}

export function createPostgresVersionSourceStore(sql: Sql): VersionSourceStore {
  return {
    async getVersion(versionId) {
      const rows = await sql<FrozenVersionRow[]>`
        select v.id, m.month::text as settlement_month,
               v.file_count, v.total_size_bytes, v.manifest_sha256
        from public.settlement_intake_versions v
        join public.settlement_intake_months m on m.id = v.intake_id
        where v.id = ${versionId}::uuid
        limit 1
      `;
      return rows[0] ?? null;
    },
    async listVersionFiles(versionId, offset, limit) {
      return sql<FrozenVersionFileRow[]>`
        select object_id, position, path_key, display_name, size_bytes, sha256, storage_path
        from public.settlement_intake_version_files
        where version_id = ${versionId}::uuid
        order by position asc
        offset ${offset}::integer
        limit ${limit}::integer
      `;
    },
  };
}
