-- Durable, lease-based settlement worker queue.
-- Web clients never receive direct table access; authenticated requests use
-- privacy-safe API projections backed by the service role.

create table if not exists settlement_jobs (
  id                    uuid primary key default uuid_generate_v4(),
  month                 date not null check (month = date_trunc('month', month)::date),
  status                text not null default 'queued'
                        check (status in (
                          'queued','claimed','processing',
                          'completed','completed_with_warnings','failed'
                        )),
  stage                 text not null default 'queued'
                        check (stage in (
                          'queued','parsing','workbook_generation',
                          'workbook_validation','completed'
                        )),
  progress_current      integer not null default 0 check (progress_current between 0 and 200),
  progress_total        integer not null check (progress_total between 1 and 200),
  worker_id             varchar(128),
  lease_expires_at      timestamptz,
  heartbeat_at          timestamptz,
  parser_version        varchar(64),
  rule_version          varchar(64),
  error_summary         varchar(500),
  result_summary        varchar(500),
  artifact_storage_path varchar(500)
                        check (
                          artifact_storage_path is null
                          or (
                            length(artifact_storage_path) between 1 and 500
                            and artifact_storage_path ~ '^[A-Za-z0-9/._-]+$'
                          )
                        ),
  workbook_sheet_count  integer check (workbook_sheet_count between 0 and 100),
  workbook_row_count    integer check (workbook_row_count between 0 and 1000000),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  started_at            timestamptz,
  completed_at          timestamptz,
  check (progress_current <= progress_total),
  check ((worker_id is null) = (lease_expires_at is null))
);

create table if not exists settlement_job_files (
  id                              uuid primary key default uuid_generate_v4(),
  job_id                          uuid not null references settlement_jobs(id) on delete cascade,
  upload_id                       uuid not null references raw_uploads(id),
  position                        integer not null check (position between 0 and 199),
  folder_hint                     varchar(200),
  status                          text not null default 'queued'
                                  check (status in ('queued','processing','completed','skipped','failed')),
  parsed_rows                     integer check (parsed_rows between 0 and 1000000),
  sales_records_written           integer check (sales_records_written between 0 and 1000000),
  sales_records_skipped_duplicates integer check (sales_records_skipped_duplicates between 0 and 1000000),
  result_summary                  varchar(500),
  error_summary                   varchar(500),
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  started_at                      timestamptz,
  completed_at                    timestamptz,
  unique (job_id, position),
  unique (job_id, upload_id),
  unique (upload_id),
  check (folder_hint is null or folder_hint !~ '[[:cntrl:]]')
);

create index if not exists idx_settlement_jobs_claim
  on settlement_jobs (created_at, id)
  where status in ('queued','claimed','processing');
create index if not exists idx_settlement_jobs_month_created
  on settlement_jobs (month, created_at desc);
create index if not exists idx_settlement_job_files_job_position
  on settlement_job_files (job_id, position);

alter table settlement_jobs enable row level security;
alter table settlement_job_files enable row level security;

revoke all on table settlement_jobs from public, anon, authenticated;
revoke all on table settlement_job_files from public, anon, authenticated;
grant select, insert, update, delete on table settlement_jobs to service_role;
grant select, insert, update, delete on table settlement_job_files to service_role;

