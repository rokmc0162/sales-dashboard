import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import type postgres from "postgres";

import type { Database } from "../supabase/types";
import type { VersionClaimIdentity } from "./version-source-adapter";

export const SETTLEMENT_PUBLICATION_BUCKET = "upload-debug";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SettlementPublicationRow = {
  id: string;
  month: string | Date;
  source_version_id: string;
  job_id: string;
  run_id: string;
  artifact_bucket: string;
  artifact_path: string;
  artifact_sha256: string;
  artifact_size_bytes: number | string;
  workbook_sheet_count: number;
  workbook_row_count: number;
  published_at: string | Date;
};

export type VersionPublicationOutcome =
  | { outcome: "published"; publication: SettlementPublicationRow }
  | { outcome: "retry" | "failed" | "lease_lost" };

export class PublicationEvidenceError extends Error {}

export interface VersionPublicationStore {
  uploadAndVerify(input: {
    path: string; bytes: Buffer; sha256: string; sizeBytes: number;
  }): Promise<void>;
  currentPublicationId(jobId: string): Promise<string | null>;
  publish(input: VersionClaimIdentity & {
    expectedCurrentPublicationId: string | null;
    artifactBucket: string;
    artifactPath: string;
    artifactSha256: string;
    artifactSizeBytes: number;
  }): Promise<SettlementPublicationRow | null>;
  getPublication(id: string): Promise<SettlementPublicationRow | null>;
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeInteger(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new PublicationEvidenceError("publication evidence invalid");
  return parsed;
}

async function readVerifiedCandidate(input: {
  candidatePath: string; expectedSha256: string; expectedSizeBytes: number;
}): Promise<Buffer> {
  if (!path.isAbsolute(input.candidatePath) || path.basename(input.candidatePath) !== "candidate.xlsx"
      || !/^[0-9a-f]{64}$/.test(input.expectedSha256)
      || !Number.isSafeInteger(input.expectedSizeBytes) || input.expectedSizeBytes < 1 || input.expectedSizeBytes > 67_108_864) {
    throw new PublicationEvidenceError("publication evidence invalid");
  }
  const parent = path.dirname(input.candidatePath);
  if (await fsp.realpath(parent) !== parent) throw new PublicationEvidenceError("publication path linked");
  const stat = await fsp.lstat(input.candidatePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== input.expectedSizeBytes) {
    throw new PublicationEvidenceError("publication file invalid");
  }
  const handle = await fsp.open(input.candidatePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== input.expectedSizeBytes
        || digest(bytes) !== input.expectedSha256) {
      throw new PublicationEvidenceError("publication file changed");
    }
    return bytes;
  } finally { await handle.close().catch(() => undefined); }
}

export async function publishClaimedVersionWorkbook(input: {
  identity: VersionClaimIdentity;
  candidatePath: string;
  workbookSha256: string;
  workbookSizeBytes: number;
}, store: VersionPublicationStore): Promise<VersionPublicationOutcome> {
  if (!UUID_RE.test(input.identity.runId)) return { outcome: "failed" };
  let bytes: Buffer;
  try {
    bytes = await readVerifiedCandidate({
      candidatePath: input.candidatePath,
      expectedSha256: input.workbookSha256,
      expectedSizeBytes: input.workbookSizeBytes,
    });
  } catch (error) {
    return { outcome: error instanceof PublicationEvidenceError ? "failed" : "retry" };
  }
  const artifactPath = `publications/${input.identity.runId}/candidate.xlsx`;
  try {
    await store.uploadAndVerify({
      path: artifactPath, bytes, sha256: input.workbookSha256, sizeBytes: input.workbookSizeBytes,
    });
    const expectedCurrentPublicationId = await store.currentPublicationId(input.identity.jobId);
    const publication = await store.publish({
      ...input.identity,
      expectedCurrentPublicationId,
      artifactBucket: SETTLEMENT_PUBLICATION_BUCKET,
      artifactPath,
      artifactSha256: input.workbookSha256,
      artifactSizeBytes: input.workbookSizeBytes,
    });
    if (!publication) return { outcome: "lease_lost" };
    const stored = await store.getPublication(publication.id);
    if (!stored || stored.run_id !== input.identity.runId || stored.job_id !== input.identity.jobId
        || stored.source_version_id !== input.identity.sourceVersionId
        || stored.artifact_bucket !== SETTLEMENT_PUBLICATION_BUCKET
        || stored.artifact_path !== artifactPath || stored.artifact_sha256 !== input.workbookSha256
        || safeInteger(stored.artifact_size_bytes) !== input.workbookSizeBytes) {
      return { outcome: "failed" };
    }
    return { outcome: "published", publication: stored };
  } catch (error) {
    return { outcome: error instanceof PublicationEvidenceError ? "failed" : "retry" };
  }
}

export function createVersionPublicationStore(
  sql: postgres.Sql,
  supabase: SupabaseClient<Database>,
): VersionPublicationStore {
  return {
    async uploadAndVerify(input) {
      const bucket = supabase.storage.from(SETTLEMENT_PUBLICATION_BUCKET);
      const { error } = await bucket.upload(input.path, input.bytes, { contentType: XLSX_MIME, upsert: false });
      const status = String((error as unknown as { statusCode?: string | number } | null)?.statusCode ?? "");
      const duplicate = error && (status === "409" || /already exists|duplicate|resource exists/i.test(error.message));
      if (error && !duplicate) throw new Error("publication storage unavailable");
      const { data, error: downloadError } = await bucket.download(input.path);
      if (downloadError || !data) throw new Error("publication storage read-back unavailable");
      const stored = Buffer.from(await data.arrayBuffer());
      if (stored.byteLength !== input.sizeBytes || digest(stored) !== input.sha256) {
        throw new PublicationEvidenceError("publication storage mismatch");
      }
    },
    async currentPublicationId(jobId) {
      const rows = await sql<Array<{ publication_id: string | null }>>`
        select c.publication_id
        from public.settlement_jobs j
        left join public.settlement_month_current c on c.month = j.month
        where j.id = ${jobId}::uuid
      `;
      return rows[0]?.publication_id ?? null;
    },
    async publish(input) {
      const rows = await sql<SettlementPublicationRow[]>`
        select * from public.publish_settlement_processing_run(
          ${input.jobId}::uuid, ${input.runId}::uuid, ${input.workerId}::text,
          ${input.claimToken}::uuid, ${input.expectedCurrentPublicationId}::uuid,
          ${input.artifactBucket}::text, ${input.artifactPath}::text,
          ${input.artifactSha256}::text, ${input.artifactSizeBytes}::bigint
        )
      `;
      return rows[0] ?? null;
    },
    async getPublication(id) {
      const rows = await sql<SettlementPublicationRow[]>`
        select id,month,source_version_id,job_id,run_id,artifact_bucket,artifact_path,
               artifact_sha256,artifact_size_bytes,workbook_sheet_count,workbook_row_count,published_at
          from public.settlement_publications where id = ${id}::uuid
      `;
      return rows[0] ?? null;
    },
  };
}
