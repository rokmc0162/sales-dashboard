-- Fix PostgreSQL ARE repetition limit in the worker artifact path guard.
-- PostgreSQL rejects large repetition bounds at evaluation time; enforce length separately.

alter table settlement_jobs
  drop constraint if exists settlement_jobs_artifact_storage_path_check;

alter table settlement_jobs
  add constraint settlement_jobs_artifact_storage_path_check
  check (
    artifact_storage_path is null
    or (
      length(artifact_storage_path) between 1 and 500
      and artifact_storage_path ~ '^[A-Za-z0-9/._-]+$'
    )
  );

create or replace function finish_settlement_job(
  p_job_id uuid,
  p_worker_id text,
  p_status text,
  p_error_summary text default null,
  p_result_summary text default null,
  p_artifact_storage_path text default null,
  p_workbook_sheet_count integer default null,
  p_workbook_row_count integer default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  if p_status not in ('completed','completed_with_warnings','failed') then
    return false;
  end if;
  if p_artifact_storage_path is not null and (
    length(p_artifact_storage_path) < 1
    or length(p_artifact_storage_path) > 500
    or p_artifact_storage_path !~ '^[A-Za-z0-9/._-]+$'
  ) then
    return false;
  end if;
  update settlement_jobs
  set status = p_status,
      stage = 'completed',
      progress_current = case when p_status = 'failed' then progress_current else progress_total end,
      error_summary = nullif(left(p_error_summary, 500), ''),
      result_summary = nullif(left(p_result_summary, 500), ''),
      artifact_storage_path = p_artifact_storage_path,
      workbook_sheet_count = p_workbook_sheet_count,
      workbook_row_count = p_workbook_row_count,
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = clock_timestamp(),
      updated_at = clock_timestamp(),
      completed_at = clock_timestamp()
  where id = p_job_id
    and worker_id = p_worker_id
    and status in ('claimed','processing')
    and lease_expires_at >= clock_timestamp();
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function finish_settlement_job(uuid, text, text, text, text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function finish_settlement_job(uuid, text, text, text, text, text, integer, integer)
  to service_role;
