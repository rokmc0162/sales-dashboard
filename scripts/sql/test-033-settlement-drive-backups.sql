-- Live semantic smoke for migration 033. Runs in one transaction and rolls back.
\set ON_ERROR_STOP on
begin;

create temporary table lifecycle_before on commit drop as
select p.oid::regprocedure::text signature, pg_catalog.pg_get_functiondef(p.oid) definition
from pg_catalog.pg_proc p where p.oid = any(array[
  'public.claim_settlement_version_job(text,integer)'::regprocedure,
  'public.heartbeat_settlement_processing_run(uuid,uuid,text,uuid,integer)'::regprocedure,
  'public.mark_settlement_processing_run_snapshot_ready(uuid,uuid,text,uuid,text,integer,bigint)'::regprocedure,
  'public.mark_settlement_processing_run_stage_ready(uuid,uuid,text,uuid,text,bigint,integer,integer,integer)'::regprocedure,
  'public.mark_settlement_processing_run_workbook_ready(uuid,uuid,text,uuid,text,text,bigint,integer,integer,text,text,text,integer,integer)'::regprocedure,
  'public.fail_settlement_processing_run(uuid,uuid,text,uuid,text)'::regprocedure,
  'public.release_settlement_processing_run(uuid,uuid,text,uuid)'::regprocedure
]);

savepoint runtime_contract;
do $contract$
declare
  v_actor constant text := 'drive-backup-contract';
  v_sha constant char(64) := pg_catalog.repeat('a', 64);
  v_workbook_sha constant char(64) := pg_catalog.repeat('b', 64);
  v_parent constant text := 'drive_parent_contract';
  v_intake public.settlement_intake_months;
  v_object public.settlement_intake_objects;
  v_version public.settlement_intake_versions;
  v_version_file public.settlement_intake_version_files;
  v_run public.settlement_processing_runs;
  v_job_id uuid;
  v_attempt uuid := pg_catalog.gen_random_uuid();
  v_other_attempt uuid := pg_catalog.gen_random_uuid();
  v_manifest_backup public.settlement_drive_backups;
  v_manifest_replay public.settlement_drive_backups;
  v_file_backup public.settlement_drive_backups;
  v_workbook_backup public.settlement_drive_backups;
  v_retry_at timestamptz;
  v_attempt_count integer;
  v_other_intake public.settlement_intake_months;
  v_other_object public.settlement_intake_objects;
  v_other_version public.settlement_intake_versions;
  v_other_file public.settlement_intake_version_files;
