-- Live smoke for migration 032. Runs in one transaction and always rolls back.
\set ON_ERROR_STOP on
begin;

create temporary table lifecycle_before on commit drop as
select p.oid::regprocedure::text signature, pg_catalog.pg_get_functiondef(p.oid) definition
from pg_catalog.pg_proc p where p.oid = any(array[
  'public.claim_settlement_version_job(text,integer)'::regprocedure,
  'public.heartbeat_settlement_processing_run(uuid,uuid,text,uuid,integer)'::regprocedure,
  'public.fail_settlement_processing_run(uuid,uuid,text,uuid,text)'::regprocedure,
  'public.release_settlement_processing_run(uuid,uuid,text,uuid)'::regprocedure
]);

savepoint runtime_contract;
do $contract$
declare
  v_actor constant text := 'artifact-contract-check';
  v_sha constant char(64) := pg_catalog.repeat('c', 64);
  v_intake public.settlement_intake_months;
  v_object public.settlement_intake_objects;
  v_version public.settlement_intake_versions;
  v_run public.settlement_processing_runs;
  v_job_id uuid;
begin
  v_intake := public.create_settlement_intake('299802', v_actor);
  v_object := public.register_settlement_intake_object(v_intake.id, 'artifact/source.csv', 'source.csv', 'text/csv', 12, v_sha, v_actor, v_intake.draft_revision, null);
  v_object := public.finalize_settlement_intake_object(v_object.id, 12, v_sha, v_actor);
  perform public.upsert_settlement_intake_draft_entry(v_intake.id, v_object.id, v_intake.draft_revision, v_actor);
  select * into v_intake from public.settlement_intake_months where id = v_intake.id;
  v_version := public.submit_settlement_intake_version(v_intake.id, v_intake.draft_revision, v_actor);
  v_job_id := public.enqueue_settlement_version_job(v_version.id, v_actor, 'parser-v1', 'rule-v1');
  select * into v_run from public.claim_settlement_version_job('artifact-worker', 60);
  perform public.heartbeat_settlement_processing_run(v_job_id, v_run.id, v_run.worker_id, v_run.claim_token, 60);

  if public.mark_settlement_processing_run_stage_ready(v_job_id, v_run.id, v_run.worker_id, v_run.claim_token, pg_catalog.repeat('d',64), 100, 1, 1, 1) then
    raise exception 'CONTRACT FAIL: stage evidence accepted before snapshot-ready';
  end if;
  if not public.mark_settlement_processing_run_snapshot_ready(v_job_id, v_run.id, v_run.worker_id, v_run.claim_token, pg_catalog.repeat('e',64), 1, 12) then
    raise exception 'CONTRACT FAIL: snapshot-ready failed';
  end if;
  if public.mark_settlement_processing_run_stage_ready(v_job_id, v_run.id, 'wrong-worker', v_run.claim_token, pg_catalog.repeat('d',64), 100, 1, 1, 1) then
    raise exception 'CONTRACT FAIL: wrong worker wrote stage evidence';
  end if;
  if public.mark_settlement_processing_run_stage_ready(v_job_id, v_run.id, v_run.worker_id, pg_catalog.gen_random_uuid(), pg_catalog.repeat('d',64), 100, 1, 1, 1) then
    raise exception 'CONTRACT FAIL: wrong claim token wrote stage evidence';
  end if;
  update public.settlement_jobs set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second' where id = v_job_id;
  if public.mark_settlement_processing_run_stage_ready(v_job_id, v_run.id, v_run.worker_id, v_run.claim_token, pg_catalog.repeat('d',64), 100, 1, 1, 1) then
    raise exception 'CONTRACT FAIL: expired job lease wrote stage evidence';
  end if;
  update public.settlement_jobs set lease_expires_at = pg_catalog.clock_timestamp() + interval '60 seconds' where id = v_job_id;
  update public.settlement_processing_runs set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second' where id = v_run.id;
  if public.mark_settlement_processing_run_stage_ready(v_job_id, v_run.id, v_run.worker_id, v_run.claim_token, pg_catalog.repeat('d',64), 100, 1, 1, 1) then
    raise exception 'CONTRACT FAIL: expired run lease wrote stage evidence';
  end if;
  update public.settlement_processing_runs set lease_expires_at = pg_catalog.clock_timestamp() + interval '60 seconds' where id = v_run.id;
  if not public.mark_settlement_processing_run_stage_ready(v_job_id, v_run.id, v_run.worker_id, v_run.claim_token, pg_catalog.repeat('d',64), 100, 1, 1, 1)
     or not public.mark_settlement_processing_run_stage_ready(v_job_id, v_run.id, v_run.worker_id, v_run.claim_token, pg_catalog.repeat('d',64), 100, 1, 1, 1) then
    raise exception 'CONTRACT FAIL: stage evidence or identical replay failed';
  end if;
  if public.mark_settlement_processing_run_stage_ready(v_job_id, v_run.id, v_run.worker_id, v_run.claim_token, pg_catalog.repeat('f',64), 100, 1, 1, 1) then
    raise exception 'CONTRACT FAIL: conflicting stage evidence overwrote immutable values';
  end if;
  if not public.mark_settlement_processing_run_workbook_ready(v_job_id, v_run.id, v_run.worker_id, v_run.claim_token, pg_catalog.repeat('1',64), pg_catalog.repeat('2',64), 200, 1, 3, 'libreoffice', 'LibreOffice test', pg_catalog.repeat('3',64), 1, 3)
     or not public.mark_settlement_processing_run_workbook_ready(v_job_id, v_run.id, v_run.worker_id, v_run.claim_token, pg_catalog.repeat('1',64), pg_catalog.repeat('2',64), 200, 1, 3, 'libreoffice', 'LibreOffice test', pg_catalog.repeat('3',64), 1, 3) then
    raise exception 'CONTRACT FAIL: workbook evidence or identical replay failed';
  end if;
  if public.mark_settlement_processing_run_workbook_ready(v_job_id, v_run.id, v_run.worker_id, v_run.claim_token, pg_catalog.repeat('4',64), pg_catalog.repeat('2',64), 200, 1, 3, 'libreoffice', 'LibreOffice test', pg_catalog.repeat('3',64), 1, 3) then
    raise exception 'CONTRACT FAIL: conflicting workbook evidence overwrote immutable values';
  end if;
  begin
    update public.settlement_processing_runs set stage_sha256 = null where id = v_run.id;
    raise exception 'CONTRACT FAIL: partial-null stage evidence passed CHECK';
  exception when check_violation then null; end;
  begin
    update public.settlement_processing_runs set office_version = null where id = v_run.id;
    raise exception 'CONTRACT FAIL: partial-null workbook evidence passed CHECK';
  exception when check_violation then null; end;

  update public.settlement_jobs set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second' where id = v_job_id;
  update public.settlement_processing_runs set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second' where id = v_run.id;
  if public.mark_settlement_processing_run_workbook_ready(v_job_id, v_run.id, v_run.worker_id, v_run.claim_token, pg_catalog.repeat('1',64), pg_catalog.repeat('2',64), 200, 1, 3, 'libreoffice', 'LibreOffice test', pg_catalog.repeat('3',64), 1, 3) then
    raise exception 'CONTRACT FAIL: expired lease wrote workbook evidence';
  end if;
