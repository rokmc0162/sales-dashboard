import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  LookupMaps,
  TransformContext,
} from "@/features/settlement/lib/aggregation/to-sales-records";
import {
  STRICT_KEY_COLUMNS,
  suppressDuplicatesAtInsert,
} from "@/features/settlement/lib/aggregation/strict-record-key";
import { resolveSettlementMonth } from "@/features/settlement/lib/resolve-settlement-month";
import {
  DIRECT_UPLOAD_BUCKET,
  TERMINAL_UPLOAD_STATUSES,
  evaluateExactSourceDuplicate,
  isZeroRowParseFailure,
  prepareDirectUploadForParse,
  statusAfterParseMetadata,
  type DirectUploadRow,
  type ExactSourceCandidate,
  type ExactSourceDuplicateDecision,
} from "@/features/settlement/lib/storage/direct-upload";
import type {
  Database,
  Json,
  RawUploadInsert,
  SalesRecordInsert,
  TitleAliasRow,
  TitleRow,
} from "@/features/settlement/lib/supabase/types";

type ClientRow = Database["public"]["Tables"]["clients"]["Row"];
type ChannelRow = Database["public"]["Tables"]["channels"]["Row"];

export type ParseFile = typeof import("@/features/settlement/lib/parsers").parseFile;
export type ParsedFile = Awaited<ReturnType<ParseFile>>;
export type ToSalesRecords = typeof import("@/features/settlement/lib/aggregation/to-sales-records").toSalesRecords;
export type BuildLookupMaps = typeof import("@/features/settlement/lib/aggregation/to-sales-records").buildLookupMaps;
export type UploadResult = Record<string, unknown>;

type UploadPatch = Partial<RawUploadInsert>;
type InsertedRaw = { id: string; row_index: number };

export interface PreparedUploadStore {
  getUpload(uploadId: string): Promise<DirectUploadRow | null>;
  download(path: string): Promise<Buffer>;
  markParsing(uploadId: string, sha256: string): Promise<"updated" | "not_uploaded">;
  findExactDuplicates(sha256: string, month: string, uploadId: string): Promise<ExactSourceCandidate[]>;
  updateUpload(uploadId: string, fields: UploadPatch): Promise<string | null>;
  loadLookupRows(): Promise<{
    clients: ClientRow[];
    channels: ChannelRow[];
    titles: TitleRow[];
    titleAliases: TitleAliasRow[];
  }>;
  insertRawRecords(rows: Array<{ upload_id: string; row_index: number; data: Json }>): Promise<InsertedRaw[]>;
  listExistingSalesRecords(month: string): Promise<Record<string, unknown>[]>;
  insertSalesRecords(rows: SalesRecordInsert[]): Promise<number>;
}

