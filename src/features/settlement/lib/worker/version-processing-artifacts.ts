import type postgres from "postgres";

import type { LookupMaps, TransformContext, TransformResult } from "../aggregation/to-sales-records";
import type { InputV2FillResult } from "../export/input-v2-filler";
import type { ParseResult } from "../schema/sales";
import type { LocalWorkbookArtifactResult, WorkbookShape } from "./local-workbook-artifact";
import type { LocalParseStageResult } from "./local-parse-stage";
import type { LocalStagePersistenceResult } from "./local-stage-store";
import type { SnapshotReadyResult, VersionClaimIdentity } from "./version-source-adapter";

export type ProcessingArtifactOutcome =
  | { outcome: "workbook_ready"; stage: LocalStagePersistenceResult; workbook: LocalWorkbookArtifactResult }
  | { outcome: "lease_lost" };

export type StageEvidence = {
  stageSha256: string;
  stageSizeBytes: number;
  fileCount: number;
  rawRowCount: number;
  salesRowCount: number;
};

export type WorkbookEvidence = {
  workbookSha256: string;
  archiveSha256: string;
  sizeBytes: number;
  sheetCount: number;
  rowCount: number;
  officeVerifier: "libreoffice";
  officeVersion: string;
  officeArchiveSha256: string;
  officeSheetCount: number;
  officeRowCount: number;
  baselineMonth: string;
  baselinePublicationId: string | null;
  baselineSha256: string;
};

export type PreparedLedgerRecords = {
  records: Record<string, unknown>[];
  baselineMonth: string;
  baselinePublicationId: string | null;
  baselineSha256: string;
};

export interface ProcessingArtifactFence {
  heartbeat(input: VersionClaimIdentity & { leaseSeconds: number }): Promise<boolean>;
  markStageReady(input: VersionClaimIdentity & StageEvidence): Promise<boolean>;
  markWorkbookReady(input: VersionClaimIdentity & WorkbookEvidence): Promise<boolean>;
}

type ParseFile = (input: { filename: string; buffer: Buffer; folderName?: string }) =>
  Promise<ParseResult & { detection_confidence: number }>;
type ToSalesRecords = (rows: ParseResult["records"], context: TransformContext) => TransformResult;

export interface ProcessingArtifactDependencies {
  fence: ProcessingArtifactFence;
  loadLookups(): Promise<LookupMaps>;
  parseFile: ParseFile;
  toSalesRecords: ToSalesRecords;
  buildStage(input: {
    snapshotDir: string;
    entries: SnapshotReadyResult["entries"];
    settlementMonth: string;
    lookups: LookupMaps;
    parseFile: ParseFile;
    toSalesRecords: ToSalesRecords;
  }): Promise<LocalParseStageResult>;
  persistStage(input: { workRoot: string; runId: string; stage: LocalParseStageResult }): Promise<LocalStagePersistenceResult>;
  prepareRecords(input: {
    identity: VersionClaimIdentity;
    stage: LocalParseStageResult;
  }): Promise<PreparedLedgerRecords>;
  validatePreparedWorkbook(input: {
    identity: VersionClaimIdentity;
    stage: LocalParseStageResult;
    prepared: PreparedLedgerRecords;
    workbook: LocalWorkbookArtifactResult;
  }): Promise<void>;
  generateWorkbook(input: {
    stage: LocalParseStageResult;
    workRoot: string;
    runId: string;
    fillWorkbook: (input: { month: string; records: Record<string, unknown>[] }) => Promise<InputV2FillResult>;
    validateWorkbook: (buffer: Buffer) => Promise<WorkbookShape>;
    archiveDigest: (buffer: Buffer) => Promise<string>;
    preparedRecords?: Record<string, unknown>[];
    baselineEvidence?: { month: string; publicationId: string | null; sha256: string };
  }): Promise<LocalWorkbookArtifactResult>;
  fillWorkbook(input: { month: string; records: Record<string, unknown>[] }): Promise<InputV2FillResult>;
  validateWorkbook(buffer: Buffer): Promise<WorkbookShape>;
  archiveDigest(buffer: Buffer): Promise<string>;
}

