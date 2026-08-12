-- Live contract + rollback check for migration 031. The target database must
-- already have migrations through 031 applied:
--
--   npm run test:settlement-processing-runs-sql
--
-- This script never applies a migration. It runs in one outer transaction and
-- always ROLLBACKs. Runtime fixtures are separately rolled back to a savepoint
-- before the documented 031 schema rollback is exercised, so the evidence
-- guard is tested without discarding any real processing-run row.

\set ON_ERROR_STOP on

begin;

create temporary table legacy_rpc_before on commit drop as
select
  p.oid::regprocedure::text as signature,
  pg_catalog.pg_get_functiondef(p.oid) as definition
from pg_catalog.pg_proc p
where p.oid = any (array[
  'public.claim_settlement_job(text,integer)'::regprocedure,
  'public.heartbeat_settlement_job(uuid,text,integer,text,integer,integer)'::regprocedure,
  'public.finish_settlement_job(uuid,text,text,text,text,text,integer,integer)'::regprocedure,
  'public.release_settlement_job(uuid,text)'::regprocedure
]);

savepoint runtime_contract;

do $contract$
declare
  v_actor constant text := 'processing-run-contract-check';
  v_sha constant char(64) := pg_catalog.repeat('c', 64);
  v_intake public.settlement_intake_months;
  v_object public.settlement_intake_objects;
  v_version public.settlement_intake_versions;
  v_version_job_id uuid;
  v_legacy_job_id uuid;
  v_legacy_upload_id uuid;
  v_run_1 public.settlement_processing_runs;
  v_run_2 public.settlement_processing_runs;
  v_run_3 public.settlement_processing_runs;
  v_job public.settlement_jobs;
  v_legacy_claim public.settlement_jobs;
  v_before_updated_at timestamptz;