export interface PreparedUploadProcessorDependencies {
  store: PreparedUploadStore;
  parseFile: ParseFile;
  toSalesRecords: ToSalesRecords;
  buildLookupMaps: BuildLookupMaps;
  now?: () => string;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export type PreparedUploadOutcome = {
  status: number;
  body: { results: UploadResult[] } | { error: string };
};

export type ProcessParsedUploadArgs = {
  store: PreparedUploadStore;
  uploadId: string;
  filename: string;
  parsed: ParsedFile;
  activeMonth: string | null;
  fallbackMonth: string | null;
  lookups: LookupMaps;
  toSalesRecords: ToSalesRecords;
  runLabel?: string;
  exactSourceGateApplied: boolean;
  now?: () => string;
  logger?: Pick<Console, "log" | "warn" | "error">;
};

const defaultNow = () => new Date().toISOString();

/**
 * Supabase adapter shared by the legacy route and the native worker. Business
 * logic lives below this boundary so deterministic tests can inject a store.
 */
export function createSupabasePreparedUploadStore(
  supabase: SupabaseClient,
  now: () => string = defaultNow,
): PreparedUploadStore {
  return {
    async getUpload(id) {
      const { data, error } = await supabase
        .from("raw_uploads")
        .select("id, filename, storage_path, size_bytes, content_type, settlement_month, status")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as DirectUploadRow | null;
    },
    async download(path) {
      const { data, error } = await supabase.storage.from(DIRECT_UPLOAD_BUCKET).download(path);
      if (error || !data) throw new Error(error?.message ?? "download failed");
      return Buffer.from(await data.arrayBuffer());
    },
    async markParsing(id, sha256) {
      const { data, error } = await supabase
        .from("raw_uploads")
        .update({ status: "parsing", sha256, archived_at: now() })
        .eq("id", id)
        .eq("status", "uploaded")
        .select("id");
      if (error) throw new Error(error.message);
      return data && data.length === 1 ? "updated" : "not_uploaded";
    },
    async findExactDuplicates(sha256, month, uploadId) {
      const { data, error } = await supabase
        .from("raw_uploads")
        .select("id, filename, status, sha256, settlement_month, parsed_rows")
        .eq("sha256", sha256)
        .eq("settlement_month", month)
        .neq("id", uploadId)
        .in("status", TERMINAL_UPLOAD_STATUSES as string[])
        .limit(20)
        .returns<ExactSourceCandidate[]>();
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    async updateUpload(id, fields) {
      const { error } = await supabase.from("raw_uploads").update(fields).eq("id", id);
      return error?.message ?? null;
    },
    async loadLookupRows() {
      const [
        { data: clients, error: clientsError },
        { data: channels, error: channelsError },
        { data: titles, error: titlesError },
        { data: titleAliases, error: aliasesError },
      ] = await Promise.all([
        supabase.from("clients").select("*"),
        supabase.from("channels").select("*"),
        supabase.from("titles").select("*"),
        supabase.from("title_aliases").select("*"),
      ]);
      if (clientsError || channelsError || titlesError || aliasesError) {
        throw new Error([
          clientsError?.message,
          channelsError?.message,
          titlesError?.message,
          aliasesError?.message,
        ].filter(Boolean).join("; "));
      }
      return {
        clients: (clients ?? []) as ClientRow[],
        channels: (channels ?? []) as ChannelRow[],
        titles: (titles ?? []) as TitleRow[],
        titleAliases: (titleAliases ?? []) as TitleAliasRow[],
      };
    },
    async insertRawRecords(rows) {
      const { data, error } = await supabase
        .from("raw_records")
        .insert(rows)
        .select("id, row_index");
      if (error) throw new Error(error.message);
      return (data ?? []) as InsertedRaw[];
    },
    async listExistingSalesRecords(month) {
      const rows: Record<string, unknown>[] = [];
      const pageSize = 1000;
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await supabase
          .from("sales_records")
          .select(STRICT_KEY_COLUMNS)
          .eq("settlement_batch", month)
          .range(offset, offset + pageSize - 1)
          .returns<Record<string, unknown>[]>();
        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;
        rows.push(...data);
        if (data.length < pageSize) break;
      }
      return rows;
    },
    async insertSalesRecords(rows) {
      const { error, data } = await supabase.from("sales_records").insert(rows).select("id");
      if (error) throw new Error(error.message);
      return data?.length ?? 0;
    },
  };
}

export async function loadPreparedUploadLookups(
  store: PreparedUploadStore,
  buildLookupMaps: BuildLookupMaps,
): Promise<{ value: LookupMaps } | { error: string }> {
  try {
    const rows = await store.loadLookupRows();
    return { value: buildLookupMaps(rows) };
  } catch (error) {
    return { error: `failed to load lookups: ${(error as Error).message}` };
  }
}

/** Reusable prepared-upload pipeline used by the route and Mac worker. */
export async function processPreparedUpload(
  input: { uploadId: string; folderHint?: string },
  deps: PreparedUploadProcessorDependencies,
): Promise<PreparedUploadOutcome> {
  const now = deps.now ?? defaultNow;
  const logger = deps.logger ?? console;
  const prepared = await prepareDirectUploadForParse(input.uploadId, {
    getUpload: deps.store.getUpload,
    download: deps.store.download,
    markParsing: deps.store.markParsing,
    markFailed: async (id, message) => {
      await markUploadFailed(deps.store, id, { parse_error: message }, now, logger);
    },
  });

  if (!prepared.ok) {
    if (prepared.skipped) {
      return {
        status: 200,
        body: {
          results: [{
            upload_id: prepared.row?.id,
            file: prepared.row?.filename,
            skipped: true,
            skip_reason: prepared.error,
            status: prepared.row?.status,
          }],
        },
      };
    }
    return { status: prepared.status, body: { error: prepared.error } };
  }

  let duplicate: ExactSourceDuplicateDecision = { skip: false };
  let exactSourceGateApplied = false;
  if (prepared.row.settlement_month) {
    try {
      const candidates = await deps.store.findExactDuplicates(
        prepared.sha256,
        prepared.row.settlement_month,
        prepared.row.id,
      );
      duplicate = evaluateExactSourceDuplicate(prepared.row, prepared.sha256, candidates);
      exactSourceGateApplied = true;
    } catch {
      const message = "duplicate check unavailable";
      logger.warn(`[upload] upload_id=${prepared.row.id}: exact-source duplicate check failed; stopping safely`);
      await markUploadFailed(deps.store, prepared.row.id, { parse_error: message }, now, logger);
      return {
        status: 200,
        body: { results: [{ upload_id: prepared.row.id, file: prepared.row.filename, error: message }] },
      };
    }
  }
  if (duplicate.skip) {
    const updateError = await deps.store.updateUpload(prepared.row.id, {
      status: duplicate.status,
      parsed_rows: duplicate.parsedRows,
      parse_error: duplicate.note,
      parsed_at: now(),
    });
    if (updateError) {
      const message = `duplicate skip update: ${updateError}`;
      logger.error(`[upload] upload_id=${prepared.row.id}: duplicate skip update failed`);
      await markUploadFailed(deps.store, prepared.row.id, { parse_error: message }, now, logger);
      return {
        status: 200,
        body: { results: [{ upload_id: prepared.row.id, file: prepared.row.filename, error: message }] },
      };
    }
    logger.log(`[upload] upload_id=${prepared.row.id}: exact-source duplicate skipped`);
    return {
      status: 200,
      body: {
        results: [{
          upload_id: prepared.row.id,
          file: prepared.row.filename,
          skipped: true,
          skip_reason: duplicate.note,
          status: duplicate.status,
          parsed_rows: duplicate.parsedRows,
          sales_records_written: 0,
          settlement_month: prepared.row.settlement_month,
        }],
      },
    };
  }

  const lookups = await loadPreparedUploadLookups(deps.store, deps.buildLookupMaps);
  if ("error" in lookups) {
    const message = "lookup data unavailable";
    logger.warn(`[upload] upload_id=${prepared.row.id}: lookup loading failed; stopping safely`);
    await markUploadFailed(deps.store, prepared.row.id, { parse_error: message }, now, logger);
    return {
      status: 200,
      body: { results: [{ upload_id: prepared.row.id, file: prepared.row.filename, error: message }] },
    };
  }

  let parsed: ParsedFile;
  try {
    parsed = await deps.parseFile({
      filename: prepared.row.filename,
      buffer: prepared.buffer,
      folderName: input.folderHint,
    });
  } catch (error) {
    const message = `parse failed: ${(error as Error).message || "parse failed"}`;
    await markUploadFailed(deps.store, prepared.row.id, { parse_error: message }, now, logger);
    return {
      status: 200,
      body: { results: [{ upload_id: prepared.row.id, file: prepared.row.filename, error: message }] },
    };
  }

  const result = await processParsedUpload({
    store: deps.store,
    uploadId: prepared.row.id,
    filename: prepared.row.filename,
    parsed,
    activeMonth: prepared.row.settlement_month,
    fallbackMonth: null,
    lookups: lookups.value,
    toSalesRecords: deps.toSalesRecords,
    exactSourceGateApplied,
    now,
    logger,
  });
  return { status: 200, body: { results: [result] } };
}

export async function processParsedUpload(args: ProcessParsedUploadArgs): Promise<UploadResult> {
  const {
    store,
    uploadId,
    filename,
    parsed,
    activeMonth,
    fallbackMonth,
    lookups,
    toSalesRecords,
    exactSourceGateApplied,
  } = args;
  const runLabel = args.runLabel ?? "";
  const now = args.now ?? defaultNow;
  const logger = args.logger ?? console;

  const resolution = resolveSettlementMonth({
    activeMonth,
    parsedSettlementMonth: parsed.settlement_month,
    hasRecords: parsed.records.length > 0,
    fallbackMonth,
  });
  if (!resolution.ok) {
    logger.warn(`[upload]${runLabel} upload_id=${uploadId}: settlement month resolution failed`);
    await markUploadFailed(store, uploadId, {
      platform_code: parsed.platform_code,
      sales_month: parsed.sales_month || null,
      detection_confidence: parsed.detection_confidence,
      parsed_rows: parsed.records.length,
      parse_error: resolution.error,
    }, now, logger);
    return {
      file: filename,
      platform: parsed.platform_code,
      parsed_rows: parsed.records.length,
      sales_month: parsed.sales_month || null,
      error: resolution.error,
    };
  }

  const effectiveSettlement = resolution.month;
  if (resolution.note) parsed.errors.push(resolution.note);
  const zeroRowFailure = isZeroRowParseFailure(parsed.platform_code, parsed.records.length, parsed.errors);
  const parsedStatus = statusAfterParseMetadata(parsed.records.length, zeroRowFailure);
  const updateError = await store.updateUpload(uploadId, {
    platform_code: parsed.platform_code,
    settlement_month: effectiveSettlement,
    sales_month: parsed.sales_month || null,
    status: parsedStatus,
    detection_confidence: parsed.detection_confidence,
    parse_error: parsed.errors.filter(Boolean).join("; ") || null,
    parsed_rows: parsed.records.length,
    parsed_at: now(),
  });
  if (updateError) {
    logger.error(`[upload]${runLabel} upload_id=${uploadId}: raw_uploads update failed`);
    return { file: filename, error: updateError };
  }

  let rawRecordIds: Map<number, string> | undefined;
  if (parsed.records.length > 0) {
    try {
      const inserted = await store.insertRawRecords(parsed.records.map((record) => ({
        upload_id: uploadId,
        row_index: record.row_index,
        data: record.data as unknown as Json,
      })));
      rawRecordIds = new Map(inserted.map((row) => [row.row_index, row.id]));
    } catch (error) {
      const message = `raw_records insert: ${(error as Error).message}`;
      await markUploadFailed(store, uploadId, {
        platform_code: parsed.platform_code,
        settlement_month: effectiveSettlement,
        sales_month: parsed.sales_month || null,
        detection_confidence: parsed.detection_confidence,
        parsed_rows: parsed.records.length,
        parse_error: message,
      }, now, logger);
      return { file: filename, error: message };
    }
  }

  if (parsed.records.length === 0) {
    if (zeroRowFailure) {
      return {
        file: filename,
        platform: parsed.platform_code,
        parsed_rows: 0,
        sales_records_written: 0,
        error: parsed.errors.join("; ") || "정산행 0건: 파일 형식 분석 실패/파서 미지원입니다.",
        settlement_month: effectiveSettlement,
        sales_month: parsed.sales_month || null,
      };
    }
    return {
      file: filename,
      platform: parsed.platform_code,
      parsed_rows: 0,
      sales_records_written: 0,
      skipped: true,
      skip_reason: "정산행 없음: 보조자료/비정산 파일로 보고 건너뛰었습니다.",
      settlement_month: effectiveSettlement,
      sales_month: parsed.sales_month || null,
    };
  }

  if (!effectiveSettlement) {
    return { file: filename, error: "internal: settlement month missing for records" };
  }

  const context: TransformContext = {
    settlement_month: effectiveSettlement,
    forceSettlementMonth: true,
    sales_month: parsed.sales_month || null,
    platform_code: parsed.platform_code,
    upload_id: uploadId,
    raw_record_id_by_index: rawRecordIds,
    lookups,
  };
  const transformed = toSalesRecords(parsed.records, context);
  const transformWarnings = transformed.errors.length > 0 ? transformed.errors : undefined;
  let inserts = transformed.inserts;
  let skippedDuplicates = 0;

  if (inserts.length > 0) {
    try {
      const existing = await store.listExistingSalesRecords(effectiveSettlement);
      if (existing.length > 0) {
        const suppressed = suppressDuplicatesAtInsert(parsed.platform_code, inserts, existing, {
          exactSourceGateApplied,
        });
        inserts = suppressed.kept;
        skippedDuplicates = suppressed.skipped;
      }
    } catch {
      const message = "duplicate check unavailable";
      logger.warn(`[upload]${runLabel} upload_id=${uploadId}: sales duplicate check failed; stopping safely`);
      await markUploadFailed(store, uploadId, {
        platform_code: parsed.platform_code,
        settlement_month: effectiveSettlement,
        sales_month: parsed.sales_month || null,
        detection_confidence: parsed.detection_confidence,
        parsed_rows: parsed.records.length,
        parse_error: message,
      }, now, logger);
      return {
        file: filename,
        platform: parsed.platform_code,
        parsed_rows: parsed.records.length,
        sales_records_written: 0,
        settlement_month: effectiveSettlement,
        sales_month: parsed.sales_month || null,
        error: message,
      };
    }
  }

  if (inserts.length === 0 && skippedDuplicates === 0) {
    const message = transformed.errors.length > 0
      ? `정산 행으로 변환하지 못했습니다: ${transformed.errors.slice(0, 3).map((error) => `${error.field} ${error.message}`).join("; ")}`
      : "정산 행으로 변환할 수 있는 데이터가 없습니다.";
    await markUploadFailed(store, uploadId, {
      platform_code: parsed.platform_code,
      settlement_month: effectiveSettlement,
      sales_month: parsed.sales_month || null,
      detection_confidence: parsed.detection_confidence,
      parsed_rows: parsed.records.length,
      parse_error: message,
    }, now, logger);
    return {
      file: filename,
      platform: parsed.platform_code,
      parsed_rows: parsed.records.length,
      sales_records_written: 0,
      settlement_month: effectiveSettlement,
      sales_month: parsed.sales_month || null,
      error: message,
    };
  }

  let salesWritten = 0;
  if (inserts.length > 0) {
    try {
      salesWritten = await store.insertSalesRecords(inserts);
    } catch (error) {
      const message = `sales_records insert: ${(error as Error).message}`;
      await markUploadFailed(store, uploadId, {
        platform_code: parsed.platform_code,
        settlement_month: effectiveSettlement,
        sales_month: parsed.sales_month || null,
        detection_confidence: parsed.detection_confidence,
        parsed_rows: parsed.records.length,
        parse_error: message,
      }, now, logger);
      return { file: filename, platform: parsed.platform_code, error: message };
    }
  }

  if (salesWritten > 0 || skippedDuplicates > 0) {
    await store.updateUpload(uploadId, { status: "aggregated" });
  }

  return {
    file: filename,
    platform: parsed.platform_code,
    confidence: parsed.detection_confidence,
    parsed_rows: parsed.records.length,
    sales_records_written: salesWritten,
    sales_records_skipped_duplicates: skippedDuplicates,
    skipped_duplicates: skippedDuplicates,
    settlement_month: effectiveSettlement,
    sales_month: parsed.sales_month || null,
    warnings: transformWarnings,
    errors: parsed.errors,
  };
}

async function markUploadFailed(
  store: PreparedUploadStore,
  uploadId: string,
  fields: UploadPatch,
  now: () => string,
  logger: Pick<Console, "error">,
): Promise<void> {
  const error = await store.updateUpload(uploadId, { ...fields, status: "failed", parsed_at: now() });
  if (error) logger.error(`[upload] upload_id=${uploadId}: failed-status update error`);
}
