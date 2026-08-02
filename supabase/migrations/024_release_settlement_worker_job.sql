-- Requeue a cooperatively interrupted worker job only at a safe file checkpoint.
-- The job row lock serializes this release with fenced worker file updates; the
-- second statement then observes any committed processing file before release.

create or replace function release_settlement_job(
  p_job_id uuid,
  p_worker_id text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job_id uuid;
  v_updated integer;
begin
  select id
  into v_job_id
  from settlement_jobs
  where id = p_job_id
    and worker_id = p_worker_id
    and status in ('claimed', 'processing')
    and lease_expires_at >= clock_timestamp()
  for update;

  if v_job_id is null then
    return false;
  end if;

  if exists (
    select 1
    from settlement_job_files
    where job_id = v_job_id
      and status = 'processing'
  ) then
    return false;
  end if;

  update settlement_jobs
  set status = 'queued',
      stage = 'queued',
      worker_id = null,
      lease_expires_at = null,
      heartbeat_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = v_job_id
    and worker_id = p_worker_id
    and status in ('claimed', 'processing')
    and lease_expires_at >= clock_timestamp();
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

revoke all on function release_settlement_job(uuid, text) from public, anon, authenticated;
grant execute on function release_settlement_job(uuid, text) to service_role;
