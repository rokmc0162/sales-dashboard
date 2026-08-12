// Static contract checks for migration 031 (version-aware processing runs).
// The live semantic/rollback counterpart is
// scripts/sql/test-031-settlement-processing-runs.sql.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../supabase/migrations/031_settlement_processing_runs.sql",
  import.meta.url,
);
const typesUrl = new URL(
  "../src/features/settlement/lib/supabase/types.ts",
  import.meta.url,
);
const packageUrl = new URL("../package.json", import.meta.url);

function extractFunction(sql: string, name: string): string {
  const match = sql.match(
    new RegExp(
      `create or replace function public\\.${name}\\([\\s\\S]+?\\n\\$\\$;`,
      "i",
    ),
  );
  assert.ok(match, `migration must define ${name}`);
  return match[0];
}

function extractType(source: string, name: string): string {
  const match = source.match(
    new RegExp(`export type ${name} = \\{[\\s\\S]+?\\n\\};`),
  );
  assert.ok(match, `Supabase types must define ${name}`);
  return match[0];
}

async function main() {
  const [sql, types, packageSource] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(typesUrl, "utf8"),
    readFile(packageUrl, "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource) as {
    scripts: Record<string, string>;
  };

  // One-shot transactional migration and an executable, evidence-preserving
  // rollback recipe.
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
  assert.doesNotMatch(sql, /create table if not exists/i);
  assert.match(sql, /-- rollback \(manual[^\n]+ONE transaction/i);
  assert.match(sql, /rollback refused: processing-run evidence exists/i);
  assert.match(sql, /drop table public\.settlement_processing_runs/i);

  // Immutable run identity and attempt history.
  const table = sql.match(
    /create table public\.settlement_processing_runs \([\s\S]+?\n\);/i,
  )?.[0];
  assert.ok(table, "migration must create settlement_processing_runs");
  for (const column of [
    "job_id",
    "source_version_id",
    "attempt_no",
    "parser_version",
    "rule_version",
    "worker_id",
    "claim_token",
  ]) {
    assert.match(table, new RegExp(`\\b${column}\\b`, "i"));
  }
  assert.match(table, /unique \(job_id, attempt_no\)/i);
  for (const status of [
    "claimed",
    "snapshotting",
    "snapshot_ready",
    "failed",
    "released",
  ]) {
    assert.match(table, new RegExp(`'${status}'`));
  }
  assert.match(
    sql,
    /create unique index idx_settlement_processing_runs_one_active_job[\s\S]+?where status in \('claimed','snapshotting','snapshot_ready'\)/i,
  );

  const identityGuard = extractFunction(
    sql,
    "settlement_processing_runs_identity_guard",
  );
  for (const column of [
    "job_id",
    "source_version_id",
    "attempt_no",
    "parser_version",
    "rule_version",
    "worker_id",
    "claim_token",
  ]) {
    assert.match(
      identityGuard,
      new RegExp(`new\\.${column} is distinct from old\\.${column}`, "i"),
      `${column} must be immutable after insert`,
    );
  }
  assert.match(identityGuard, /settlement processing runs cannot be deleted/i);
  assert.match(identityGuard, /tg_op = 'INSERT'/i);
  assert.match(
    identityGuard,
    /new\.source_version_id is distinct from v_job\.source_version_id/i,
  );
  assert.match(identityGuard, /new\.attempt_no is distinct from v_job\.attempt_count/i);
  assert.match(identityGuard, /new\.parser_version is distinct from v_job\.parser_version/i);
  assert.match(identityGuard, /new\.rule_version is distinct from v_job\.rule_version/i);
  assert.match(
    sql,
    /create trigger trg_settlement_processing_runs_identity\s+before insert or update or delete/i,
  );

  // Version-only, nonblocking claim. An expired run is terminalized before
  // the token/attempt rotates and the replacement run is inserted.
  const claim = extractFunction(sql, "claim_settlement_version_job");
  assert.match(claim, /returns setof public\.settlement_processing_runs/i);
  assert.match(claim, /j\.source_version_id is not null/i);
  assert.match(claim, /for update of j skip locked/i);
  assert.match(claim, /order by j\.created_at, j\.id/i);
  assert.match(claim, /status = 'released'[\s\S]+?lease expired and claim was superseded/i);
  assert.match(claim, /claim_token = pg_catalog\.gen_random_uuid\(\)/i);
  assert.match(claim, /attempt_count = j\.attempt_count \+ 1/i);
  assert.match(claim, /insert into public\.settlement_processing_runs/i);
  assert.ok(
    claim.indexOf("status = 'released'") <
      claim.indexOf("claim_token = pg_catalog.gen_random_uuid()"),
    "reclaim must terminalize the old run before rotating the job claim",
  );

  // Migration 031 is additive. It must not replace or drop any deployed
  // legacy queue RPC.
  for (const legacy of [
    "claim_settlement_job",
    "heartbeat_settlement_job",
    "finish_settlement_job",
    "release_settlement_job",
  ]) {
    assert.doesNotMatch(
      sql,
      new RegExp(`(create or replace|drop) function (public\\.)?${legacy}\\b`, "i"),
      `migration must leave legacy RPC ${legacy} unchanged`,
    );
  }

  // Every mutator has an empty search path and applies the same exact fence
  // to both the job row and run row before changing either one.
  const fenced = [
    ["heartbeat_settlement_processing_run", "uuid, uuid, text, uuid, integer"],
    ["mark_settlement_processing_run_snapshot_ready", "uuid, uuid, text, uuid, text, integer, bigint"],
    ["fail_settlement_processing_run", "uuid, uuid, text, uuid, text"],
    ["release_settlement_processing_run", "uuid, uuid, text, uuid"],
  ] as const;
  for (const [name] of fenced) {
    const body = extractFunction(sql, name);
    assert.match(body, /security definer\s+set search_path = ''/i);
    assert.match(body, /j\.id = p_job_id/i);
    assert.match(body, /j\.worker_id = p_worker_id/i);
    assert.match(body, /j\.claim_token = p_claim_token/i);
    assert.match(body, /j\.lease_expires_at into v_locked_id, v_job_lease/i);
    assert.match(body, /r\.id = p_run_id/i);
    assert.match(body, /r\.job_id = p_job_id/i);
    assert.match(body, /r\.worker_id = p_worker_id/i);
    assert.match(body, /r\.claim_token = p_claim_token/i);
    assert.match(body, /r\.lease_expires_at into v_locked_id, v_run_lease/i);
    assert.match(body, /v_now := pg_catalog\.clock_timestamp\(\)/i);
    assert.match(body, /v_job_lease < v_now or v_run_lease < v_now/i);
  }
  assert.match(claim, /security definer\s+set search_path = ''/i);
  assert.match(
    extractFunction(sql, "heartbeat_settlement_processing_run"),
    /case when status = 'claimed' then 'snapshotting' else status end/i,
  );
  assert.match(
    extractFunction(sql, "mark_settlement_processing_run_snapshot_ready"),
    /set status = 'snapshot_ready'/i,
  );
  const snapshotReady = extractFunction(sql, "mark_settlement_processing_run_snapshot_ready");
  assert.match(snapshotReady, /snapshot_manifest_sha256 = coalesce/i);
  assert.match(snapshotReady, /snapshot_file_count = coalesce/i);
  assert.match(snapshotReady, /snapshot_total_bytes = coalesce/i);
  assert.match(snapshotReady, /snapshot_manifest_sha256 is distinct from p_manifest_sha256/i);

  // Explicitly compose with earlier default privileges: direct mutation is
  // denied even to service_role; only the five RPCs are executable by it.
  assert.match(
    sql,
    /revoke all on table public\.settlement_processing_runs\s+from public, anon, authenticated, service_role/i,
  );
  assert.match(
    sql,
    /grant select on table public\.settlement_processing_runs to service_role/i,
  );
  assert.doesNotMatch(
    sql,
    /grant (insert|update|delete|all)[^;]+settlement_processing_runs[^;]+service_role/i,
  );
  for (const [name, args] of [
    ["claim_settlement_version_job", "text, integer"],
    ...fenced,
  ] as const) {
    assert.match(
      sql,
      new RegExp(
        `revoke all on function public\\.${name}\\(${args}\\)\\s+from public, anon, authenticated, service_role`,
        "i",
      ),
    );
    assert.match(
      sql,
      new RegExp(
        `grant execute on function public\\.${name}\\(${args}\\)\\s+to service_role`,
        "i",
      ),
    );
  }

  // Hand-written Supabase type parity and package entry points.
  const runRow = extractType(types, "SettlementProcessingRunRow");
  assert.match(runRow, /status: SettlementProcessingRunStatus;/);
  assert.match(runRow, /attempt_no: number;/);
  assert.match(runRow, /claim_token: string;/);
  assert.match(runRow, /snapshot_manifest_sha256: string \| null;/);
  assert.match(runRow, /snapshot_file_count: number \| null;/);
  assert.match(runRow, /snapshot_total_bytes: number \| null;/);
  assert.match(
    types,
    /settlement_processing_runs:\s*\{\s*Row: SettlementProcessingRunRow;/,
  );
  for (const rpc of [
    "claim_settlement_version_job",
    "heartbeat_settlement_processing_run",
    "mark_settlement_processing_run_snapshot_ready",
    "fail_settlement_processing_run",
    "release_settlement_processing_run",
  ]) {
    assert.match(types, new RegExp(`${rpc}:\\s*\\{`));
  }
  assert.equal(
    packageJson.scripts["test:settlement-processing-runs"],
    "node --import tsx scripts/test-settlement-processing-runs.ts",
  );
  assert.match(
    packageJson.scripts["test:settlement-processing-runs-sql"],
    /scripts\/sql\/test-031-settlement-processing-runs\.sql/,
  );

  console.log("test-settlement-processing-runs: all assertions passed");
}

void main();
