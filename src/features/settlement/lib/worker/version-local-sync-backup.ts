import type postgres from "postgres";

import { archiveVersionToLocalSync, LocalSyncArchiveError } from "./local-sync-archive";
import type { ProcessingArtifactOutcome } from "./version-processing-artifacts";
import type { SnapshotReadyResult, VersionClaimIdentity } from "./version-source-adapter";
import type { VersionDriveBackupOutcome } from "./version-drive-backup";

export interface LocalSyncBackupStore {
  verifyArchive(input: VersionClaimIdentity & {
    relativeArchivePath: string;
    evidenceSha256: string;
    files: Array<{ relativePath: string; sizeBytes: number; sha256: string }>;
  }): Promise<boolean>;
}

export async function backupClaimedVersionToLocalSync(input: {
  identity: VersionClaimIdentity;
  snapshot: SnapshotReadyResult;
  workbook: Extract<ProcessingArtifactOutcome, { outcome: "workbook_ready" }>;
  root: string;
  allowedBaseRoot: string;
  leaseSeconds: number;
}, deps: {
  store: LocalSyncBackupStore;
  heartbeat(input: VersionClaimIdentity & { leaseSeconds: number }): Promise<boolean>;
  shouldStop?: () => boolean;
}): Promise<VersionDriveBackupOutcome> {
  const monthKey = input.snapshot.settlementMonth.slice(0, 7).replace("-", "");
  const canContinue = async () => !deps.shouldStop?.()
    && deps.heartbeat({ ...input.identity, leaseSeconds: input.leaseSeconds });
  if (!(await canContinue())) return deps.shouldStop?.() ? { outcome: "interrupted" } : { outcome: "lease_lost" };
  try {
    const archive = await archiveVersionToLocalSync({
      root: input.root,
      allowedBaseRoot: input.allowedBaseRoot,
      monthKey,
      versionNo: input.snapshot.versionNo,
      sourceVersionId: input.identity.sourceVersionId,
      runId: input.identity.runId,
      snapshotDir: input.snapshot.snapshotDir,
      entries: input.snapshot.entries,
      officeVerifiedPath: input.workbook.workbook.officePath,
      evidencePath: input.workbook.workbook.evidencePath,
      canContinue,
    });
    if (!(await deps.store.verifyArchive({
      ...input.identity,
      relativeArchivePath: archive.relativeArchivePath,
      evidenceSha256: archive.evidenceSha256,
      files: archive.files.map((file) => ({ ...file })),
    }))) return { outcome: "lease_lost" };
    return {
      outcome: "backup_ready",
      backups: [{ transport: "local_sync", relativeArchivePath: archive.relativeArchivePath, evidenceSha256: archive.evidenceSha256, reused: archive.reused }],
    };
  } catch (error) {
    if (error instanceof LocalSyncArchiveError && error.code === "INTERRUPTED") {
      return deps.shouldStop?.() ? { outcome: "interrupted" } : { outcome: "lease_lost" };
    }
    return error instanceof LocalSyncArchiveError ? { outcome: "failed" } : { outcome: "retry" };
  }
}

export function createPostgresLocalSyncBackupStore(sql: postgres.Sql): LocalSyncBackupStore {
  return {
    async verifyArchive(input) {
      const rows = await sql<Array<{ ok: boolean }>>`
        select public.verify_settlement_local_sync_archive(
          ${input.jobId}::uuid,
          ${input.runId}::uuid,
          ${input.workerId}::text,
          ${input.claimToken}::uuid,
          ${input.relativeArchivePath}::text,
          ${input.evidenceSha256}::text,
          ${sql.json(input.files)}::jsonb
        ) as ok
      `;
      return rows[0]?.ok === true;
    },
  };
}