begin
  -- Submitted immutable version and its version-bound logical job.
  v_intake := public.create_settlement_intake('299801', v_actor);
  v_object := public.register_settlement_intake_object(
    v_intake.id,
    'processing-run/source.csv',
    'source.csv',
    'text/csv',
    12,
    v_sha,
    v_actor,
    v_intake.draft_revision,
    null
  );
  v_object := public.finalize_settlement_intake_object(
    v_object.id, 12, v_sha, v_actor
  );
  perform public.upsert_settlement_intake_draft_entry(
    v_intake.id, v_object.id, v_intake.draft_revision, v_actor
  );
  select * into v_intake
  from public.settlement_intake_months
  where id = v_intake.id;
  v_version := public.submit_settlement_intake_version(
    v_intake.id, v_intake.draft_revision, v_actor
  );
  v_version_job_id := public.enqueue_settlement_version_job(
    v_version.id, v_actor, 'parser-contract-v1', 'rule-contract-v1'
  );
  update public.settlement_jobs
     set created_at = timestamptz '1900-01-02 00:00:00+00'
   where id = v_version_job_id;

  -- An even older legacy job proves the new claim path filters by source
  -- contract before applying claim order.
  insert into public.raw_uploads (filename, storage_path, settlement_month, status)
  values (
    'processing-run-legacy.csv',
    'uploads/2998-01/processing-run-legacy.csv',
    date '2998-01-01',
    'uploaded'
  ) returning id into v_legacy_upload_id;
  insert into public.settlement_jobs (month, progress_total, created_at)
  values (date '2998-01-01', 1, timestamptz '1900-01-01 00:00:00+00')
  returning id into v_legacy_job_id;
  insert into public.settlement_job_files (job_id, upload_id, position)
  values (v_legacy_job_id, v_legacy_upload_id, 0);

  select * into v_run_1
  from public.claim_settlement_version_job('processing-worker-1', 60);
  if v_run_1.job_id is distinct from v_version_job_id
     or v_run_1.source_version_id is distinct from v_version.id
     or v_run_1.attempt_no <> 1
     or v_run_1.parser_version <> 'parser-contract-v1'
     or v_run_1.rule_version <> 'rule-contract-v1'
     or v_run_1.status <> 'claimed'
     or v_run_1.claim_token is null
  then
    raise exception 'CONTRACT FAIL: initial version claim/run identity is wrong';
  end if;

  select * into v_job from public.settlement_jobs where id = v_version_job_id;
  if v_job.claim_token is distinct from v_run_1.claim_token
     or v_job.worker_id <> v_run_1.worker_id
     or v_job.attempt_count <> v_run_1.attempt_no
     or v_job.lease_expires_at is distinct from v_run_1.lease_expires_at
  then
    raise exception 'CONTRACT FAIL: job and run claim fences differ';
  end if;
  if (select status from public.settlement_jobs where id = v_legacy_job_id) <> 'queued' then
    raise exception 'CONTRACT FAIL: version claim touched a legacy job';
  end if;

  -- The legacy claim remains present and still excludes the version contract.
  select * into v_legacy_claim
  from public.claim_settlement_job('legacy-contract-worker', 60);
  if v_legacy_claim.id is distinct from v_legacy_job_id
     or v_legacy_claim.source_version_id is not null
  then
    raise exception 'CONTRACT FAIL: legacy claim contract changed or accepted a version job';
  end if;

  -- Every exact fence component is required before either row changes.
  select updated_at into v_before_updated_at
  from public.settlement_processing_runs where id = v_run_1.id;
  if public.heartbeat_settlement_processing_run(
       v_version_job_id, v_run_1.id, 'wrong-worker', v_run_1.claim_token, 60
     )
     or public.mark_settlement_processing_run_snapshot_ready(
       v_version_job_id, pg_catalog.gen_random_uuid(), v_run_1.worker_id, v_run_1.claim_token,
       pg_catalog.repeat('d', 64), 1, 12
     )
     or public.fail_settlement_processing_run(
       pg_catalog.gen_random_uuid(), v_run_1.id, v_run_1.worker_id, v_run_1.claim_token, 'wrong job'
     )
     or public.release_settlement_processing_run(
       v_version_job_id, v_run_1.id, v_run_1.worker_id, pg_catalog.gen_random_uuid()
     )
  then
    raise exception 'CONTRACT FAIL: an inexact job/run/worker/token fence mutated state';
  end if;
  if (select updated_at from public.settlement_processing_runs where id = v_run_1.id)
       is distinct from v_before_updated_at then
    raise exception 'CONTRACT FAIL: rejected fence changed the run';
  end if;

  if not public.heartbeat_settlement_processing_run(
    v_version_job_id, v_run_1.id, v_run_1.worker_id, v_run_1.claim_token, 60
  ) then
    raise exception 'CONTRACT FAIL: valid heartbeat was rejected';
  end if;
  if (select status from public.settlement_processing_runs where id = v_run_1.id)
       <> 'snapshotting' then
    raise exception 'CONTRACT FAIL: heartbeat did not enter snapshotting';
  end if;
  if not public.mark_settlement_processing_run_snapshot_ready(
    v_version_job_id, v_run_1.id, v_run_1.worker_id, v_run_1.claim_token,
    pg_catalog.repeat('d', 64), 1, 12
  ) then
    raise exception 'CONTRACT FAIL: valid snapshot-ready transition was rejected';
  end if;
  if (select snapshot_manifest_sha256 from public.settlement_processing_runs where id = v_run_1.id)
       <> pg_catalog.repeat('d', 64)
     or (select snapshot_file_count from public.settlement_processing_runs where id = v_run_1.id) <> 1
     or (select snapshot_total_bytes from public.settlement_processing_runs where id = v_run_1.id) <> 12
  then
    raise exception 'CONTRACT FAIL: snapshot evidence was not frozen';
  end if;
  if public.mark_settlement_processing_run_snapshot_ready(
    v_version_job_id, v_run_1.id, v_run_1.worker_id, v_run_1.claim_token,
    pg_catalog.repeat('e', 64), 1, 12
  ) then
    raise exception 'CONTRACT FAIL: different snapshot evidence overwrote a ready run';
  end if;

  -- Expire both halves of the lease. No fenced mutator may revive or
  -- terminalize the attempt with the now-expired token.
  update public.settlement_jobs
     set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
   where id = v_version_job_id;
  update public.settlement_processing_runs
     set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
   where id = v_run_1.id;
  select updated_at into v_before_updated_at
  from public.settlement_processing_runs where id = v_run_1.id;

  if public.heartbeat_settlement_processing_run(
       v_version_job_id, v_run_1.id, v_run_1.worker_id, v_run_1.claim_token, 60
     )
     or public.mark_settlement_processing_run_snapshot_ready(
       v_version_job_id, v_run_1.id, v_run_1.worker_id, v_run_1.claim_token,
       pg_catalog.repeat('d', 64), 1, 12
     )
     or public.fail_settlement_processing_run(
       v_version_job_id, v_run_1.id, v_run_1.worker_id, v_run_1.claim_token, 'expired'
     )
     or public.release_settlement_processing_run(
       v_version_job_id, v_run_1.id, v_run_1.worker_id, v_run_1.claim_token
     )
  then
    raise exception 'CONTRACT FAIL: an expired token mutated state';
  end if;
  if (select updated_at from public.settlement_processing_runs where id = v_run_1.id)
       is distinct from v_before_updated_at
     or (select status from public.settlement_processing_runs where id = v_run_1.id)
       <> 'snapshot_ready'
  then
    raise exception 'CONTRACT FAIL: expired-token rejection changed run evidence';
  end if;

  -- Reclaim rotates the token, releases the old nonterminal run, increments
  -- the attempt exactly once, and creates a new immutable run.
  select * into v_run_2
  from public.claim_settlement_version_job('processing-worker-2', 60);
  if v_run_2.job_id is distinct from v_version_job_id
     or v_run_2.id = v_run_1.id
     or v_run_2.claim_token = v_run_1.claim_token
     or v_run_2.attempt_no <> v_run_1.attempt_no + 1
  then
    raise exception 'CONTRACT FAIL: reclaim did not rotate token/run/attempt';
  end if;
  if (select status from public.settlement_processing_runs where id = v_run_1.id)
       <> 'released'
     or (select terminal_at from public.settlement_processing_runs where id = v_run_1.id)
       is null
  then
    raise exception 'CONTRACT FAIL: reclaim did not terminalize the expired run';
  end if;
  if public.heartbeat_settlement_processing_run(
    v_version_job_id, v_run_1.id, v_run_1.worker_id, v_run_1.claim_token, 60
  ) then
    raise exception 'CONTRACT FAIL: stale superseded token remained usable';
  end if;

  -- Cooperative release queues the logical job; its next claim is a third
  -- distinct attempt, not a reuse of the released run.
  if not public.release_settlement_processing_run(
    v_version_job_id, v_run_2.id, v_run_2.worker_id, v_run_2.claim_token
  ) then
    raise exception 'CONTRACT FAIL: valid release was rejected';
  end if;
  select * into v_run_3
  from public.claim_settlement_version_job('processing-worker-3', 60);
  if v_run_3.job_id is distinct from v_version_job_id
     or v_run_3.attempt_no <> 3
     or v_run_3.claim_token in (v_run_1.claim_token, v_run_2.claim_token)
  then
    raise exception 'CONTRACT FAIL: released job did not create a new attempt';
  end if;
  if not public.fail_settlement_processing_run(
    v_version_job_id, v_run_3.id, v_run_3.worker_id, v_run_3.claim_token, 'expected contract failure'
  ) then
    raise exception 'CONTRACT FAIL: valid failure transition was rejected';
  end if;

  -- Direct identity rewrite and deletion remain impossible even to the test
  -- owner; normal service_role DML is separately denied below.
  begin
    update public.settlement_processing_runs
       set attempt_no = attempt_no + 10
     where id = v_run_1.id;
    raise exception 'CONTRACT FAIL: processing-run identity was mutable';
  exception when others then
    if sqlerrm like 'CONTRACT FAIL:%' then raise; end if;
  end;
  begin
    delete from public.settlement_processing_runs where id = v_run_1.id;
    raise exception 'CONTRACT FAIL: processing-run evidence was deletable';
  exception when others then
    if sqlerrm like 'CONTRACT FAIL:%' then raise; end if;
  end;

  -- Role metadata: only service_role can invoke the new RPCs and it receives
  -- SELECT-only direct table access.
  if not pg_catalog.has_table_privilege(
       'service_role', 'public.settlement_processing_runs', 'select'
     )
     or pg_catalog.has_table_privilege(
       'service_role', 'public.settlement_processing_runs', 'insert,update,delete'
     )
     or pg_catalog.has_table_privilege(
       'anon', 'public.settlement_processing_runs', 'select'
     )
     or pg_catalog.has_table_privilege(
       'authenticated', 'public.settlement_processing_runs', 'select'
     )
  then
    raise exception 'CONTRACT FAIL: processing-run table privileges are wrong';
  end if;

  if not pg_catalog.has_function_privilege(
       'service_role', 'public.claim_settlement_version_job(text,integer)', 'execute'
     )
     or pg_catalog.has_function_privilege(
       'anon', 'public.claim_settlement_version_job(text,integer)', 'execute'
     )
     or pg_catalog.has_function_privilege(
       'authenticated', 'public.claim_settlement_version_job(text,integer)', 'execute'
     )
  then
    raise exception 'CONTRACT FAIL: version claim RPC privileges are wrong';
  end if;

  raise notice 'settlement processing-run runtime contract: all checks passed';
