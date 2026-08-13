// Deterministic Drive backup orchestration for one claimed version run.
//
// After workbook_ready, exactly three artifact sources exist and nothing else
// is ever read: <snapshotDir>/manifest.json, <snapshotDir>/files/<displayPath>
// for every frozen manifest entry, and the verified workbook candidatePath.
// Artifacts are processed strictly sequentially (manifest, source files in
// frozen position order, workbook) with a fenced heartbeat and a stop check
// between artifacts. Drive names are derived only from row identities so no
// operator-visible path or title ever reaches Drive metadata.

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { SettlementDriveError, type SettlementDriveClient } from "../google-drive/client";
import { canonicalizeIntakePath, MAX_INTAKE_FILES } from "../intake/contract";
import {
  backupDriveArtifact,
  type DriveBackupArtifact,
  type DriveBackupKind,
  type DriveBackupStore,
} from "./drive-backup-runner";
import type { VersionClaimIdentity } from "./version-source-adapter";
import {
  SNAPSHOT_FILES_DIR,
  SNAPSHOT_MANIFEST_NAME,
  type VersionSourceManifestEntry,
} from "./version-source-snapshot";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{1,256}$/;
const SAFE_REASON_RE = /^[\x20-\x7E]{1,300}$/;
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DEFAULT_RETRY_AFTER_SECONDS = 300;

export type VersionBackupEvidence =
  | { transport: "google_drive_api"; kind: DriveBackupKind; backupId: string; driveFileId: string; reused: boolean }
  | { transport: "local_sync"; relativeArchivePath: string; evidenceSha256: string; reused: boolean };

export type VersionDriveBackupOutcome =
  | { outcome: "backup_ready"; backups: VersionBackupEvidence[] }
  | { outcome: "lease_lost" | "interrupted" | "retry" | "failed"; backups?: never };

export interface VersionDriveBackupDependencies {
  store: DriveBackupStore;
  drive: SettlementDriveClient;
  heartbeat(input: VersionClaimIdentity & { leaseSeconds: number }): Promise<boolean>;
  shouldStop?: () => boolean;
  newAttemptToken?: () => string;
  retryAfterSeconds?: number;
}

function fail(message: string): never {
  throw new Error(`drive backup plan invalid: ${message}`);
}

// Builds the exact, ordered artifact list for one run. Every localPath is
// contained in its root by construction and re-checked after resolution;
// display paths are validated with the same canonicalization the frozen
// manifest was written under and are never trusted as raw path input.
export function planVersionDriveBackupArtifacts(input: {
  identity: Pick<VersionClaimIdentity, "runId" | "sourceVersionId">;
  snapshotDir: string;
  entries: VersionSourceManifestEntry[];
  candidatePath: string;
}): DriveBackupArtifact[] {
  if (!UUID_RE.test(input.identity.runId)) fail("run id");
  if (!UUID_RE.test(input.identity.sourceVersionId)) fail("source version id");
  if (typeof input.snapshotDir !== "string" || !path.isAbsolute(input.snapshotDir)) {
    fail("snapshot directory");
  }
  if (
    typeof input.candidatePath !== "string"
    || !path.isAbsolute(input.candidatePath)
    || path.basename(input.candidatePath) !== "office-verified.xlsx"
  ) {
    fail("workbook candidate path");
  }
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > MAX_INTAKE_FILES) {
    fail("entry count");
  }
  const snapshotDir = path.resolve(input.snapshotDir);
  const filesRoot = path.join(snapshotDir, SNAPSHOT_FILES_DIR);
  const artifacts: DriveBackupArtifact[] = [{
    kind: "source_manifest",
    sourceVersionFileId: null,
    localPath: path.join(snapshotDir, SNAPSHOT_MANIFEST_NAME),
    name: `source-manifest-${input.identity.sourceVersionId}.json`,
    mimeType: "application/json",
  }];
  let previousPosition = -1;
  const seenObjectIds = new Set<string>();
  const seenVersionFileIds = new Set<string>();
  for (const entry of input.entries) {
    if (typeof entry.versionFileId !== "string" || !UUID_RE.test(entry.versionFileId)) {
      fail(`version file id at position ${entry.position}`);
    }
    if (seenVersionFileIds.has(entry.versionFileId)) fail(`duplicate version file id ${entry.versionFileId}`);
    seenVersionFileIds.add(entry.versionFileId);
    if (typeof entry.objectId !== "string" || !UUID_RE.test(entry.objectId)) {
      fail(`object id at position ${entry.position}`);
    }
    if (seenObjectIds.has(entry.objectId)) fail(`duplicate object id ${entry.objectId}`);
    seenObjectIds.add(entry.objectId);
    if (!Number.isInteger(entry.position) || entry.position <= previousPosition) {
      fail(`position order at object ${entry.objectId}`);
    }
    previousPosition = entry.position;
    const canonical = canonicalizeIntakePath(entry.displayPath);
    if (!canonical.ok || canonical.displayPath !== entry.displayPath) {
      fail(`display path for object ${entry.objectId}`);
    }
    const localPath = path.resolve(filesRoot, entry.displayPath);
    if (!localPath.startsWith(filesRoot + path.sep)) {
      fail(`display path escape for object ${entry.objectId}`);
    }
    artifacts.push({
      kind: "source_file",
      sourceVersionFileId: entry.versionFileId,
      localPath,
      name: `source-file-${entry.objectId}.bin`,
      mimeType: "application/octet-stream",
    });
  }
  artifacts.push({
    kind: "verified_workbook",
    sourceVersionFileId: null,
    localPath: path.resolve(input.candidatePath),
    name: `verified-workbook-${input.identity.runId}.xlsx`,
    mimeType: XLSX_MIME_TYPE,
  });
  return artifacts;
}