begin
  v_intake := public.create_settlement_intake('299803', v_actor);
  v_object := public.register_settlement_intake_object(
    v_intake.id, 'drive/source.csv', 'source.csv', 'text/csv', 12,
    v_sha, v_actor, v_intake.draft_revision, null);
  v_object := public.finalize_settlement_intake_object(v_object.id, 12, v_sha, v_actor);
  perform public.upsert_settlement_intake_draft_entry(
    v_intake.id, v_object.id, v_intake.draft_revision, v_actor);
  select * into v_intake from public.settlement_intake_months where id=v_intake.id;
  v_version := public.submit_settlement_intake_version(v_intake.id, v_intake.draft_revision, v_actor);
  select * into v_version_file from public.settlement_intake_version_files
   where version_id=v_version.id;
  v_job_id := public.enqueue_settlement_version_job(v_version.id, v_actor, 'parser-v1', 'rule-v1');
  select * into v_run from public.claim_settlement_version_job('drive-worker-1', 120);
  perform public.heartbeat_settlement_processing_run(v_job_id, v_run.id, v_run.worker_id, v_run.claim_token, 120);
  if not public.mark_settlement_processing_run_snapshot_ready(
    v_job_id, v_run.id, v_run.worker_id, v_run.claim_token,
    v_version.manifest_sha256, 1, 12) then
    raise exception 'CONTRACT FAIL: snapshot-ready failed';
  end if;
  if not public.mark_settlement_processing_run_stage_ready(
    v_job_id, v_run.id, v_run.worker_id, v_run.claim_token,
    pg_catalog.repeat('c',64), 100, 1, 1, 1) then
    raise exception 'CONTRACT FAIL: stage-ready failed';
  end if;
  if not public.mark_settlement_processing_run_workbook_ready(
    v_job_id, v_run.id, v_run.worker_id, v_run.claim_token,
    v_workbook_sha, pg_catalog.repeat('d',64), 200, 1, 3,
    'libreoffice', 'LibreOffice contract', pg_catalog.repeat('e',64), 1, 3) then
    raise exception 'CONTRACT FAIL: workbook-ready failed';
  end if;

  select * into v_manifest_backup from public.begin_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_attempt,
    'source_manifest',null,v_parent);
  if v_manifest_backup.id is null
     or v_manifest_backup.backup_identity <> 'svm:'||v_version.id::text
     or v_manifest_backup.content_sha256 <> v_version.manifest_sha256
     or v_manifest_backup.size_bytes < 1 or v_manifest_backup.attempt_count <> 1 then
    raise exception 'CONTRACT FAIL: manifest reservation is not DB-derived';
  end if;

  select * into v_manifest_replay from public.begin_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_attempt,
    'source_manifest',null,v_parent);
  if v_manifest_replay.id is distinct from v_manifest_backup.id
     or v_manifest_replay.attempt_count <> 1 then
    raise exception 'CONTRACT FAIL: identical begin replay did not converge';
  end if;
  if exists(select 1 from public.begin_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_other_attempt,
    'source_manifest',null,v_parent)) then
    raise exception 'CONTRACT FAIL: same claim changed attempt token';
  end if;
  if exists(select 1 from public.begin_settlement_drive_backup(
    v_job_id,v_run.id,'wrong-worker',v_run.claim_token,v_attempt,
    'source_manifest',null,v_parent))
     or exists(select 1 from public.begin_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,pg_catalog.gen_random_uuid(),v_attempt,
    'source_manifest',null,v_parent)) then
    raise exception 'CONTRACT FAIL: worker/token fence failed';
  end if;

  select * into v_file_backup from public.begin_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,pg_catalog.gen_random_uuid(),
    'source_file',v_version_file.id,v_parent);
  if v_file_backup.content_sha256 <> v_version_file.sha256
     or v_file_backup.size_bytes <> v_version_file.size_bytes
     or v_file_backup.backup_identity <> 'svf:'||v_version_file.id::text then
    raise exception 'CONTRACT FAIL: source-file evidence is not frozen-row-derived';
  end if;

  v_other_intake := public.create_settlement_intake('299804', v_actor);
  v_other_object := public.register_settlement_intake_object(
    v_other_intake.id,'other.csv','other.csv','text/csv',7,
    pg_catalog.repeat('f',64),v_actor,v_other_intake.draft_revision,null);
  v_other_object := public.finalize_settlement_intake_object(
    v_other_object.id,7,pg_catalog.repeat('f',64),v_actor);
  perform public.upsert_settlement_intake_draft_entry(
    v_other_intake.id,v_other_object.id,v_other_intake.draft_revision,v_actor);
  select * into v_other_intake from public.settlement_intake_months where id=v_other_intake.id;
  v_other_version := public.submit_settlement_intake_version(
    v_other_intake.id,v_other_intake.draft_revision,v_actor);
  select * into v_other_file from public.settlement_intake_version_files
   where version_id=v_other_version.id;
  if exists(select 1 from public.begin_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,pg_catalog.gen_random_uuid(),
    'source_file',v_other_file.id,v_parent)) then
    raise exception 'CONTRACT FAIL: cross-version source file accepted';
  end if;

  select * into v_workbook_backup from public.begin_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,pg_catalog.gen_random_uuid(),
    'verified_workbook',null,v_parent);
  if v_workbook_backup.content_sha256 <> v_workbook_sha
     or v_workbook_backup.size_bytes <> 200
     or v_workbook_backup.backup_identity <> 'run:'||v_run.id::text then
    raise exception 'CONTRACT FAIL: workbook evidence is not run-derived';
  end if;

  if public.retry_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_other_attempt,
    v_manifest_backup.id,'temporary',30) then
    raise exception 'CONTRACT FAIL: wrong attempt token retried backup';
  end if;
  if not public.retry_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_attempt,
    v_manifest_backup.id,'temporary',30) then
    raise exception 'CONTRACT FAIL: retry failed';
  end if;
  select next_retry_at into v_retry_at from public.settlement_drive_backups
   where id=v_manifest_backup.id;
  if not public.retry_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_attempt,
    v_manifest_backup.id,'temporary',30)
     or (select next_retry_at from public.settlement_drive_backups where id=v_manifest_backup.id)
        is distinct from v_retry_at then
    raise exception 'CONTRACT FAIL: retry replay changed deadline';
  end if;

  if public.verify_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_attempt,
    v_manifest_backup.id,'drive_manifest',pg_catalog.repeat('9',64),'1') then
    raise exception 'CONTRACT FAIL: wrong checksum verified';
  end if;
  if not public.verify_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_attempt,
    v_manifest_backup.id,'drive_manifest',v_manifest_backup.content_sha256,'1')
     or not public.verify_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_attempt,
    v_manifest_backup.id,'drive_manifest',v_manifest_backup.content_sha256,'1') then
    raise exception 'CONTRACT FAIL: verify or identical replay failed';
  end if;
  if public.verify_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_attempt,
    v_manifest_backup.id,'different_drive',v_manifest_backup.content_sha256,'1') then
    raise exception 'CONTRACT FAIL: conflicting Drive ID replay accepted';
  end if;
  if public.verify_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_file_backup.active_attempt_token,
    v_file_backup.id,'drive_manifest',v_file_backup.content_sha256,'1') then
    raise exception 'CONTRACT FAIL: Drive file ID reused across backups';
  end if;

  update public.settlement_jobs set lease_expires_at=pg_catalog.clock_timestamp()-interval '1 second'
   where id=v_job_id;
  if exists(select 1 from public.begin_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_file_backup.active_attempt_token,
    'source_file',v_version_file.id,v_parent)) then
    raise exception 'CONTRACT FAIL: expired job lease accepted begin';
  end if;
  update public.settlement_jobs set lease_expires_at=pg_catalog.clock_timestamp()+interval '120 seconds'
   where id=v_job_id;
  update public.settlement_processing_runs set lease_expires_at=pg_catalog.clock_timestamp()-interval '1 second'
   where id=v_run.id;
  if public.retry_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_file_backup.active_attempt_token,
    v_file_backup.id,'temporary',30) then
    raise exception 'CONTRACT FAIL: expired run lease accepted retry';
  end if;

  -- Reclaim proves source rows cross attempts while workbook rows remain run scoped.
  update public.settlement_jobs set lease_expires_at=pg_catalog.clock_timestamp()-interval '1 second'
   where id=v_job_id;
  update public.settlement_processing_runs set lease_expires_at=pg_catalog.clock_timestamp()-interval '1 second'
   where id=v_run.id;
  select attempt_count into v_attempt_count from public.settlement_drive_backups
   where id=v_file_backup.id;
  select * into v_run from public.claim_settlement_version_job('drive-worker-2',120);
  perform public.heartbeat_settlement_processing_run(v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,120);
  if not public.mark_settlement_processing_run_snapshot_ready(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_version.manifest_sha256,1,12) then
    raise exception 'CONTRACT FAIL: reclaimed snapshot-ready failed';
  end if;
  select * into v_file_backup from public.begin_settlement_drive_backup(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,pg_catalog.gen_random_uuid(),
    'source_file',v_version_file.id,v_parent);
  if v_file_backup.source_version_file_id is distinct from v_version_file.id
     or v_file_backup.active_run_id is distinct from v_run.id
     or v_file_backup.attempt_count <> v_attempt_count+1 then
    raise exception 'CONTRACT FAIL: rotated claim did not take over source backup';
  end if;
end;
$contract$;
rollback to savepoint runtime_contract;

set local role service_role;
do $$ begin
  begin
    insert into public.settlement_drive_backups(
      kind,source_version_id,backup_identity,content_sha256,size_bytes,
      drive_parent_id,status,attempt_count,active_run_id,active_claim_token,active_attempt_token
    ) values ('source_manifest',pg_catalog.gen_random_uuid(),
      'svm:'||pg_catalog.gen_random_uuid()::text,pg_catalog.repeat('a',64),1,
      'x','pending',1,pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid());
    raise exception 'CONTRACT FAIL: service_role inserted directly';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

set local role anon;
do $$ begin
  begin
    perform public.begin_settlement_drive_backup(
      pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),'x',pg_catalog.gen_random_uuid(),
      pg_catalog.gen_random_uuid(),'source_manifest',null,'x');
    raise exception 'CONTRACT FAIL: anon executed begin RPC';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

do $$
declare v_changed integer; begin
  select count(*) into v_changed from lifecycle_before b
  where pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(b.signature)) is distinct from b.definition;
  if v_changed <> 0 or (select count(*) from lifecycle_before) <> 7 then
    raise exception 'CONTRACT FAIL: migration 033 changed lifecycle functions';
  end if;
end $$;

rollback;
