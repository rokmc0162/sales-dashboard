import type postgres from "postgres";

import type { SettlementProcessingRunRow } from "@/features/settlement/lib/supabase/types";
import {
  VersionSourceSnapshotError,
  type VersionSourceSnapshotResult,
} from "./version-source-snapshot";
import type {
  MaterializeClaimedVersionInput,
  SnapshotReadyResult,
} from "./version-source-adapter";
import type {
  ProcessingArtifactOutcome,
} from "./version-processing-artifacts";
import type {
  VersionDriveBackupEvidence,
  VersionDriveBackupOutcome,
} from "./version-drive-backup";
import type { VersionPublicationOutcome } from "./version-publication";

type Sql = postgres.Sql;

export type VersionSnapshotRunOutcome =
  | { outcome: "snapshot_ready"; result: SnapshotReadyResult }
  | { outcome: "failed" | "lease_lost" | "interrupted"; result?: never };

export type VersionProcessingRunOutcome =
  | {
      outcome: "published";
      result: Extract<ProcessingArtifactOutcome, { outcome: "workbook_ready" }> & {
        backups: VersionDriveBackupEvidence[];
      };
    }
  | { outcome: "failed" | "lease_lost" | "interrupted" | "retry"; result?: never };

export interface VersionSnapshotRunDependencies {
  materialize(input: MaterializeClaimedVersionInput): Promise<SnapshotReadyResult>;
  fail(input: {
    jobId: string;
    runId: string;
    workerId: string;
    claimToken: string;
    errorSummary: string;
  }): Promise<boolean>;
  release(input: {
    jobId: string;
    runId: string;
    workerId: string;
    claimToken: string;
  }): Promise<boolean>;
  shouldStop?: () => boolean;
}

export interface VersionProcessingRunDependencies extends VersionSnapshotRunDependencies {
  processArtifacts(input: {
    identity: {
      jobId: string; runId: string; sourceVersionId: string; workerId: string; claimToken: string;
    };
    snapshot: SnapshotReadyResult;
    workRoot: string;
    leaseSeconds: number;
  }): Promise<ProcessingArtifactOutcome>;
  // Required so processing cannot succeed without a Drive backup: a claimed
  // run only reaches backup_ready once every artifact is verified in Drive.
  backupArtifacts(input: {
    identity: {
      jobId: string; runId: string; sourceVersionId: string; workerId: string; claimToken: string;
    };
    snapshot: SnapshotReadyResult;
    workbook: Extract<ProcessingArtifactOutcome, { outcome: "workbook_ready" }>;
    leaseSeconds: number;
  }): Promise<VersionDriveBackupOutcome>;
  publishWorkbook(input: {
    identity: {
      jobId: string; runId: string; sourceVersionId: string; workerId: string; claimToken: string;
    };
    workbook: Extract<ProcessingArtifactOutcome, { outcome: "workbook_ready" }>;
  }): Promise<VersionPublicationOutcome>;
}

export async function claimSettlementVersionRun(
  sql: Sql,
  workerId: string,
  leaseSeconds: number,
): Promise<SettlementProcessingRunRow | null> {
  const rows = await sql<SettlementProcessingRunRow[]>`
    select *
    from public.claim_settlement_version_job(${workerId}::text, ${leaseSeconds}::integer)
    limit 1
  `;
  return rows[0] ?? null;
}

export async function runClaimedVersionSnapshot(
  run: SettlementProcessingRunRow,
  input: Pick<MaterializeClaimedVersionInput,
    "workRoot" | "leaseSeconds" | "supabaseUrl" | "serviceRoleKey" | "storageTimeoutMs"
  >,
  deps: VersionSnapshotRunDependencies,
): Promise<VersionSnapshotRunOutcome> {
  const identity = {
    jobId: run.job_id,
    runId: run.id,
    sourceVersionId: run.source_version_id,
    workerId: run.worker_id,
    claimToken: run.claim_token,
  };
  if (run.status !== "claimed" || run.lease_expires_at === null) {
    return { outcome: "lease_lost" };
  }
  if (deps.shouldStop?.()) {
    try {
      return await deps.release(identity)
        ? { outcome: "interrupted" }
        : { outcome: "lease_lost" };
    } catch {
      return { outcome: "lease_lost" };
    }
  }

  try {
    const result = await deps.materialize({ ...identity, ...input });
    return { outcome: "snapshot_ready", result };
  } catch (error) {
    if (error instanceof VersionSourceSnapshotError && error.code === "STALE_RUN") {
      return { outcome: "lease_lost" };
    }
    let failed = false;
    try {
      failed = await deps.fail({
        jobId: identity.jobId,
        runId: identity.runId,
        workerId: identity.workerId,
        claimToken: identity.claimToken,
        errorSummary: error instanceof VersionSourceSnapshotError
          ? `source snapshot ${error.code.toLowerCase()}`
          : "source snapshot failed",
      });
    } catch {
      failed = false;
    }
    return { outcome: failed ? "failed" : "lease_lost" };
  }
}