// Rejects symlinked parents (realpath must be the identity) and symlink or
// special-file leaves before any Drive reservation happens. The upload path
// additionally opens with O_NOFOLLOW, so a link swapped in later still fails.
async function assertRegularFileWithoutLinks(localPath: string): Promise<void> {
  const parent = path.dirname(localPath);
  if (await fsp.realpath(parent) !== parent) {
    throw new Error("drive backup artifact parent resolves through a link");
  }
  const stat = await fsp.lstat(localPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("drive backup artifact is not a regular file");
  }
}

// Only fixed-vocabulary messages from this slice's own modules may reach the
// database; anything else (fs errors echo absolute paths) collapses to a
// constant. SettlementDriveError renders as operation + HTTP status only.
function privacySafeSummary(kind: DriveBackupKind, error: unknown): string {
  let reason = "internal error";
  if (error instanceof SettlementDriveError) reason = error.message;
  else if (
    error instanceof Error
    && error.message.startsWith("drive backup ")
    && SAFE_REASON_RE.test(error.message)
  ) {
    reason = error.message;
  }
  return `drive backup ${kind} failed: ${reason}`.slice(0, 500);
}

export async function backupClaimedVersionArtifacts(input: {
  identity: VersionClaimIdentity;
  snapshot: { snapshotDir: string; entries: VersionSourceManifestEntry[] };
  candidatePath: string;
  driveParentId: string;
  leaseSeconds: number;
}, deps: VersionDriveBackupDependencies): Promise<VersionDriveBackupOutcome> {
  if (!DRIVE_ID_RE.test(input.driveParentId)) fail("drive parent id");
  const retryAfterSeconds = deps.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 5 || retryAfterSeconds > 86_400) {
    fail("retry delay");
  }
  const identity: VersionClaimIdentity = { ...input.identity };
  const newAttemptToken = deps.newAttemptToken ?? randomUUID;
  const artifacts = planVersionDriveBackupArtifacts({
    identity,
    snapshotDir: input.snapshot.snapshotDir,
    entries: input.snapshot.entries,
    candidatePath: input.candidatePath,
  });
  const backups: VersionBackupEvidence[] = [];
  for (const artifact of artifacts) {
    if (deps.shouldStop?.()) return { outcome: "interrupted" };
    if (!(await deps.heartbeat({ ...identity, leaseSeconds: input.leaseSeconds }))) {
      return { outcome: "lease_lost" };
    }
    const attemptToken = newAttemptToken();
    let reservedBackupId: string | null = null;
    let reservedStatus: "pending" | "retry" | "verified" | null = null;
    const recordingStore: DriveBackupStore = {
      begin: async (beginInput) => {
        const row = await deps.store.begin(beginInput);
        if (row) {
          reservedBackupId = row.id;
          reservedStatus = row.status;
        }
        return row;
      },
      verify: (verifyInput) => deps.store.verify(verifyInput),
      getVerified: (backupId) => deps.store.getVerified(backupId),
      retry: (retryInput) => deps.store.retry(retryInput),
    };
    try {
      await assertRegularFileWithoutLinks(artifact.localPath);
      const result = await backupDriveArtifact({
        identity,
        artifact,
        driveParentId: input.driveParentId,
        store: recordingStore,
        drive: deps.drive,
        attemptToken,
        canContinue: async () => !deps.shouldStop?.()
          && deps.heartbeat({ ...identity, leaseSeconds: input.leaseSeconds }),
      });
      if (result.outcome === "lease_lost") return { outcome: "lease_lost" };
      backups.push({
        transport: "google_drive_api",
        kind: artifact.kind,
        backupId: result.backupId,
        driveFileId: result.driveFileId,
        reused: result.reused,
      });
    } catch (error) {
      // Local artifacts are deliberately preserved: the retry evidence plus
      // the crash-safe runner resume the exact same bytes on a later attempt.
      if (reservedBackupId && reservedStatus !== "verified") {
        try {
          const recorded = await deps.store.retry({
            ...identity,
            attemptToken,
            backupId: reservedBackupId,
            errorSummary: privacySafeSummary(artifact.kind, error),
            retryAfterSeconds,
          });
          if (!recorded) return { outcome: "lease_lost" };
        } catch {
          return { outcome: "lease_lost" };
        }
      }
      if (error instanceof SettlementDriveError) return { outcome: "retry" };
      return { outcome: "failed" };
    }
  }
  return { outcome: "backup_ready", backups };
}
