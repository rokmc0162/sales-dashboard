// Static contract checks for migration 033 (Drive backup reservations).
// The live semantic/rollback counterpart is
// scripts/sql/test-033-settlement-drive-backups.sql.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL(
  "../supabase/migrations/033_settlement_drive_backups.sql",
  import.meta.url,
);

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

async function main() {
  const sql = await readFile(migrationUrl, "utf8");

  // One-shot transactional, create-only migration.
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
  assert.doesNotMatch(sql, /create table if not exists/i);
  assert.doesNotMatch(sql, /drop table/i);

  // Table: one row per immutable backup identity, DB-derived only.
  const table = sql.match(
    /create table public\.settlement_drive_backups \([\s\S]+?\n\);/i,
  )?.[0];
  assert.ok(table, "migration must create settlement_drive_backups");
  for (const kind of ["source_manifest", "source_file", "verified_workbook"]) {
    assert.match(table, new RegExp(`'${kind}'`));
  }
  assert.match(
    table,
    /backup_identity varchar\(64\) not null unique check \(backup_identity ~ '\^\(svm\|svf\|run\):\[0-9a-f-\]\{36\}\$'\)/,
  );
  assert.match(table, /content_sha256 char\(64\) not null check \(content_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(table, /size_bytes bigint not null check \(size_bytes between 1 and 107374182400\)/);
  assert.match(table, /references public\.settlement_intake_versions\(id\) on delete restrict/);
  assert.match(table, /references public\.settlement_intake_version_files\(id\) on delete restrict/);
  assert.match(table, /references public\.settlement_processing_runs\(id\) on delete restrict/);

  // Scope check binds identity to exactly one owning row per kind.
  const scope = table.match(
    /constraint settlement_drive_backups_scope_check check \([\s\S]+?\n {2}\),/,
  )?.[0];
  assert.ok(scope, "scope constraint required");
  assert.match(scope, /kind = 'source_manifest' and source_version_file_id is null and run_id is null\s+and backup_identity = 'svm:' \|\| source_version_id::text/);
  assert.match(scope, /kind = 'source_file' and source_version_file_id is not null and run_id is null\s+and backup_identity = 'svf:' \|\| source_version_file_id::text/);
  assert.match(scope, /kind = 'verified_workbook' and source_version_file_id is null and run_id is not null\s+and backup_identity = 'run:' \|\| run_id::text/);

  // State check: pending/retry carry no Drive evidence; verified carries all of it.
  const state = table.match(
    /constraint settlement_drive_backups_state_check check \([\s\S]+?\n {2}\),/,
  )?.[0];
  assert.ok(state, "state constraint required");
  assert.match(state, /status in \('pending','retry'\) and drive_file_id is null and drive_sha256 is null\s+and drive_version is null and uploaded_at is null and verified_at is null/);
  assert.match(state, /status = 'verified' and drive_file_id is not null and drive_sha256 is not null\s+and drive_version is not null and uploaded_at is not null and verified_at is not null/);
  assert.match(state, /drive_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(state, /drive_version ~ '\^\(0\|\[1-9\]\[0-9\]\{0,19\}\)\$'/);

  // Retry bookkeeping is all-or-nothing.
  assert.match(table, /status = 'retry' and next_retry_at is not null and error_summary is not null/);
  assert.match(table, /status <> 'retry' and next_retry_at is null and error_summary is null/);

  // Partial unique indexes: one manifest per version, one backup per source
  // file, one workbook per run, one row per Drive file id.
  assert.match(sql, /create unique index settlement_drive_backups_source_manifest_uniq\s+on public\.settlement_drive_backups\(source_version_id\) where kind = 'source_manifest';/);
  assert.match(sql, /create unique index settlement_drive_backups_source_file_uniq\s+on public\.settlement_drive_backups\(source_version_file_id\) where kind = 'source_file';/);
  assert.match(sql, /create unique index settlement_drive_backups_workbook_uniq\s+on public\.settlement_drive_backups\(run_id\) where kind = 'verified_workbook';/);
  assert.match(sql, /create unique index settlement_drive_backups_drive_file_uniq\s+on public\.settlement_drive_backups\(drive_file_id\) where drive_file_id is not null;/);

  // --- begin_settlement_drive_backup ---
  const begin = extractFunction(sql, "begin_settlement_drive_backup");
  assert.match(begin, /security definer set search_path = ''/);
  // Fenced against job + run identity, live leases, snapshot-ready state.
  assert.match(begin, /j\.worker_id = p_worker_id and j\.claim_token = p_claim_token\s+and j\.status = 'processing' for update of j/);
  assert.match(begin, /r\.worker_id = p_worker_id and r\.claim_token = p_claim_token\s+and r\.status = 'snapshot_ready' for update of r/);
  assert.match(begin, /v_job\.lease_expires_at <= v_now or v_run\.lease_expires_at <= v_now\s+or v_run\.snapshot_ready_at is null/);
  assert.match(begin, /if p_attempt_token is null/);
  // Manifest identity + hash + size are recomputed from version files and
  // cross-checked against the version's recorded manifest digest.
  assert.match(begin, /order by f\.position/);
  assert.match(begin, /pg_catalog\.sha256\(pg_catalog\.convert_to\(v_manifest, 'UTF8'\)\)/);
  assert.match(begin, /if v_manifest_sha256 is distinct from v_version\.manifest_sha256 then return; end if;/);
  assert.match(begin, /v_identity := 'svm:' \|\| v_version\.id::text;/);
  // Source-file identity + hash + size come from the version-file row, which
  // must belong to the claimed version.
  assert.match(begin, /where f\.id = p_source_version_file_id and f\.version_id = v_version\.id/);
  assert.match(begin, /v_identity := 'svf:' \|\| v_version_file\.id::text;/);
  assert.match(begin, /v_content_sha256 := v_version_file\.sha256;/);
  // Workbook identity + hash + size come from the run's verified evidence.
  assert.match(begin, /if v_run\.workbook_ready_at is null or v_run\.workbook_sha256 is null\s+or v_run\.workbook_size_bytes is null then return; end if;/);
  assert.match(begin, /v_identity := 'run:' \|\| v_run\.id::text;/);
  assert.match(begin, /v_content_sha256 := v_run\.workbook_sha256;/);
  // Serialized per identity; first attempt inserts pending with attempt 1.
  assert.match(begin, /pg_advisory_xact_lock\(\s+pg_catalog\.hashtextextended\('settlement_drive_backup:' \|\| v_identity, 0\)\)/);
  assert.match(begin, /'pending', 1, v_run\.id, p_claim_token, p_attempt_token/);
  // Replays fail closed on any identity/hash/size/parent drift.
  assert.match(begin, /v_backup\.content_sha256 is distinct from v_content_sha256/);
  assert.match(begin, /v_backup\.size_bytes is distinct from v_size_bytes/);
  assert.match(begin, /v_backup\.drive_parent_id is distinct from p_drive_parent_id/);
  // Verified rows replay idempotently; live claims are attempt-token fenced.
  assert.match(begin, /if v_backup\.status = 'verified' then return next v_backup; return; end if;/);
  assert.match(begin, /if v_backup\.active_claim_token = p_claim_token then\s+if v_backup\.active_run_id is distinct from v_run\.id\s+or v_backup\.active_attempt_token is distinct from p_attempt_token\s+then return; end if;/);
  // Rotated claims take over source backups only; workbook rows are run-scoped.
  assert.match(begin, /if p_kind = 'verified_workbook' then return; end if;\s+update public\.settlement_drive_backups set\s+status = 'pending', attempt_count = attempt_count \+ 1,\s+active_run_id = v_run\.id, active_claim_token = p_claim_token,\s+active_attempt_token = p_attempt_token, next_retry_at = null/);

  // --- verify_settlement_drive_backup ---
  const verify = extractFunction(sql, "verify_settlement_drive_backup");
  assert.match(verify, /security definer set search_path = ''/);
  assert.match(verify, /pg_catalog\.length\(p_drive_file_id\) not between 1 and 256/);
  assert.match(verify, /p_drive_file_id !~ '\^\[A-Za-z0-9_-\]\+\$'/);
  assert.match(verify, /p_drive_sha256 !~ '\^\[0-9a-f\]\{64\}\$'/);
  assert.match(verify, /p_drive_version !~ '\^\(0\|\[1-9\]\[0-9\]\{0,19\}\)\$'/);
  // Same job/run/lease fencing plus attempt-token binding on the backup row.
  assert.match(verify, /and b\.active_run_id = p_run_id and b\.active_claim_token = p_claim_token\s+and b\.active_attempt_token = p_attempt_token for update of b/);
  assert.match(verify, /v_job\.lease_expires_at <= v_now or v_run\.lease_expires_at <= v_now\s+or p_drive_sha256 is distinct from v_backup\.content_sha256/);
  // Verified replay must match exactly; Drive file ids are single-owner.
  assert.match(verify, /return v_backup\.drive_file_id = p_drive_file_id\s+and v_backup\.drive_sha256 = p_drive_sha256\s+and v_backup\.drive_version = p_drive_version;/);
  assert.match(verify, /where b\.drive_file_id = p_drive_file_id and b\.id <> v_backup\.id for update of b;\s+if found then return false; end if;/);
  assert.match(verify, /exception when unique_violation then\s+return false;/);

  // --- retry_settlement_drive_backup ---
  const retry = extractFunction(sql, "retry_settlement_drive_backup");
  assert.match(retry, /security definer set search_path = ''/);
  assert.match(retry, /pg_catalog\.length\(p_error_summary\) not between 1 and 500/);
  assert.match(retry, /p_retry_seconds not between 5 and 86400/);
  assert.match(retry, /and b\.active_run_id = p_run_id and b\.active_claim_token = p_claim_token\s+and b\.active_attempt_token = p_attempt_token for update of b/);
  assert.match(retry, /if not found or v_backup\.status = 'verified' then return false; end if;/);
  assert.match(retry, /if v_backup\.status = 'retry' then\s+return v_backup\.error_summary = p_error_summary;/);
  assert.match(retry, /make_interval\(secs => p_retry_seconds\)/);

  // --- Privileges: RLS on, no direct DML, RPCs service_role-only. ---
  assert.match(sql, /alter table public\.settlement_drive_backups enable row level security;/);
  assert.match(sql, /revoke all on table public\.settlement_drive_backups from public, anon, authenticated, service_role;/);
  assert.match(sql, /grant select on table public\.settlement_drive_backups to service_role;/);
  assert.doesNotMatch(sql, /grant (insert|update|delete|all)[^\n]*settlement_drive_backups/i);
  for (const fn of [
    "begin_settlement_drive_backup\\(uuid,uuid,text,uuid,uuid,text,uuid,text\\)",
    "verify_settlement_drive_backup\\(uuid,uuid,text,uuid,uuid,uuid,text,text,text\\)",
    "retry_settlement_drive_backup\\(uuid,uuid,text,uuid,uuid,uuid,text,integer\\)",
  ]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\s+from public, anon, authenticated, service_role;`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn} to service_role;`));
  }
  assert.doesNotMatch(sql, /grant execute[^\n]*to (anon|authenticated|public)\b/i);

  // Migration 033 must not redefine any prior lifecycle function.
  for (const fn of [
    "claim_settlement_version_job",
    "heartbeat_settlement_processing_run",
    "mark_settlement_processing_run_snapshot_ready",
    "mark_settlement_processing_run_stage_ready",
    "mark_settlement_processing_run_workbook_ready",
    "fail_settlement_processing_run",
    "release_settlement_processing_run",
    "enqueue_settlement_version_job",
    "submit_settlement_intake_version",
  ]) {
    assert.doesNotMatch(
      sql,
      new RegExp(`create or replace function public\\.${fn}\\b`, "i"),
      `migration 033 must not redefine ${fn}`,
    );
  }
  assert.doesNotMatch(sql, /alter function/i);
  assert.doesNotMatch(sql, /alter table public\.settlement_(jobs|processing_runs|intake_versions|intake_version_files)\b/i);

  console.log("test-settlement-drive-backups: all assertions passed");
}

void main();
