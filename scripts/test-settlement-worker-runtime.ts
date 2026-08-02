import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

async function main() {
  const [worker, workerStore, jobStore, routes, installer, plist] = await Promise.all([
    source("scripts/settlement-worker.ts"),
    source("src/features/settlement/lib/worker/run-job.ts"),
    source("src/features/settlement/lib/worker/job-contract.ts"),
    Promise.all([
      source("app/api/settlement/jobs/route.ts"),
      source("app/api/settlement/jobs/[id]/route.ts"),
    ]).then((values) => values.join("\n")),
    source("scripts/install-settlement-worker.sh"),
    source("ops/com.riverse.settlement-worker.plist.template"),
  ]);

  for (const required of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_DATABASE_URL",
  ]) {
    assert.match(worker, new RegExp(required));
    assert.match(installer, new RegExp(required));
  }
  assert.doesNotMatch(worker, /SUPABASE_SERVICE_ROLE_KEY|createServiceClient/);
  assert.match(worker, /createClient<Database>\(env\.supabaseUrl, env\.anonKey/);
  assert.match(worker, /postgres\(env\.databaseUrl/);
  assert.match(worker, /allowIncompleteSources:\s*true/);
  assert.match(worker, /shouldStop:\s*\(\) => stopping/);
  assert.match(worker, /await sql\.end\(\{ timeout: 5 \}\)/);

  assert.match(workerStore, /createPostgresSettlementWorkerStore/);
  assert.match(workerStore, /claimSettlementJob/);
  assert.match(workerStore, /deps\.store\.release\(job\.id, workerId\)/);
  assert.match(workerStore, /release_settlement_job\(/);
  assert.doesNotMatch(workerStore, /\.rpc\(\s*["'](?:claim|heartbeat|finish)_settlement_job/);
  assert.match(jobStore, /createPostgresSettlementJobApiStore/);
  assert.match(jobStore, /enqueue_settlement_job\(/);
  assert.match(jobStore, /jobApiSqlSingleton/);

  assert.doesNotMatch(routes, /createServiceClient|createSupabaseSettlementJobApiStore|SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(routes, /createPostgresSettlementJobApiStore\(\)/);
  assert.doesNotMatch(installer, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(installer, /Library\/Application Support\/Riverse\/settlement-worker/);
  assert.match(installer, /fs\.writeFileSync\([^;]+mode:\s*0o600/);
  assert.match(installer, /STAGED_ENV_FILE="\$TMP_DIR\/worker\.env"/);
  assert.match(installer, /cp "\$WORKER_ENV_FILE" "\$PREVIOUS_ENV_FILE" \|\| fail/);
  assert.match(installer, /install -m 600 "\$PREVIOUS_ENV_FILE" "\$WORKER_ENV_FILE"/);
  assert.match(installer, /mv "\$PREVIOUS_RUNTIME" "\$RUNTIME_DIR"/);
  assert.match(installer, /install -m 600 "\$PREVIOUS_PLIST" "\$PLIST"/);
  for (const failure of [
    "LaunchAgent bootout failed",
    "existing runtime backup failed",
    "runtime install failed",
    "LaunchAgent plist install failed",
    "worker environment install failed",
    "stdout log setup failed",
    "stderr log setup failed",
  ]) {
    assert.match(installer, new RegExp(`\\|\\| rollback_install "${failure}"`));
  }
  assert.ok(
    installer.indexOf("rollback_install()") < installer.indexOf('if [ "$WAS_LOADED" = true ]; then'),
    "rollback must be available before the installed service transition starts",
  );
  assert.match(installer, /trap 'transition_interrupted' HUP INT TERM/);
  assert.match(installer, /transition_interrupted\(\)[\s\S]*rollback_install "installation interrupted"/);
  assert.ok(
    installer.indexOf("rollback_install()") < installer.indexOf("trap 'transition_interrupted' HUP INT TERM")
      && installer.indexOf("trap 'transition_interrupted' HUP INT TERM") < installer.indexOf('if [ "$WAS_LOADED" = true ]; then'),
    "signal rollback trap must be installed after rollback exists and before transition",
  );
  assert.match(installer, /bootstrap_with_retry\(\)/);
  assert.match(installer, /bootstrap_with_retry \|\| rollback_install "LaunchAgent bootstrap failed"/);
  assert.match(installer, /mv "\$STAGED_RUNTIME" "\$RUNTIME_DIR"/);
  assert.match(installer, /while \[ "\$COUNT" -lt 20 \]/);
  assert.match(plist, /--env-file=__WORKER_ENV_FILE__/);
  assert.match(plist, /__BUNDLE_PATH__/);
  assert.doesNotMatch(plist, /tsx|__REPO_DIR__/);
  assert.match(plist, /<key>WorkingDirectory<\/key>\s*<string>__STATE_DIR__<\/string>/);
  assert.doesNotMatch(plist, /\.env\.local|SUPABASE_DATABASE_URL|SUPABASE_ANON_KEY/);
  assert.match(plist, /<key>ExitTimeOut<\/key>[\s\S]*?<integer>30<\/integer>/);

  console.log("test-settlement-worker-runtime: all assertions passed");
}

void main();