end;
$contract$;

-- Restore a pristine post-031 schema before executing the documented rollback.
rollback to savepoint runtime_contract;

-- Invocation and direct-DML denial are exercised as the actual roles, not
-- only inferred from has_*_privilege metadata.
set local role anon;
do $anon_denial$
begin
  begin
    perform * from public.claim_settlement_version_job('anon-must-fail', 60);
    raise exception 'CONTRACT FAIL: anon executed version claim';
  exception when insufficient_privilege then
    null;
  end;
end;
$anon_denial$;
reset role;

set local role authenticated;
do $authenticated_denial$
begin
  begin
    perform * from public.claim_settlement_version_job('authenticated-must-fail', 60);
    raise exception 'CONTRACT FAIL: authenticated executed version claim';
  exception when insufficient_privilege then
    null;
  end;
end;
$authenticated_denial$;
reset role;

set local role service_role;
do $service_dml_denial$
begin
  begin
    update public.settlement_processing_runs
       set updated_at = pg_catalog.clock_timestamp()
     where false;
    raise exception 'CONTRACT FAIL: service_role received direct run UPDATE';
  exception when insufficient_privilege then
    null;
  end;
end;
$service_dml_denial$;
reset role;

-- Execute migration 031's documented rollback recipe inside the outer test
-- transaction. The outer ROLLBACK below restores every dropped object.
do $rollback_guard$
begin
  if exists (select 1 from public.settlement_processing_runs) then
    raise exception 'CONTRACT FAIL: runtime fixture rollback left run evidence';
  end if;
