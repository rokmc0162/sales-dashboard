// Structural, security, and concurrency contract for migration 030
// (dual-contract settlement version job queue). Deterministic static checks
// over the SQL source plus type-parity checks against the hand-written
// Supabase types and the legacy worker runner.
//
// The live-database counterpart is scripts/sql/test-030-settlement-version-job-queue.sql
// (npm run test:settlement-version-queue-sql).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../supabase/migrations/030_settlement_version_job_queue.sql",
  import.meta.url,
);
const intakeMigrationUrl = new URL(
  "../supabase/migrations/029_settlement_web_intake_versions.sql",
  import.meta.url,
);
const typesUrl = new URL(
  "../src/features/settlement/lib/supabase/types.ts",
  import.meta.url,
);
const runJobUrl = new URL(
  "../src/features/settlement/lib/worker/run-job.ts",
  import.meta.url,
);

function extractFunction(sql: string, name: string): string {
  const match = sql.match(
    new RegExp(`create or replace function ${name}\\([\\s\\S]+?\\n\\$\\$;`, "i"),
  );
  assert.ok(match, `migration must define function ${name}`);
  return match[0];
}

function extractBlock(source: string, header: string): string {
  const match = source.match(
    new RegExp(`${header}[\\s\\S]+?\\n\\};`, ""),
  );
  assert.ok(match, `types must contain ${header}`);
  return match[0];
}

