/**
 * POST /api/settlement/upload
 *
 * Supports two upload modes:
 *   - multipart/form-data with raw files, archived before parsing
 *   - application/json { upload_id } for files already uploaded directly to
 *     private Supabase Storage through /api/settlement/uploads/prepare
 *
 * Both modes converge on the same buffer -> parse -> raw_records ->
 * sales_records business logic.
 */
import { NextResponse } from "next/server";

import { supabaseServer } from "@/lib/supabase-server";
import { requireSettlementApiAuth } from "@/features/settlement/lib/api-auth";
import { readBoundedJson } from "@/lib/auth-route.server";
import { archiveBeforeParse } from "@/features/settlement/lib/storage/archive-before-parse";
import {
  parseProcessUploadPayload,
  validateFolderHint,
} from "@/features/settlement/lib/storage/direct-upload";
import {
  createSupabasePreparedUploadStore,
  loadPreparedUploadLookups,
  processParsedUpload,
  processPreparedUpload,
  type ParsedFile,
  type UploadResult,
} from "@/features/settlement/lib/worker/process-prepared-upload";
import {
  createHeartbeatJsonStream,
  wantsHeartbeatStream,
} from "@/features/settlement/lib/storage/heartbeat-stream";

export const runtime = "nodejs";
// Pro plan extended max duration (beta) allows up to 1800s; deterministic
// image-PDF OCR (Shueisha) was still hitting the 800s limit in production.
export const maxDuration = 1800;
const MAX_MULTIPART_FILES = 200;
const MAX_MULTIPART_BYTES = 50 * 1024 * 1024;

export async function POST(request: Request) {
  const unauthorized = await requireSettlementApiAuth(request);
  if (unauthorized) return unauthorized;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    if (wantsHeartbeatStream(request)) {
      return streamPreparedUploadWithHeartbeat(request);
    }
    return handlePreparedUpload(request);
  }
  const contentLengthHeader = request.headers.get("content-length");
  if (!contentLengthHeader || !/^\d+$/.test(contentLengthHeader)) {
    return NextResponse.json({ error: "content-length required" }, { status: 411 });
  }
  const contentLength = Number(contentLengthHeader);
  if (contentLength > MAX_MULTIPART_BYTES + 512_000) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }
  return handleMultipartUpload(request);
}

/**
 * Opt-in (x-settlement-heartbeat: 1) wrapper around handlePreparedUpload for
 * authenticated JSON process requests only. Long OCR parses emit no bytes for
 * minutes, so intermediaries reset the idle connection; streaming JSON
 * whitespace keeps it alive. The status is fixed at 200 once streaming starts,
 * so error/skip bodies travel unchanged and the client inspects the payload.
 */
function streamPreparedUploadWithHeartbeat(request: Request): Response {
  const stream = createHeartbeatJsonStream(async () => {
    const response = await handlePreparedUpload(request);
    return await response.text();
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      // Ask buffering proxies to pass heartbeat bytes through immediately.
      "x-accel-buffering": "no",
    },
  });
}