create or replace function enqueue_settlement_job(
  p_month date,
  p_files jsonb,
  p_parser_version text default null,
  p_rule_version text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job_id uuid;
  v_count integer;
begin
  if p_month is null or p_month <> date_trunc('month', p_month)::date then
    raise exception using message = 'invalid month';
  end if;
  if jsonb_typeof(p_files) <> 'array' then
    raise exception using message = 'invalid files';
  end if;
  v_count := jsonb_array_length(p_files);
  if v_count < 1 or v_count > 200 then
    raise exception using message = 'file count out of range';
  end if;
  if coalesce(length(p_parser_version), 0) > 64 or coalesce(length(p_rule_version), 0) > 64 then
    raise exception using message = 'version too long';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_files) f
    where coalesce(f->>'upload_id', '') !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
      or coalesce(f->>'position', '') !~ '^[0-9]{1,3}$'
      or (f ? 'folder_hint' and f->>'folder_hint' is not null and (
        length(f->>'folder_hint') > 200 or f->>'folder_hint' ~ '[[:cntrl:]]'
      ))
  ) then
    raise exception using message = 'invalid job file';
  end if;
  if (
    select count(distinct (f->>'upload_id')) from jsonb_array_elements(p_files) f
  ) <> v_count or (
    select count(distinct (f->>'position')::integer) from jsonb_array_elements(p_files) f
  ) <> v_count or exists (
    select 1 from jsonb_array_elements(p_files) f
    where (f->>'position')::integer < 0 or (f->>'position')::integer >= v_count
  ) then
    raise exception using message = 'duplicate or invalid position';
  end if;

  -- Lock every source row for the duration of validation + insertion so an
  -- upload cannot move away from "uploaded" between those operations.
  perform 1
  from raw_uploads u
  join jsonb_array_elements(p_files) f on u.id = (f->>'upload_id')::uuid
  for key share of u;

  if (
    select count(*)
    from raw_uploads u
    join jsonb_array_elements(p_files) f on u.id = (f->>'upload_id')::uuid
    where u.status = 'uploaded'
      and u.settlement_month = p_month
      and u.storage_path ~ '^uploads/[0-9]{4}-[0-9]{2}/[A-Za-z0-9._-]+$'
      and u.storage_path !~ '(^|/)\.\.(/|$)'
  ) <> v_count then
    raise exception using message = 'upload not ready for selected month';
  end if;

  insert into settlement_jobs (
    month, progress_total, parser_version, rule_version
  ) values (
    p_month,
    v_count,
    nullif(left(p_parser_version, 64), ''),
    nullif(left(p_rule_version, 64), '')
  ) returning id into v_job_id;

  insert into settlement_job_files (job_id, upload_id, position, folder_hint)
  select
    v_job_id,
    (f->>'upload_id')::uuid,
    (f->>'position')::integer,
    nullif(left(f->>'folder_hint', 200), '')
  from jsonb_array_elements(p_files) f
  order by (f->>'position')::integer;

  return v_job_id;
exception
  when unique_violation then
    raise exception using message = 'upload already assigned to a job';
end;
$$;

create or replace function claim_settlement_job(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns setof settlement_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_worker_id is null or length(p_worker_id) < 1 or length(p_worker_id) > 128
     or p_worker_id ~ '[[:cntrl:]]' then
    raise exception using message = 'invalid worker id';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 14400 then
    raise exception using message = 'invalid lease seconds';
  end if;

  return query
  with candidate as (
    select id
    from settlement_jobs
    where status = 'queued'
       or (
         status in ('claimed','processing')
         and lease_expires_at < clock_timestamp()
       )
    order by created_at, id
    for update skip locked
    limit 1
  )
  update settlement_jobs j
  set status = 'claimed',
      worker_id = p_worker_id,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      heartbeat_at = clock_timestamp(),
      started_at = coalesce(j.started_at, clock_timestamp()),
      updated_at = clock_timestamp()
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;

create or replace function heartbeat_settlement_job(
  p_job_id uuid,
  p_worker_id text,
  p_lease_seconds integer,
  p_stage text,
  p_progress_current integer,
  p_progress_total integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_updated integer;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 14400
     or p_stage not in ('parsing','workbook_generation','workbook_validation')
     or p_progress_current < 0 or p_progress_total < 1
     or p_progress_current > p_progress_total or p_progress_total > 200 then
    return false;
  end if;
  update settlement_jobs
  set status = 'processing',
      stage = p_stage,
      progress_current = p_progress_current,
      progress_total = p_progress_total,
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      heartbeat_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = p_job_id
    and worker_id = p_worker_id
    and status in ('claimed','processing')
    and lease_expires_at >= clock_timestamp();
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

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

revoke all on function enqueue_settlement_job(date, jsonb, text, text) from public, anon, authenticated;
revoke all on function claim_settlement_job(text, integer) from public, anon, authenticated;
revoke all on function heartbeat_settlement_job(uuid, text, integer, text, integer, integer) from public, anon, authenticated;
revoke all on function finish_settlement_job(uuid, text, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function enqueue_settlement_job(date, jsonb, text, text) to service_role;
grant execute on function claim_settlement_job(text, integer) to service_role;
grant execute on function heartbeat_settlement_job(uuid, text, integer, text, integer, integer) to service_role;
grant execute on function finish_settlement_job(uuid, text, text, text, text, text, integer, integer) to service_role;