export async function processSnapshotArtifacts(input: {
  identity: VersionClaimIdentity;
  snapshot: SnapshotReadyResult;
  workRoot: string;
  leaseSeconds: number;
}, deps: ProcessingArtifactDependencies): Promise<ProcessingArtifactOutcome> {
  const identity = { ...input.identity };
  if (!(await deps.fence.heartbeat({ ...identity, leaseSeconds: input.leaseSeconds }))) {
    return { outcome: "lease_lost" };
  }
  const lookups = await deps.loadLookups();
  const stage = await deps.buildStage({
    snapshotDir: input.snapshot.snapshotDir,
    entries: input.snapshot.entries.map((entry) => ({ ...entry })),
    settlementMonth: input.snapshot.settlementMonth,
    lookups,
    parseFile: deps.parseFile,
    toSalesRecords: deps.toSalesRecords,
  });
  const persisted = await deps.persistStage({ workRoot: input.workRoot, runId: identity.runId, stage });
  if (!(await deps.fence.markStageReady({
    ...identity,
    stageSha256: persisted.sha256,
    stageSizeBytes: persisted.sizeBytes,
    fileCount: stage.counts.files,
    rawRowCount: stage.counts.rawRows,
    salesRowCount: stage.counts.salesRows,
  }))) return { outcome: "lease_lost" };

  if (!(await deps.fence.heartbeat({ ...identity, leaseSeconds: input.leaseSeconds }))) {
    return { outcome: "lease_lost" };
  }
  const prepared = await deps.prepareRecords({ identity, stage });
  if (!prepared || !Array.isArray(prepared.records) || prepared.records.length < 1
      || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(prepared.baselineMonth)
      || !/^[0-9a-f]{64}$/.test(prepared.baselineSha256)) {
    throw new Error("historical ledger preparation invalid");
  }
  const workbook = await deps.generateWorkbook({
    stage,
    workRoot: input.workRoot,
    runId: identity.runId,
    fillWorkbook: deps.fillWorkbook,
    validateWorkbook: deps.validateWorkbook,
    archiveDigest: deps.archiveDigest,
    preparedRecords: prepared.records,
    baselineEvidence: {
      month: prepared.baselineMonth,
      publicationId: prepared.baselinePublicationId,
      sha256: prepared.baselineSha256,
    },
  });
  await deps.validatePreparedWorkbook({ identity, stage, prepared, workbook });
  const evidence = workbook.evidence;
  if (evidence.baselineMonth !== prepared.baselineMonth
      || evidence.baselinePublicationId !== prepared.baselinePublicationId
      || evidence.baselineSha256 !== prepared.baselineSha256) {
    throw new Error("historical ledger evidence mismatch");
  }
  if (evidence.office.verifier !== "libreoffice") return { outcome: "lease_lost" };
  if (!(await deps.fence.markWorkbookReady({
    ...identity,
    workbookSha256: evidence.officeWorkbookSha256,
    archiveSha256: evidence.office.archiveDigest,
    sizeBytes: evidence.officeWorkbookSizeBytes,
    sheetCount: evidence.office.reopened.sheetCount,
    rowCount: evidence.office.reopened.rowCount,
    officeVerifier: "libreoffice",
    officeVersion: evidence.office.version,
    officeArchiveSha256: evidence.office.archiveDigest,
    officeSheetCount: evidence.office.reopened.sheetCount,
    officeRowCount: evidence.office.reopened.rowCount,
    baselineMonth: prepared.baselineMonth,
    baselinePublicationId: prepared.baselinePublicationId,
    baselineSha256: prepared.baselineSha256,
  }))) return { outcome: "lease_lost" };
  return { outcome: "workbook_ready", stage: persisted, workbook };
}

export function createPostgresProcessingArtifactFence(sql: postgres.Sql): ProcessingArtifactFence {
  return {
    async heartbeat(input) {
      const rows = await sql<Array<{ ok: boolean }>>`
        select public.heartbeat_settlement_processing_run(
          ${input.jobId}::uuid, ${input.runId}::uuid, ${input.workerId}::text,
          ${input.claimToken}::uuid, ${input.leaseSeconds}::integer
        ) as ok`;
      return rows[0]?.ok === true;
    },
    async markStageReady(input) {
      const rows = await sql<Array<{ ok: boolean }>>`
        select public.mark_settlement_processing_run_stage_ready(
          ${input.jobId}::uuid, ${input.runId}::uuid, ${input.workerId}::text,
          ${input.claimToken}::uuid, ${input.stageSha256}::text,
          ${input.stageSizeBytes}::bigint, ${input.fileCount}::integer,
          ${input.rawRowCount}::integer, ${input.salesRowCount}::integer
        ) as ok`;
      return rows[0]?.ok === true;
    },
    async markWorkbookReady(input) {
      const rows = await sql<Array<{ ok: boolean }>>`
        select public.mark_settlement_processing_run_workbook_ready(
          ${input.jobId}::uuid, ${input.runId}::uuid, ${input.workerId}::text,
          ${input.claimToken}::uuid, ${input.workbookSha256}::text,
          ${input.archiveSha256}::text, ${input.sizeBytes}::bigint,
          ${input.sheetCount}::integer, ${input.rowCount}::integer,
          ${input.officeVerifier}::text, ${input.officeVersion}::text,
          ${input.officeArchiveSha256}::text, ${input.officeSheetCount}::integer,
          ${input.officeRowCount}::integer, ${input.baselineMonth}::date,
          ${input.baselinePublicationId}::uuid, ${input.baselineSha256}::text
        ) as ok`;
      return rows[0]?.ok === true;
    },
  };
}
