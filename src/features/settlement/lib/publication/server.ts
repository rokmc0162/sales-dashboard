import "server-only";

import { createHash } from "node:crypto";

import { isValidIntakeMonthKey } from "../intake/contract";
import { createServiceClient } from "../supabase/server";

export type PublishedSettlementStatus = {
  month: string;
  status: "not_submitted" | "queued" | "processing" | "failed" | "published";
  versionNo: number | null;
  currentAvailable: boolean;
  currentVersionNo: number | null;
  sheetCount: number | null;
  rowCount: number | null;
  publishedAt: string | null;
};

export type PublishedArtifact = {
  status: PublishedSettlementStatus;
  bytes: Buffer;
  filename: string;
};

type CurrentPublication = {
  id: string;
  sourceVersionId: string;
  versionNo: number;
  bucket: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  sheetCount: number;
  rowCount: number;
  publishedAt: string;
};

type QueryClient = {
  from(table: string): {
    // Migration 034 tables are not in generated Database types until rollout.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    select(columns: string): any;
  };
};

// Keep the untyped boundary in this server-only module; every returned field
// is validated before it reaches an API response or Storage call.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any {
  return createServiceClient() as unknown as QueryClient;
}

function emptyStatus(month: string): PublishedSettlementStatus {
  return { month, status: "not_submitted", versionNo: null, currentAvailable: false,
    currentVersionNo: null, sheetCount: null, rowCount: null, publishedAt: null };
}

function safePositiveInteger(value: unknown, maximum: number): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= maximum ? number : null;
}

async function loadCurrentPublication(supabase: ReturnType<typeof admin>, month: string): Promise<CurrentPublication | null> {
  const isoMonth = `${month.slice(0, 4)}-${month.slice(4, 6)}-01`;
  const { data: current, error: currentError } = await supabase.from("settlement_month_current")
    .select("publication_id").eq("month", isoMonth).maybeSingle();
  if (currentError) throw new Error("publication pointer unavailable");
  if (!current) return null;
  const { data: rows, error: rowError } = await supabase.from("settlement_publications")
    .select("id,source_version_id,artifact_bucket,artifact_path,artifact_sha256,artifact_size_bytes,workbook_sheet_count,workbook_row_count,published_at")
    .eq("id", current.publication_id).limit(1);
  if (rowError || !rows?.[0]) throw new Error("publication pointer unavailable");
  const row = rows[0];
  const { data: versions, error: versionError } = await supabase.from("settlement_intake_versions")
    .select("version_no").eq("id", row.source_version_id).limit(1);
  if (versionError || !versions?.[0]) throw new Error("publication pointer unavailable");
  const sizeBytes = safePositiveInteger(row.artifact_size_bytes, 67_108_864);
  const sheetCount = safePositiveInteger(row.workbook_sheet_count, 100);
  const rowCount = safePositiveInteger(row.workbook_row_count, 1_000_000);
  const versionNo = safePositiveInteger(versions[0].version_no, 1_000_000);
  if (typeof row.id !== "string" || typeof row.source_version_id !== "string"
      || row.artifact_bucket !== "upload-debug" || typeof row.artifact_path !== "string"
      || !/^publications\/[0-9a-f-]{36}\/candidate[.]xlsx$/.test(row.artifact_path)
      || typeof row.artifact_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.artifact_sha256)
      || sizeBytes === null || sheetCount === null || rowCount === null || versionNo === null
      || typeof row.published_at !== "string") {
    throw new Error("publication artifact invalid");
  }
  return { id: row.id, sourceVersionId: row.source_version_id, versionNo,
    bucket: row.artifact_bucket, path: row.artifact_path, sha256: row.artifact_sha256,
    sizeBytes, sheetCount, rowCount, publishedAt: row.published_at };
}

export async function loadPublishedSettlementStatus(month: string): Promise<PublishedSettlementStatus> {
  if (!isValidIntakeMonthKey(month)) throw new Error("invalid publication month");
  const supabase = admin();
  const current = await loadCurrentPublication(supabase, month);
  const currentFields = current ? { currentAvailable: true, currentVersionNo: current.versionNo,
    sheetCount: current.sheetCount, rowCount: current.rowCount, publishedAt: current.publishedAt } : {};
  const { data: intake, error: intakeError } = await supabase.from("settlement_intake_months")
    .select("id").eq("month_key", month).maybeSingle();
  if (intakeError) throw new Error("publication status unavailable");
  if (!intake) return { ...emptyStatus(month), ...currentFields };
  const { data: versions, error: versionError } = await supabase.from("settlement_intake_versions")
    .select("id,version_no").eq("intake_id", intake.id).order("version_no", { ascending: false }).limit(1);
  if (versionError) throw new Error("publication status unavailable");
  const version = versions?.[0];
  if (!version) return { ...emptyStatus(month), ...currentFields };
  const base = { ...emptyStatus(month), ...currentFields, versionNo: Number(version.version_no) };
  if (current?.sourceVersionId === version.id) return { ...base, status: "published" };
  const { data: jobs, error: jobError } = await supabase.from("settlement_jobs")
    .select("status").eq("source_version_id", version.id).limit(1);
  if (jobError) throw new Error("publication status unavailable");
  const job = jobs?.[0];
  if (!job) return { ...base, status: "queued" };
  const status = job.status === "failed" ? "failed" : job.status === "queued" ? "queued" : "processing";
  return { ...base, status };
}

export async function loadCurrentPublishedArtifact(month: string): Promise<PublishedArtifact | null> {
  if (!isValidIntakeMonthKey(month)) throw new Error("invalid publication month");
  const supabase = admin();
  const current = await loadCurrentPublication(supabase, month);
  if (!current) return null;
  const { data, error } = await supabase.storage.from(current.bucket).download(current.path);
  if (error || !data) throw new Error("publication artifact unavailable");
  const bytes = Buffer.from(await data.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== current.sizeBytes || sha256 !== current.sha256) {
    throw new Error("publication artifact verification failed");
  }
  const status: PublishedSettlementStatus = {
    month, status: "published", versionNo: current.versionNo, currentAvailable: true,
    currentVersionNo: current.versionNo, sheetCount: current.sheetCount,
    rowCount: current.rowCount, publishedAt: current.publishedAt,
  };
  return { status, bytes, filename: `JP_INPUT_${month}_v${current.versionNo}.xlsx` };
}
