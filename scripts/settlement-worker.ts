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

function requireWorkerEnvironment(): {
  supabaseUrl: string;
  anonKey: string;
  databaseUrl: string;
} {
  const missing = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_DATABASE_URL",
  ]
    .filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing required worker environment: ${missing.join(", ")}`);
  }
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    databaseUrl: process.env.SUPABASE_DATABASE_URL as string,
  };
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
    const supabase = createClient<Database>(env.supabaseUrl, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const workerStore = createPostgresSettlementWorkerStore(sql, supabase);
    const preparedStore = createSupabasePreparedUploadStore(supabase);
    const [{ parseFile }, { toSalesRecords, buildLookupMaps }] = await Promise.all([
      import("../src/features/settlement/lib/parsers/index"),
      import("../src/features/settlement/lib/aggregation/to-sales-records"),
    ]);

    console.log(`[settlement-worker] started mode=${once ? "once" : "loop"}`);
    do {
      if (stopping) break;
      const job = await claimSettlementJob(sql, id, leaseSeconds);
      if (!job) {
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

      const result = await runSettlementJob(job, id, leaseSeconds, {
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
          // The Mac worker produces a review candidate even when a required
          // source family is missing. loadInputV2Records preserves those gaps
          // as sourceWarnings, so the job finishes with warnings rather than
          // presenting the workbook as a clean result.
          allowIncompleteSources: true,
        }),
        fillWorkbook: fillInputV2Template,
        validateWorkbook: validateSettlementWorkbook,
      });
      console.log(
        `[settlement-worker] job=${job.id} outcome=${result.outcome} files=${result.filesProcessed} failures=${result.filesFailed}`,
      );
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
