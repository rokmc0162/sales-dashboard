import { hostname } from "node:os";

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

import type { Database } from "../src/features/settlement/lib/supabase/types";
import { fillInputV2Template } from "../src/features/settlement/lib/export/input-v2-filler";
import { buildLocalParseStage } from "../src/features/settlement/lib/worker/local-parse-stage";
import { persistLocalParseStage } from "../src/features/settlement/lib/worker/local-stage-store";
import { generateLocalWorkbookArtifact } from "../src/features/settlement/lib/worker/local-workbook-artifact";
import { loadInputV2Records } from "../src/features/settlement/lib/export/load-input-v2-records";
import {
  createSupabasePreparedUploadStore,
  processPreparedUpload,
} from "../src/features/settlement/lib/worker/process-prepared-upload";
import {
  claimSettlementJob,
  createPostgresSettlementWorkerStore,
  runSettlementJob,
  validateSettlementWorkbook,
} from "../src/features/settlement/lib/worker/run-job";
import type { SettlementDriveClient } from "../src/features/settlement/lib/google-drive/client";
import { createSettlementDriveBackupClient } from "../src/features/settlement/lib/worker/drive-backup-client";
import { readSettlementDriveBackupConfig } from "../src/features/settlement/lib/worker/drive-backup-config";
import { createPostgresDriveBackupStore } from "../src/features/settlement/lib/worker/drive-backup-runner";
import { backupClaimedVersionArtifacts } from "../src/features/settlement/lib/worker/version-drive-backup";
import { backupClaimedVersionToLocalSync, createPostgresLocalSyncBackupStore } from "../src/features/settlement/lib/worker/version-local-sync-backup";
import {
  createVersionPublicationStore,
  publishClaimedVersionWorkbook,
} from "../src/features/settlement/lib/worker/version-publication";
import {
  createPostgresVersionSourceFence,
  createPostgresVersionSourceStore,
  materializeClaimedVersionSnapshot,
} from "../src/features/settlement/lib/worker/version-source-adapter";
import {
  claimSettlementVersionRun,
  createPostgresVersionRunLifecycle,
  runClaimedVersionProcessing,
} from "../src/features/settlement/lib/worker/version-source-runner";
import {
  createPostgresProcessingArtifactFence,
  processSnapshotArtifacts,
} from "../src/features/settlement/lib/worker/version-processing-artifacts";
import { runSettlementWorkerCycle } from "../src/features/settlement/lib/worker/worker-cycle";
import { requireWorkerEnvironment } from "../src/features/settlement/lib/worker/worker-env";

const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 60_000;
const MIN_LEASE_SECONDS = 30;
const MAX_LEASE_SECONDS = 14_400;
const DEFAULT_LEASE_SECONDS = 7_200;

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function workerId(): string {
  const configured = process.env.SETTLEMENT_WORKER_ID?.trim();
  const value = configured || `${hostname()}-${process.pid}`;
  // eslint-disable-next-line no-control-regex
  if (value.length < 1 || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("SETTLEMENT_WORKER_ID must be 1 to 128 printable characters");
  }
  return value;
}