async function main() {
  const [sql, intakeSql, types, runJob] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(intakeMigrationUrl, "utf8"),
    readFile(typesUrl, "utf8"),
    readFile(runJobUrl, "utf8"),
  ]);

  // ---------------- static sanity ----------------
  assert.match(sql, /^begin;/m, "migration must run in one transaction");
  assert.match(sql, /^commit;\s*$/m, "migration must commit");
  assert.equal((sql.match(/\$\$/g) ?? []).length % 2, 0, "dollar quotes must be balanced");
  assert.doesNotMatch(sql, /create table if not exists/i);
  assert.doesNotMatch(sql, /add column if not exists|drop trigger if exists|drop constraint if exists/i,
    "one-time transactional migration must not silently reconcile a partial schema");
  assert.match(sql, /-- rollback \(manual[^\n]*\):/i, "migration must document rollback");
  assert.match(sql, /delete from settlement_jobs where source_version_id is not null/i,
    "rollback docs must remove version jobs before restoring the legacy contract");
  assert.match(sql, /alter column upload_id set not null/i,
    "rollback docs must restore the legacy NOT NULL upload contract");

  // ---------------- dual-contract job columns ----------------
  assert.match(sql, /alter table settlement_jobs\s+add column source_version_id uuid,\s+add column claim_token uuid,\s+add column attempt_count integer not null default 0/i);
  assert.match(sql, /settlement_jobs_source_version_id_fkey[\s\S]+?references settlement_intake_versions\(id\) on delete restrict/i);
  assert.match(sql, /settlement_jobs_source_version_id_uniq\s+unique \(source_version_id\)/i,
    "one submitted version must map to at most one job");
  assert.match(sql, /attempt_count between 0 and 1000000/i);
  assert.match(sql, /check \(worker_id is null or claim_token is not null\)/i,
    "a leased job must always carry a fencing token");
  assert.ok(
    sql.indexOf("set claim_token = gen_random_uuid()") <
      sql.indexOf("settlement_jobs_lease_has_claim_token"),
    "in-flight leased rows must be stamped before the token invariant is added",
  );

  // ---------------- dual-contract file columns ----------------
  assert.match(sql, /alter table settlement_job_files\s+alter column upload_id drop not null,\s+add column source_version_file_id uuid/i);
  assert.match(sql, /settlement_job_files_source_version_file_id_fkey[\s\S]+?references settlement_intake_version_files\(id\) on delete restrict/i);
  assert.match(sql, /settlement_job_files_source_version_file_id_uniq\s+unique \(source_version_file_id\)/i);
  assert.match(sql, /check \(num_nonnulls\(upload_id, source_version_file_id\) = 1\)/i,
    "every job file must have exactly one source contract");

  // ---------------- contract guard triggers ----------------
  const jobGuard = extractFunction(sql, "settlement_jobs_source_contract_guard");
  assert.match(jobGuard, /new\.source_version_id is distinct from old\.source_version_id/i);
  assert.match(jobGuard, /source_version_id is immutable/i);
  assert.match(sql, /create trigger trg_settlement_jobs_source_contract\s+before update on settlement_jobs/i);

  const fileGuard = extractFunction(sql, "settlement_job_files_contract_guard");
  assert.match(fileGuard, /tg_op = 'UPDATE'/i);
  for (const frozen of ["job_id", "upload_id", "source_version_file_id", "position"]) {
    assert.match(
      fileGuard,
      new RegExp(`new\\.${frozen} is distinct from old\\.${frozen}`, "i"),
      `job file ${frozen} binding must be immutable`,
    );
  }
  assert.match(fileGuard, /if v_source_version_id is null then\s+if new\.upload_id is null or new\.source_version_file_id is not null/i,
    "legacy jobs must only accept upload-contract files");
  assert.match(fileGuard, /if new\.source_version_file_id is null or new\.upload_id is not null/i,
    "version jobs must only accept source-version files");
  assert.match(fileGuard, /vf\.id = new\.source_version_file_id\s+and vf\.version_id = v_source_version_id/i,
    "a version job file must belong to the job's own source version");
  assert.match(fileGuard, /vf\.position = new\.position/i,
    "a version job file must preserve its frozen source position");
  assert.match(sql, /create trigger trg_settlement_job_files_contract\s+before insert or update on settlement_job_files/i);

  // ---------------- version enqueue RPC ----------------
  const enqueue = extractFunction(sql, "enqueue_settlement_version_job");
  assert.match(enqueue, /p_source_version_id uuid,\s+p_actor text,\s+p_parser_version text default null,\s+p_rule_version text default null/i,
    "enqueue accepts only a version id plus audit/version metadata");
  assert.doesNotMatch(enqueue, /p_files|jsonb_array|storage_path|upload/i,
    "callers must not supply file lists, uploads, or storage paths");
  assert.match(enqueue, /pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\('settlement_version_job:' \|\| p_source_version_id::text, 0\)\)/i,
    "concurrent enqueues for one version must serialize");
  assert.match(enqueue, /unknown settlement intake version/i,
    "enqueue must accept only an existing submitted immutable version");
  const replayIdx = enqueue.search(/where source_version_id = p_source_version_id;\s+if found then\s+return v_job_id/i);
  assert.ok(replayIdx >= 0, "enqueue must be idempotent per source version");
  assert.ok(replayIdx < enqueue.search(/insert into public\.settlement_jobs/i),
    "the idempotent replay check must run before inserting a new job");
  assert.match(enqueue, /v_version\.file_count/i, "progress_total must come from the frozen version");
  assert.match(enqueue, /insert into public\.settlement_job_files \(job_id, source_version_file_id, position\)\s+select v_job_id, vf\.id, vf\.position\s+from public\.settlement_intake_version_files vf\s+where vf\.version_id = p_source_version_id\s+order by vf\.position/i,
    "the version's frozen files must be snapshotted deterministically by position");
  assert.match(enqueue, /'version_job_enqueued'/i, "enqueue must leave an intake audit row");
  assert.match(enqueue, /security definer/i);
  assert.match(enqueue, /set search_path = ''/i);

  // ---------------- legacy claim preserved + fenced ----------------
  const claim = extractFunction(sql, "claim_settlement_job");
  assert.match(claim, /p_worker_id text,\s+p_lease_seconds integer default 900/i,
    "claim signature must not change (deployed worker compatibility)");
  assert.match(claim, /returns setof settlement_jobs/i);
  assert.match(claim, /where source_version_id is null/i,
    "the legacy worker must never be handed a version job it cannot process");
  assert.match(claim, /status = 'queued'/i);
  assert.match(claim, /status in \('claimed','processing'\)\s+and lease_expires_at < clock_timestamp\(\)/i,
    "expired-lease legacy rows must remain reclaimable/drainable");
  assert.match(claim, /order by created_at, id/i);
  assert.match(claim, /for update skip locked/i);
  assert.match(claim, /limit 1/i);
  assert.match(claim, /claim_token = gen_random_uuid\(\)/i, "every claim must rotate the fencing token");
  assert.match(claim, /attempt_count = least\(j\.attempt_count \+ 1, 1000000\)/i,
    "every claim must count an attempt without ever violating the bound");

  // ---------------- draft operations still never enqueue ----------------
  assert.doesNotMatch(
    intakeSql,
    /insert into (public\.)?settlement_jobs|(perform|select)[^;]*enqueue_settlement/i,
    "migration 029 draft/submit RPCs must not touch the job queue",
  );
  assert.doesNotMatch(sql, /create trigger[^;]+on settlement_intake/i,
    "migration 030 must not auto-enqueue from intake tables");

  // ---------------- security: service_role only, per 028/029 ----------------
  for (const [fn, args] of [
    ["enqueue_settlement_version_job", "uuid, text, text, text"],
    ["claim_settlement_job", "text, integer"],
  ] as const) {
    assert.match(sql, new RegExp(
      `revoke all on function ${fn}\\(${args}\\) from public, anon, authenticated`, "i"));
    assert.match(sql, new RegExp(
      `grant execute on function ${fn}\\(${args}\\) to service_role`, "i"));
  }
  assert.doesNotMatch(sql, /grant[^;]+to (anon|authenticated)\b/i);
  assert.doesNotMatch(sql, /create policy/i);

  // ---------------- type parity ----------------
  const jobRow = extractBlock(types, "export type SettlementJobRow = \\{");
  assert.match(jobRow, /source_version_id: string \| null;/);
  assert.match(jobRow, /claim_token: string \| null;/);
  assert.match(jobRow, /attempt_count: number;/);
  const fileRow = extractBlock(types, "export type SettlementJobFileRow = \\{");
  assert.match(fileRow, /upload_id: string \| null;/);
  assert.match(fileRow, /source_version_file_id: string \| null;/);
  assert.match(
    types,
    /enqueue_settlement_version_job:\s*\{[\s\S]+?p_source_version_id: string;[\s\S]+?p_actor: string;[\s\S]+?Returns: string;/,
    "Supabase function types must include the version enqueue RPC",
  );

  // The legacy runner stays legacy-only: it must guard the now-nullable
  // upload_id instead of assuming every job file carries an upload.
  assert.match(runJob, /job\.source_version_id !== null/,
    "legacy runner must reject a version job before any side effect");
  assert.match(runJob, /file\.upload_id !== null && file\.source_version_file_id === null/,
    "legacy runner must reject version-contract files before processing");

  console.log("test-settlement-version-queue: all assertions passed");
}

void main();
