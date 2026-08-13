import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function main() {
  const [sql, types] = await Promise.all([
    readFile(new URL("../supabase/migrations/037_settlement_version_job_retry.sql", import.meta.url), "utf8"),
    readFile(new URL("../src/features/settlement/lib/supabase/types.ts", import.meta.url), "utf8"),
  ]);
  assert.match(sql, /^begin;/m);
  assert.match(sql, /^commit;\s*$/m);
  assert.match(sql, /create function public\.retry_settlement_version_job\(\s*p_source_version_id uuid,\s*p_actor text\s*\)/i);
  assert.match(sql, /pg_advisory_xact_lock\([\s\S]*?'settlement_version_job:' \|\| p_source_version_id::text/i);
  assert.match(sql, /where j\.source_version_id = p_source_version_id\s+for update of j/i);
  assert.match(sql, /v_job\.status not in \('completed','completed_with_warnings','failed'\)/i);
  assert.match(sql, /r\.status in \('claimed','snapshotting','snapshot_ready'\)/i);
  assert.match(sql, /status = 'queued'[\s\S]*?worker_id = null[\s\S]*?claim_token = null[\s\S]*?lease_expires_at = null/i);
  assert.doesNotMatch(sql, /update public\.settlement_intake_versions|update public\.settlement_intake_version_files|delete from/i,
    "retry must not mutate immutable source/version bindings or delete history");
  assert.doesNotMatch(sql, /(?:update|delete from) public\.(?:settlement_processing_runs|settlement_publications|settlement_month_current|settlement_publication_audit)/i,
    "retry must preserve processing-run and publication history/current pointers");
  assert.match(sql, /'version_job_retry_requested'/i);
  assert.match(sql, /revoke all on function public\.retry_settlement_version_job\(uuid,text\)[\s\S]*?from public, anon, authenticated, service_role/i);
  assert.match(sql, /grant execute on function public\.retry_settlement_version_job\(uuid,text\)[\s\S]*?to service_role/i);
  assert.match(types, /retry_settlement_version_job:\s*\{[\s\S]*?p_source_version_id: string; p_actor: string[\s\S]*?Returns: string;/);
  console.log("test-settlement-version-job-retry: all assertions passed");
}
void main();
