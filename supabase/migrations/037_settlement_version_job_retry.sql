-- 037_settlement_version_job_retry.sql
-- Requeue one terminal immutable-version job so the existing claim path creates
-- a fresh fenced processing attempt. Source/version/file bindings never change.

begin;

create function public.retry_settlement_version_job(
  p_source_version_id uuid,
  p_actor text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.settlement_jobs;
  v_version public.settlement_intake_versions;
  v_now timestamptz;
begin
  if p_source_version_id is null
     or p_actor is null
     or pg_catalog.length(pg_catalog.btrim(p_actor)) not between 1 and 200
     or p_actor ~ '[[:cntrl:]]'
  then
    raise exception 'invalid retry request';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement_version_job:' || p_source_version_id::text, 0));

  select * into v_version
  from public.settlement_intake_versions v
  where v.id = p_source_version_id;
  if not found then
    raise exception 'unknown settlement intake version %', p_source_version_id;
  end if;

  select * into v_job
  from public.settlement_jobs j
  where j.source_version_id = p_source_version_id
  for update of j;
  if not found then
    raise exception 'settlement version job is unavailable';
  end if;
  if v_job.status not in ('completed','completed_with_warnings','failed') then
    raise exception 'settlement version job is not terminal';
  end if;
  if v_job.attempt_count >= 1000000 then
    raise exception 'settlement version job attempt limit reached';
  end if;
  if exists (
    select 1 from public.settlement_processing_runs r
    where r.job_id = v_job.id
      and r.status in ('claimed','snapshotting','snapshot_ready')
  ) then
    raise exception 'settlement version job has an active run';
  end if;

  v_now := pg_catalog.clock_timestamp();
  update public.settlement_jobs j set
    status = 'queued',
    stage = 'queued',
    progress_current = 0,
    worker_id = null,
    claim_token = null,
    lease_expires_at = null,
    heartbeat_at = v_now,
    error_summary = null,
    result_summary = null,
    artifact_storage_path = null,
    workbook_sheet_count = null,
    workbook_row_count = null,
    started_at = null,
    completed_at = null,
    updated_at = v_now
  where j.id = v_job.id;

  update public.settlement_job_files f set
    status = 'queued',
    parsed_rows = null,
    sales_records_written = null,
    sales_records_skipped_duplicates = null,
    result_summary = null,
    error_summary = null,
    started_at = null,
    completed_at = null,
    updated_at = v_now
  where f.job_id = v_job.id;

  insert into public.settlement_intake_audit (intake_id, actor, action, detail)
  values (
    v_version.intake_id,
    pg_catalog.btrim(p_actor),
    'version_job_retry_requested',
    pg_catalog.jsonb_build_object(
      'job_id', v_job.id,
      'source_version_id', p_source_version_id,
      'previous_attempt_count', v_job.attempt_count
    )
  );

  return v_job.id;
end;
$$;

revoke all on function public.retry_settlement_version_job(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.retry_settlement_version_job(uuid,text)
  to service_role;

commit;