async function main() {
  const env = requireWorkerEnvironment();
  const once = process.argv.slice(2).includes("--once");
  const unsupported = process.argv.slice(2).filter((arg) => arg !== "--once");
  if (unsupported.length > 0) throw new Error("Only --once is supported");

  const pollMs = integerEnv("SETTLEMENT_WORKER_POLL_MS", 5_000, MIN_POLL_MS, MAX_POLL_MS);
  const leaseSeconds = integerEnv(
    "SETTLEMENT_WORKER_LEASE_SECONDS",
    DEFAULT_LEASE_SECONDS,
    MIN_LEASE_SECONDS,
    MAX_LEASE_SECONDS,
  );
  const id = workerId();
  const sql = postgres(env.databaseUrl, {
    max: 1,
    prepare: false,
    ssl: "require",
  });

  let stopping = false;
  let wakePoll: (() => void) | null = null;
  const requestStop = () => {
    stopping = true;
    wakePoll?.();
  };
  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);

  try {
    const supabase = createClient<Database>(env.supabaseUrl, env.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const workerStore = createPostgresSettlementWorkerStore(sql, supabase);
    const preparedStore = createSupabasePreparedUploadStore(supabase);
    let legacyRunner: ((job: Awaited<ReturnType<typeof claimSettlementJob>> & object) => ReturnType<typeof runSettlementJob>) | null = null;
    const runLegacy = async (job: NonNullable<Awaited<ReturnType<typeof claimSettlementJob>>>) => {
      if (!legacyRunner) {
        const [{ parseFile }, { toSalesRecords, buildLookupMaps }] = await Promise.all([
          import("../src/features/settlement/lib/parsers/index"),
          import("../src/features/settlement/lib/aggregation/to-sales-records"),
        ]);
        legacyRunner = (claimedJob) => runSettlementJob(claimedJob, id, leaseSeconds, {
          store: workerStore,
          shouldStop: () => stopping,
          processUpload: (input) => processPreparedUpload(input, {
            store: preparedStore,
            parseFile,
            toSalesRecords,
            buildLookupMaps,
          }),
          loadRecords: (month) => loadInputV2Records(month, {
            supabase,
            allowIncompleteSources: true,
          }),
          fillWorkbook: fillInputV2Template,
          validateWorkbook: validateSettlementWorkbook,
        });
      }
      return legacyRunner(job);
    };
    const versionStore = createPostgresVersionSourceStore(sql);
    const versionFence = createPostgresVersionSourceFence(sql);
    const versionLifecycle = createPostgresVersionRunLifecycle(sql);
    const artifactFence = createPostgresProcessingArtifactFence(sql);
    const driveBackupConfig = env.backupTransport === "google-drive-api"
      ? readSettlementDriveBackupConfig()
      : { enabled: false as const };
    const driveBackup = driveBackupConfig.enabled ? driveBackupConfig : null;
    const driveBackupStore = createPostgresDriveBackupStore(sql);
    const localSyncBackupStore = createPostgresLocalSyncBackupStore(sql);
    const publicationStore = createVersionPublicationStore(sql, supabase);
    let driveClient: SettlementDriveClient | null = null;
    const [{ parseFile: versionParseFile }, { toSalesRecords: versionToSalesRecords, buildLookupMaps: versionBuildLookupMaps }, { xlsxArchiveDigest }] = await Promise.all([
      import("../src/features/settlement/lib/parsers/index"),
      import("../src/features/settlement/lib/aggregation/to-sales-records"),
      import("../src/features/settlement/lib/worker/run-job"),
    ]);

    console.log(`[settlement-worker] started mode=${once ? "once" : "loop"}`);
    do {
      if (stopping) break;
      const cycle = await runSettlementWorkerCycle({
        // Version processing remains deliberately one-shot until publication
        // can continue a backup-ready run safely. It fails closed without an
        // enabled Drive backup config: a run is never claimed if its verified
        // artifacts could not be backed up.
        versionEnabled: (once || env.versionProcessingEnabled) && env.versionWorkRoot !== null
          && (env.backupTransport === "local-sync" ? env.localSyncRoot !== null : driveBackup !== null),
        claimVersion: () => claimSettlementVersionRun(sql, id, leaseSeconds),
        runVersion: (run) => runClaimedVersionProcessing(run, {
          workRoot: env.versionWorkRoot as string,
          leaseSeconds,
          supabaseUrl: env.supabaseUrl,
          serviceRoleKey: env.serviceRoleKey,
        }, {
          ...versionLifecycle,
          shouldStop: () => stopping,
          materialize: (input) => materializeClaimedVersionSnapshot(input, {
            store: versionStore,
            fence: versionFence,
          }),
          processArtifacts: (input) => processSnapshotArtifacts(input, {
            fence: artifactFence,
            loadLookups: async () => versionBuildLookupMaps(await preparedStore.loadLookupRows()),
            parseFile: versionParseFile,
            toSalesRecords: versionToSalesRecords,
            buildStage: buildLocalParseStage,
            persistStage: persistLocalParseStage,
            generateWorkbook: generateLocalWorkbookArtifact,
            fillWorkbook: fillInputV2Template,
            validateWorkbook: validateSettlementWorkbook,
            archiveDigest: xlsxArchiveDigest,
          }),
          backupArtifacts: (input) => {
            if (env.backupTransport === "local-sync" && env.localSyncRoot) {
              return backupClaimedVersionToLocalSync({
                identity: input.identity,
                snapshot: input.snapshot,
                workbook: input.workbook,
                root: env.localSyncRoot,
                allowedBaseRoot: "/Volumes/SSD_MacMini/CLINK_YANGIL_GoogleDrive",
                leaseSeconds: input.leaseSeconds,
              }, {
                store: localSyncBackupStore,
                heartbeat: (heartbeatInput) => versionFence.heartbeat(heartbeatInput),
                shouldStop: () => stopping,
              });
            }
            if (!driveBackup) throw new Error("settlement drive backup config is disabled");
            driveClient ??= createSettlementDriveBackupClient(driveBackup);
            return backupClaimedVersionArtifacts({
              identity: input.identity,
              snapshot: input.snapshot,
              candidatePath: input.workbook.workbook.officePath,
              driveParentId: driveBackup.backupRootFolderId,
              leaseSeconds: input.leaseSeconds,
            }, {
              store: driveBackupStore,
              drive: driveClient,
              heartbeat: (heartbeatInput) => versionFence.heartbeat(heartbeatInput),
              shouldStop: () => stopping,
            });
          },
          publishWorkbook: (input) => publishClaimedVersionWorkbook({
            identity: input.identity,
            candidatePath: input.workbook.workbook.officePath,
            workbookSha256: input.workbook.workbook.evidence.officeWorkbookSha256,
            workbookSizeBytes: input.workbook.workbook.evidence.officeWorkbookSizeBytes,
          }, publicationStore),
        }),
        claimLegacy: () => claimSettlementJob(sql, id, leaseSeconds),
        runLegacy,
      });
      if (cycle.kind === "idle") {
        if (once) break;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, pollMs);
          wakePoll = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wakePoll = null;
        continue;
      }
      console.log(`[settlement-worker] contract=${cycle.kind} outcome=${cycle.outcome}`);
      if (once) break;
    } while (!stopping);
    console.log("[settlement-worker] stopped");
  } finally {
    process.off("SIGTERM", requestStop);
    process.off("SIGINT", requestStop);
    await sql.end({ timeout: 5 });
  }
}

void main().catch((error) => {
  console.error(`[settlement-worker] fatal=${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