end;
$rollback_guard$;

drop function public.release_settlement_processing_run(uuid, uuid, text, uuid);
drop function public.fail_settlement_processing_run(uuid, uuid, text, uuid, text);
drop function public.mark_settlement_processing_run_snapshot_ready(uuid, uuid, text, uuid, text, integer, bigint);
drop function public.heartbeat_settlement_processing_run(uuid, uuid, text, uuid, integer);
drop function public.claim_settlement_version_job(text, integer);
drop trigger trg_settlement_processing_runs_identity on public.settlement_processing_runs;
drop function public.settlement_processing_runs_identity_guard();
drop table public.settlement_processing_runs;
drop index public.idx_settlement_jobs_version_claim;

do $rollback_contract$
declare
  v_changed integer;
begin
  if pg_catalog.to_regclass('public.settlement_processing_runs') is not null
     or pg_catalog.to_regclass('public.idx_settlement_jobs_version_claim') is not null
     or pg_catalog.to_regprocedure(
       'public.claim_settlement_version_job(text,integer)'
     ) is not null
  then
    raise exception 'CONTRACT FAIL: documented 031 rollback left schema objects';
  end if;

  select count(*) into v_changed
  from legacy_rpc_before b
  where pg_catalog.to_regprocedure(b.signature) is null
     or pg_catalog.pg_get_functiondef(
       pg_catalog.to_regprocedure(b.signature)
     ) is distinct from b.definition;
  if v_changed <> 0 or (select count(*) from legacy_rpc_before) <> 4 then
    raise exception 'CONTRACT FAIL: migration/rollback changed a legacy RPC';
  end if;

  raise notice 'settlement processing-run rollback contract: all checks passed';
end;
$rollback_contract$;

rollback;
