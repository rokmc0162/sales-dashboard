-- Live semantic smoke for migration 035. Runs in one transaction and rolls back.
\set ON_ERROR_STOP on
begin;

do $contract$
declare
  v_actor constant text := 'local-sync-contract';
  v_source_sha constant char(64) := pg_catalog.repeat('a',64);
  v_workbook_sha constant char(64) := pg_catalog.repeat('b',64);
  v_evidence_sha constant text := pg_catalog.repeat('c',64);
  v_intake public.settlement_intake_months;
  v_object public.settlement_intake_objects;
  v_version public.settlement_intake_versions;
  v_file public.settlement_intake_version_files;
  v_run public.settlement_processing_runs;
  v_job_id uuid;
  v_manifest text;
  v_files jsonb;
  v_path text;
  v_ok boolean;
begin
  v_intake := public.create_settlement_intake('299805',v_actor);
  v_object := public.register_settlement_intake_object(
    v_intake.id,'folder/source.csv','folder/source.csv','text/csv',12,
    v_source_sha,v_actor,v_intake.draft_revision,null);
  v_object := public.finalize_settlement_intake_object(v_object.id,12,v_source_sha,v_actor);
  perform public.upsert_settlement_intake_draft_entry(v_intake.id,v_object.id,v_intake.draft_revision,v_actor);
  select * into v_intake from public.settlement_intake_months where id=v_intake.id;
  v_version := public.submit_settlement_intake_version(v_intake.id,v_intake.draft_revision,v_actor);
  select * into v_file from public.settlement_intake_version_files where version_id=v_version.id;
  v_job_id := public.enqueue_settlement_version_job(v_version.id,v_actor,'parser-v1','rule-v1');
  select * into v_run from public.claim_settlement_version_job('local-sync-worker',120);
  if not public.mark_settlement_processing_run_snapshot_ready(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_version.manifest_sha256,1,12)
  or not public.mark_settlement_processing_run_stage_ready(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,pg_catalog.repeat('d',64),100,1,1,1)
  or not public.mark_settlement_processing_run_workbook_ready(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,
    v_workbook_sha,pg_catalog.repeat('e',64),200,1,3,
    'libreoffice','LibreOffice contract',pg_catalog.repeat('f',64),1,3)
  then raise exception 'CONTRACT FAIL: run evidence setup failed'; end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'position',f.position,'object_id',f.object_id,'path_key',f.path_key,
    'display_name',f.display_name,'size_bytes',f.size_bytes,
    'sha256',f.sha256,'storage_path',f.storage_path) order by f.position)::text
    into v_manifest from public.settlement_intake_version_files f where f.version_id=v_version.id;
  v_path := '2998-05/v001-'||v_version.id::text||'/run-'||v_run.id::text;
  v_files := pg_catalog.jsonb_build_array(
    pg_catalog.jsonb_build_object('relativePath','manifest.json','sha256',v_version.manifest_sha256,'sizeBytes',pg_catalog.octet_length(pg_catalog.convert_to(v_manifest,'UTF8'))),
    pg_catalog.jsonb_build_object('relativePath','원본/'||v_file.display_name,'sha256',v_file.sha256,'sizeBytes',v_file.size_bytes),
    pg_catalog.jsonb_build_object('relativePath','결과/office-verified.xlsx','sha256',v_workbook_sha,'sizeBytes',200),
    pg_catalog.jsonb_build_object('relativePath','결과/evidence.json','sha256',pg_catalog.repeat('9',64),'sizeBytes',10)
  );

  v_ok := public.verify_settlement_local_sync_archive(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_path,v_evidence_sha,v_files);
  if not v_ok then raise exception 'CONTRACT FAIL: exact local archive rejected'; end if;
  if (select count(*) from public.settlement_drive_backups
      where source_version_id=v_version.id and status='verified' and transport_kind='local_sync') <> 3 then
    raise exception 'CONTRACT FAIL: manifest/source/workbook evidence rows missing';
  end if;
  if exists(select 1 from public.settlement_drive_backups
      where source_version_id=v_version.id and (drive_parent_id is not null or drive_file_id is not null)) then
    raise exception 'CONTRACT FAIL: local evidence fabricated Drive identifiers';
  end if;
  if not public.verify_settlement_local_sync_archive(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_path,v_evidence_sha,v_files) then
    raise exception 'CONTRACT FAIL: exact replay rejected';
  end if;
  if public.verify_settlement_local_sync_archive(
    v_job_id,v_run.id,v_run.worker_id,v_run.claim_token,v_path,pg_catalog.repeat('8',64),
    pg_catalog.jsonb_set(v_files,'{1,sha256}',pg_catalog.to_jsonb(pg_catalog.repeat('0',64)))) then
    raise exception 'CONTRACT FAIL: bad source hash accepted';
  end if;
  if public.verify_settlement_local_sync_archive(
    v_job_id,v_run.id,'wrong-worker',v_run.claim_token,v_path,v_evidence_sha,v_files) then
    raise exception 'CONTRACT FAIL: wrong worker accepted';
  end if;
end;
$contract$;

set local role anon;
do $$ begin
  begin
    perform public.verify_settlement_local_sync_archive(
      pg_catalog.gen_random_uuid(),pg_catalog.gen_random_uuid(),'x',pg_catalog.gen_random_uuid(),
      '2998-05/v001-00000000-0000-4000-8000-000000000001/run-00000000-0000-4000-8000-000000000002',
      pg_catalog.repeat('a',64),'[]'::jsonb);
    raise exception 'CONTRACT FAIL: anon executed local-sync RPC';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

rollback;