end;
$contract$;
rollback to savepoint runtime_contract;

set local role anon;
do $$ begin
  begin
    perform public.mark_settlement_processing_run_stage_ready(pg_catalog.gen_random_uuid(), pg_catalog.gen_random_uuid(), 'x', pg_catalog.gen_random_uuid(), pg_catalog.repeat('a',64), 1, 1, 1, 1);
    raise exception 'CONTRACT FAIL: anon executed stage RPC';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role authenticated;
do $$ begin
  begin
    perform public.mark_settlement_processing_run_workbook_ready(pg_catalog.gen_random_uuid(), pg_catalog.gen_random_uuid(), 'x', pg_catalog.gen_random_uuid(), pg_catalog.repeat('1',64), pg_catalog.repeat('2',64), 1, 1, 1, 'libreoffice', 'v', pg_catalog.repeat('3',64), 1, 1);
    raise exception 'CONTRACT FAIL: authenticated executed workbook RPC';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

do $$
declare v_changed integer; begin
  select count(*) into v_changed from lifecycle_before b
  where pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(b.signature)) is distinct from b.definition;
  if v_changed <> 0 or (select count(*) from lifecycle_before) <> 4 then
    raise exception 'CONTRACT FAIL: migration 032 changed lifecycle functions';
  end if;
end $$;

rollback;