export async function runClaimedVersionProcessing(
  run: SettlementProcessingRunRow,
  input: Pick<MaterializeClaimedVersionInput,
    "workRoot" | "leaseSeconds" | "supabaseUrl" | "serviceRoleKey" | "storageTimeoutMs"
  >,
  deps: VersionProcessingRunDependencies,
): Promise<VersionProcessingRunOutcome> {
  const snapshot = await runClaimedVersionSnapshot(run, input, deps);
  if (snapshot.outcome !== "snapshot_ready") return snapshot;
  const identity = {
    jobId: run.job_id,
    runId: run.id,
    sourceVersionId: run.source_version_id,
    workerId: run.worker_id,
    claimToken: run.claim_token,
  };
  if (deps.shouldStop?.()) {
    try {
      return await deps.release(identity) ? { outcome: "interrupted" } : { outcome: "lease_lost" };
    } catch { return { outcome: "lease_lost" }; }
  }
  const failRun = async (errorSummary: string): Promise<VersionProcessingRunOutcome> => {
    try {
      const failed = await deps.fail({ ...identity, errorSummary });
      return { outcome: failed ? "failed" : "lease_lost" };
    } catch { return { outcome: "lease_lost" }; }
  };
  let artifacts: ProcessingArtifactOutcome;
  try {
    artifacts = await deps.processArtifacts({
      identity,
      snapshot: snapshot.result,
      workRoot: input.workRoot,
      leaseSeconds: input.leaseSeconds,
    });
  } catch {
    return failRun("local artifact failed");
  }
  if (artifacts.outcome === "lease_lost") return { outcome: "lease_lost" };
  if (deps.shouldStop?.()) {
    try {
      return await deps.release(identity) ? { outcome: "interrupted" } : { outcome: "lease_lost" };
    } catch { return { outcome: "lease_lost" }; }
  }
  let backup: VersionDriveBackupOutcome;
  try {
    backup = await deps.backupArtifacts({
      identity,
      snapshot: snapshot.result,
      workbook: artifacts,
      leaseSeconds: input.leaseSeconds,
    });
  } catch {
    backup = { outcome: "failed" };
  }
  if (backup.outcome === "backup_ready") {
    let publication: VersionPublicationOutcome;
    try {
      publication = await deps.publishWorkbook({ identity, workbook: artifacts });
    } catch {
      publication = { outcome: "retry" };
    }
    if (publication.outcome === "published") {
      return { outcome: "published", result: { ...artifacts, backups: backup.backups } };
    }
    if (publication.outcome === "lease_lost") return { outcome: "lease_lost" };
    if (publication.outcome === "retry") {
      try {
        return await deps.release(identity) ? { outcome: "retry" } : { outcome: "lease_lost" };
      } catch { return { outcome: "lease_lost" }; }
    }
    return failRun("publication failed");
  }
  if (backup.outcome === "lease_lost") return { outcome: "lease_lost" };
  if (backup.outcome === "retry") {
    try {
      return await deps.release(identity) ? { outcome: "retry" } : { outcome: "lease_lost" };
    } catch { return { outcome: "lease_lost" }; }
  }
  if (backup.outcome === "interrupted") {
    try {
      return await deps.release(identity) ? { outcome: "interrupted" } : { outcome: "lease_lost" };
    } catch { return { outcome: "lease_lost" }; }
  }
  return failRun("drive backup failed");
}

export function createPostgresVersionRunLifecycle(sql: Sql): Pick<VersionSnapshotRunDependencies, "fail" | "release"> {
  return {
    async fail(input) {
      const rows = await sql<Array<{ ok: boolean }>>`
        select public.fail_settlement_processing_run(
          ${input.jobId}::uuid,
          ${input.runId}::uuid,
          ${input.workerId}::text,
          ${input.claimToken}::uuid,
          ${input.errorSummary}::text
        ) as ok
      `;
      return rows[0]?.ok === true;
    },
    async release(input) {
      const rows = await sql<Array<{ ok: boolean }>>`
        select public.release_settlement_processing_run(
          ${input.jobId}::uuid,
          ${input.runId}::uuid,
          ${input.workerId}::text,
          ${input.claimToken}::uuid
        ) as ok
      `;
      return rows[0]?.ok === true;
    },
  };
}

export type { VersionSourceSnapshotResult };
