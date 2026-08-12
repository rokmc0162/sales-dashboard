import { hostname } from "node:os";

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

import type { Database } from "../src/features/settlement/lib/supabase/types";
import { fillInputV2Template } from "../src/features/settlement/lib/export/input-v2-filler";
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
import {
  createPostgresVersionSourceFence,
  createPostgresVersionSourceStore,
  materializeClaimedVersionSnapshot,
} from "../src/features/settlement/lib/worker/version-source-adapter";
import {
  claimSettlementVersionRun,
  createPostgresVersionRunLifecycle,
  runClaimedVersionSnapshot,
} from "../src/features/settlement/lib/worker/version-source-runner";
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

    console.log(`[settlement-worker] started mode=${once ? "once" : "loop"}`);
    do {
      if (stopping) break;
      const cycle = await runSettlementWorkerCycle({
        // Snapshot-only version processing is deliberately one-shot until the
        // parser staging pipeline (impl-6) can continue a snapshot-ready run.
        versionEnabled: once && env.versionWorkRoot !== null,
        claimVersion: () => claimSettlementVersionRun(sql, id, leaseSeconds),
        runVersion: (run) => runClaimedVersionSnapshot(run, {
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