async function handleMultipartUpload(request: Request) {
  const [sharedSupabase, parsers, aggregation, archive] = await Promise.all([
    import("@/lib/supabase-server"),
    import("@/features/settlement/lib/parsers"),
    import("@/features/settlement/lib/aggregation/to-sales-records"),
    import("@/features/settlement/lib/storage/archive"),
  ]);
  const { supabaseServer: supabase } = sharedSupabase;
  const { parseFile } = parsers;
  const { toSalesRecords, buildLookupMaps } = aggregation;
  const { writeToArchive } = archive;
  const store = createSupabasePreparedUploadStore(supabase);

  const form = await request.formData();
  const files = form.getAll("files") as File[];
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length > MAX_MULTIPART_FILES || totalBytes > MAX_MULTIPART_BYTES) {
    return NextResponse.json({ error: "upload batch too large" }, { status: 413 });
  }
  const folderHintValidation = validateFolderHint(form.get("folder"));
  if (!folderHintValidation.ok) {
    return NextResponse.json({ error: folderHintValidation.error }, { status: 400 });
  }
  const folderHint = folderHintValidation.value;
  const activeMonthRaw = (form.get("activeMonth") as string) || "";
  const activeMonth = /^\d{4}-\d{2}-01$/.test(activeMonthRaw) ? activeMonthRaw : null;
  const fallbackMonthRaw = (form.get("fallbackMonth") as string) || "";
  const fallbackMonth = /^\d{4}-\d{2}-01$/.test(fallbackMonthRaw) ? fallbackMonthRaw : null;
  const replaceMonth = form.get("replaceMonth") === "1";
  const runLabel = buildRunLabel(request, form);

  if (replaceMonth) {
    const adminUnauthorized = await requireSettlementApiAuth(request, "admin");
    if (adminUnauthorized) return adminUnauthorized;
    return NextResponse.json(
      {
        error:
          "automatic month replacement is disabled until atomic staging is available; use the explicit admin reset workflow",
      },
      { status: 409 },
    );
  }

  if (files.length === 0) {
    return NextResponse.json({ error: "no files" }, { status: 400 });
  }
  console.log(`[upload]${runLabel} received ${files.length} file(s)`);

  const lookups = await loadPreparedUploadLookups(store, buildLookupMaps);
  if ("error" in lookups) {
    return NextResponse.json({ error: lookups.error }, { status: 500 });
  }

  const results: UploadResult[] = [];
  for (const f of files) {
    const buffer = Buffer.from(await f.arrayBuffer());
    const { data: uploadRow, error: insertErr } = await supabase
      .from("raw_uploads")
      .insert({
        filename: f.name,
        storage_path: `(parsing) ${f.name}`,
        size_bytes: buffer.byteLength,
        content_type: f.type,
        settlement_month: activeMonth,
        status: "parsing",
      })
      .select("id")
      .single();

    if (insertErr || !uploadRow) {
      const msg = insertErr?.message ?? "upload insert failed";
      console.error(`[upload]${runLabel} raw_uploads insert failed`);
      results.push({ file: f.name, error: msg });
      continue;
    }
    console.log(`[upload]${runLabel} parsing upload_id=${uploadRow.id} (${buffer.byteLength} bytes)`);

    const coordinated = await archiveBeforeParse<ParsedFile>(buffer, {
      archive: () => writeToArchive(f.name, buffer, activeMonth, supabase),
      recordArchived: async (path, sha256) => {
        const { error } = await supabase
          .from("raw_uploads")
          .update({ storage_path: path, sha256, archived_at: new Date().toISOString() })
          .eq("id", uploadRow.id);
        if (error) throw new Error(error.message);
      },
      parse: () => parseFile({ filename: f.name, buffer, folderName: folderHint }),
    });

    if (!coordinated.ok) {
      const msg =
        coordinated.stage === "parse"
          ? `parse failed: ${coordinated.error}`
          : coordinated.stage === "archive"
            ? `archive failed: ${coordinated.error}`
            : `archive record failed: ${coordinated.error}`;
      console.error(`[upload]${runLabel} upload_id=${uploadRow.id}: archive/parse failed`);
      const failedUpdateError = await store.updateUpload(uploadRow.id, {
        parse_error: msg,
        storage_path: coordinated.archivePath ?? `(not archived) ${f.name}`,
        sha256: coordinated.sha256,
        status: "failed",
        parsed_at: new Date().toISOString(),
      });
      if (failedUpdateError) {
        console.error(`[upload]${runLabel} upload_id=${uploadRow.id}: failed-status update error`);
      }
      results.push({ file: f.name, error: msg });
      continue;
    }

    results.push(await processParsedUpload({
      store,
      uploadId: uploadRow.id,
      filename: f.name,
      parsed: coordinated.parsed,
      activeMonth,
      fallbackMonth,
      lookups: lookups.value,
      toSalesRecords,
      runLabel,
      // Legacy multipart archives files but never compares SHAs, so identical
      // reuploads reach the insert stage and must be suppressed there.
      exactSourceGateApplied: false,
    }));
  }

  return NextResponse.json({ results });
}

async function handlePreparedUpload(request: Request) {
  let body: unknown;
  try {
    body = await readBoundedJson(request, 8_192);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { uploadId, folderHint } = parseProcessUploadPayload(body);
  if (!folderHint.ok) {
    return NextResponse.json({ error: folderHint.error }, { status: 400 });
  }

  const [parsers, aggregation] = await Promise.all([
    import("@/features/settlement/lib/parsers"),
    import("@/features/settlement/lib/aggregation/to-sales-records"),
  ]);
  const outcome = await processPreparedUpload({
    uploadId: String(uploadId ?? ""),
    folderHint: folderHint.value,
  }, {
    store: createSupabasePreparedUploadStore(supabaseServer),
    parseFile: parsers.parseFile,
    toSalesRecords: aggregation.toSalesRecords,
    buildLookupMaps: aggregation.buildLookupMaps,
  });
  return NextResponse.json(outcome.body, { status: outcome.status });
}

function buildRunLabel(request: Request, form: FormData): string {
  const rawRunId =
    request.headers.get("x-settlement-upload-run-id") ||
    (typeof form.get("uploadRunId") === "string" ? (form.get("uploadRunId") as string) : "");
  const uploadRunId = rawRunId.replace(/[^\w.-]/g, "").slice(0, 64) || null;
  return uploadRunId ? ` run=${uploadRunId}` : "";
}
