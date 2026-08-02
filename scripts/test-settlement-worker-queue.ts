import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationUrl = new URL("../supabase/migrations/022_settlement_worker_jobs.sql", import.meta.url);
const artifactFixUrl = new URL("../supabase/migrations/023_fix_settlement_worker_artifact_path.sql", import.meta.url);
const releaseUrl = new URL("../supabase/migrations/024_release_settlement_worker_job.sql", import.meta.url);

async function main() {
  const [sql, artifactFix, releaseSql] = await Promise.all([
    readFile(migrationUrl, "utf8"),
    readFile(artifactFixUrl, "utf8"),
    readFile(releaseUrl, "utf8"),
  ]);

  assert.match(sql, /create table if not exists settlement_jobs\s*\(/i);
  assert.match(sql, /create table if not exists settlement_job_files\s*\(/i);
  for (const status of [
    "queued", "claimed", "processing", "completed", "completed_with_warnings", "failed",
  ]) {
    assert.match(sql, new RegExp(`['"]${status}['"]`));
  }
  assert.match(sql, /progress_current\s+integer[^;]+between 0 and 200/is);
  assert.match(sql, /progress_total\s+integer[^;]+between 1 and 200/is);
  assert.match(sql, /error_summary\s+varchar\(500\)/i);
  assert.match(sql, /result_summary\s+varchar\(500\)/i);
  assert.match(sql, /folder_hint\s+varchar\(200\)/i);
  assert.match(sql, /artifact_storage_path\s+varchar\(500\)[^;]+A-Za-z0-9\/\._-/is);
  assert.doesNotMatch(sql, /A-Za-z0-9\/\._-\]\{1,500\}/);
  assert.match(sql, /length\(artifact_storage_path\) between 1 and 500/i);
  assert.match(artifactFix, /drop constraint if exists settlement_jobs_artifact_storage_path_check/i);
  assert.match(artifactFix, /length\(p_artifact_storage_path\) > 500/i);
  assert.doesNotMatch(artifactFix, /\{1,500\}/);

  assert.match(sql, /alter table settlement_jobs enable row level security/i);
  assert.match(sql, /alter table settlement_job_files enable row level security/i);
  assert.doesNotMatch(sql, /create policy[^;]+settlement_job/is);
  assert.match(sql, /revoke all on table settlement_jobs from public, anon, authenticated/i);
  assert.match(sql, /revoke all on table settlement_job_files from public, anon, authenticated/i);

  const claim = sql.match(/create or replace function claim_settlement_job[\s\S]+?\n\$\$;/i)?.[0] ?? "";
  assert.match(claim, /for update skip locked/i);
  assert.match(claim, /status = 'queued'/i);
  assert.match(claim, /status in \('claimed','processing'\)[\s\S]+lease_expires_at < clock_timestamp\(\)/i);
  assert.match(claim, /order by created_at, id/i);
  assert.match(claim, /limit 1/i);

  const heartbeat = sql.match(/create or replace function heartbeat_settlement_job[\s\S]+?\n\$\$;/i)?.[0] ?? "";
  assert.match(heartbeat, /worker_id = p_worker_id/i);
  assert.match(heartbeat, /lease_expires_at >= clock_timestamp\(\)/i);
  assert.match(heartbeat, /returns boolean/i);

  const finish = sql.match(/create or replace function finish_settlement_job[\s\S]+?\n\$\$;/i)?.[0] ?? "";
  assert.match(finish, /p_status not in \('completed','completed_with_warnings','failed'\)/i);
  assert.match(finish, /worker_id = p_worker_id/i);
  assert.match(finish, /lease_expires_at >= clock_timestamp\(\)/i);
  assert.match(finish, /left\(p_error_summary, 500\)/i);
  assert.match(finish, /left\(p_result_summary, 500\)/i);

  const enqueue = sql.match(/create or replace function enqueue_settlement_job[\s\S]+?\n\$\$;/i)?.[0] ?? "";
  assert.match(enqueue, /status = 'uploaded'/i);
  assert.match(enqueue, /settlement_month = p_month/i);
  assert.match(enqueue, /storage_path ~ '\^uploads\//i);
  assert.match(enqueue, /upload already assigned to a job/i);

  for (const fn of [
    "enqueue_settlement_job", "claim_settlement_job", "heartbeat_settlement_job", "finish_settlement_job",
  ]) {
    assert.match(sql, new RegExp(`revoke all on function ${fn}\\(`, "i"));
    assert.match(sql, new RegExp(`grant execute on function ${fn}\\([^;]+to service_role`, "i"));
  }
  const release = releaseSql.match(/create or replace function release_settlement_job[\s\S]+?\n\$\$;/i)?.[0] ?? "";
  assert.match(release, /worker_id = p_worker_id/i);
  assert.match(release, /status in \('claimed', 'processing'\)/i);
  assert.match(release, /lease_expires_at >= clock_timestamp\(\)/i);
  assert.match(release, /for update/i, "release must serialize with fenced file updates");
  assert.match(release, /settlement_job_files[\s\S]+job_id = v_job_id[\s\S]+status = 'processing'/i);
  assert.match(release, /if exists[\s\S]+return false/i, "a processing file must refuse release");
  assert.match(release, /set status = 'queued'[\s\S]+worker_id = null[\s\S]+lease_expires_at = null/i);
  assert.match(releaseSql, /revoke all on function release_settlement_job\(uuid, text\) from public, anon, authenticated/i);
  assert.match(releaseSql, /grant execute on function release_settlement_job\(uuid, text\) to service_role/i);
  assert.equal((sql.match(/\$\$/g) ?? []).length % 2, 0, "PL/pgSQL dollar quotes must be balanced");
  assert.equal((releaseSql.match(/\$\$/g) ?? []).length % 2, 0, "release PL/pgSQL dollar quotes must be balanced");

  console.log("test-settlement-worker-queue: all assertions passed");
}

void main();
