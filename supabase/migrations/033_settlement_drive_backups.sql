-- 033_settlement_drive_backups.sql
-- Create-only Google Drive backup reservations and verified read-back evidence.
-- Source backups belong to immutable intake versions and survive processing retries;
-- workbook backups belong to one immutable processing run.

begin;

create table public.settlement_drive_backups (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  kind varchar(24) not null check (kind in ('source_manifest','source_file','verified_workbook')),
  source_version_id uuid not null references public.settlement_intake_versions(id) on delete restrict,
  source_version_file_id uuid references public.settlement_intake_version_files(id) on delete restrict,
  run_id uuid references public.settlement_processing_runs(id) on delete restrict,
  backup_identity varchar(64) not null unique check (backup_identity ~ '^(svm|svf|run):[0-9a-f-]{36}$'),
  content_sha256 char(64) not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes between 1 and 107374182400),
  drive_parent_id varchar(256) not null check (
    pg_catalog.length(drive_parent_id) between 1 and 256
    and drive_parent_id ~ '^[A-Za-z0-9_-]+$'
  ),
  drive_file_id varchar(256),
  drive_sha256 char(64),
  drive_version varchar(32),
  status varchar(16) not null check (status in ('pending','retry','verified')),
  attempt_count integer not null check (attempt_count between 1 and 1000000),
  active_run_id uuid not null references public.settlement_processing_runs(id) on delete restrict,
  active_claim_token uuid not null,
  active_attempt_token uuid not null,
  next_retry_at timestamptz,
  error_summary varchar(500),
  uploaded_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint settlement_drive_backups_scope_check check (
    (kind = 'source_manifest' and source_version_file_id is null and run_id is null
      and backup_identity = 'svm:' || source_version_id::text)
    or
    (kind = 'source_file' and source_version_file_id is not null and run_id is null
      and backup_identity = 'svf:' || source_version_file_id::text)
    or
    (kind = 'verified_workbook' and source_version_file_id is null and run_id is not null
      and backup_identity = 'run:' || run_id::text)
  ),
  constraint settlement_drive_backups_state_check check (
    (status in ('pending','retry') and drive_file_id is null and drive_sha256 is null
      and drive_version is null and uploaded_at is null and verified_at is null)
    or
    (status = 'verified' and drive_file_id is not null and drive_sha256 is not null
      and drive_version is not null and uploaded_at is not null and verified_at is not null
      and pg_catalog.length(drive_file_id) between 1 and 256
      and drive_file_id ~ '^[A-Za-z0-9_-]+$'
      and drive_sha256 ~ '^[0-9a-f]{64}$'
      and drive_version ~ '^(0|[1-9][0-9]{0,19})$')
  ),
  constraint settlement_drive_backups_retry_check check (
    (status = 'retry' and next_retry_at is not null and error_summary is not null
      and pg_catalog.length(error_summary) between 1 and 500)
    or (status <> 'retry' and next_retry_at is null and error_summary is null)
  )
);

create unique index settlement_drive_backups_source_manifest_uniq
  on public.settlement_drive_backups(source_version_id) where kind = 'source_manifest';
create unique index settlement_drive_backups_source_file_uniq
  on public.settlement_drive_backups(source_version_file_id) where kind = 'source_file';
create unique index settlement_drive_backups_workbook_uniq
  on public.settlement_drive_backups(run_id) where kind = 'verified_workbook';
create unique index settlement_drive_backups_drive_file_uniq
  on public.settlement_drive_backups(drive_file_id) where drive_file_id is not null;
create index settlement_drive_backups_retry_idx
  on public.settlement_drive_backups(next_retry_at, created_at) where status = 'retry';

create or replace function public.begin_settlement_drive_backup(
  p_job_id uuid, p_run_id uuid, p_worker_id text, p_claim_token uuid,
  p_attempt_token uuid, p_kind text, p_source_version_file_id uuid,
  p_drive_parent_id text
)
returns setof public.settlement_drive_backups
language plpgsql security definer set search_path = ''
as $$
declare
  v_job public.settlement_jobs;
  v_run public.settlement_processing_runs;
  v_version public.settlement_intake_versions;
  v_version_file public.settlement_intake_version_files;
  v_backup public.settlement_drive_backups;
  v_manifest text;
  v_manifest_sha256 text;
  v_identity text;
  v_content_sha256 text;
  v_size_bytes bigint;
  v_now timestamptz;
begin
  if p_attempt_token is null
     or p_kind not in ('source_manifest','source_file','verified_workbook')
     or (p_kind = 'source_file') is distinct from (p_source_version_file_id is not null)
     or p_drive_parent_id is null
     or pg_catalog.length(p_drive_parent_id) not between 1 and 256
     or p_drive_parent_id !~ '^[A-Za-z0-9_-]+$'
  then return; end if;

  select * into v_job from public.settlement_jobs j
   where j.id = p_job_id and j.source_version_id is not null
     and j.worker_id = p_worker_id and j.claim_token = p_claim_token
     and j.status = 'processing' for update of j;
  if not found then return; end if;

  select * into v_run from public.settlement_processing_runs r
   where r.id = p_run_id and r.job_id = p_job_id
     and r.source_version_id = v_job.source_version_id
     and r.worker_id = p_worker_id and r.claim_token = p_claim_token
     and r.status = 'snapshot_ready' for update of r;
  if not found then return; end if;

  v_now := pg_catalog.clock_timestamp();
  if v_job.lease_expires_at <= v_now or v_run.lease_expires_at <= v_now
     or v_run.snapshot_ready_at is null
  then return; end if;

  select * into v_version from public.settlement_intake_versions v
   where v.id = v_run.source_version_id;
  if not found then return; end if;

  if p_kind = 'source_manifest' then
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'position', f.position, 'object_id', f.object_id,
        'path_key', f.path_key, 'display_name', f.display_name,
        'size_bytes', f.size_bytes, 'sha256', f.sha256,
        'storage_path', f.storage_path
      ) order by f.position
    )::text into v_manifest
    from public.settlement_intake_version_files f
    where f.version_id = v_version.id;
    if v_manifest is null then return; end if;
    v_manifest_sha256 := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_manifest, 'UTF8')), 'hex');
    if v_manifest_sha256 is distinct from v_version.manifest_sha256 then return; end if;
    v_identity := 'svm:' || v_version.id::text;
    v_content_sha256 := v_manifest_sha256;
    v_size_bytes := pg_catalog.octet_length(pg_catalog.convert_to(v_manifest, 'UTF8'));
  elsif p_kind = 'source_file' then
    select * into v_version_file from public.settlement_intake_version_files f
     where f.id = p_source_version_file_id and f.version_id = v_version.id;
    if not found then return; end if;
    v_identity := 'svf:' || v_version_file.id::text;
    v_content_sha256 := v_version_file.sha256;
    v_size_bytes := v_version_file.size_bytes;
  else
    if v_run.workbook_ready_at is null or v_run.workbook_sha256 is null
       or v_run.workbook_size_bytes is null then return; end if;
    v_identity := 'run:' || v_run.id::text;
    v_content_sha256 := v_run.workbook_sha256;
    v_size_bytes := v_run.workbook_size_bytes;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement_drive_backup:' || v_identity, 0));

  select * into v_backup from public.settlement_drive_backups b
   where b.backup_identity = v_identity for update of b;

  if not found then
    insert into public.settlement_drive_backups(
      kind, source_version_id, source_version_file_id, run_id,
      backup_identity, content_sha256, size_bytes, drive_parent_id,
      status, attempt_count, active_run_id, active_claim_token, active_attempt_token
    ) values (
      p_kind, v_version.id, p_source_version_file_id,
      case when p_kind = 'verified_workbook' then v_run.id else null end,
      v_identity, v_content_sha256, v_size_bytes, p_drive_parent_id,
      'pending', 1, v_run.id, p_claim_token, p_attempt_token
    ) returning * into v_backup;
  else
    if v_backup.kind is distinct from p_kind
       or v_backup.source_version_id is distinct from v_version.id
       or v_backup.source_version_file_id is distinct from p_source_version_file_id
       or v_backup.run_id is distinct from
         (case when p_kind = 'verified_workbook' then v_run.id else null end)
       or v_backup.content_sha256 is distinct from v_content_sha256
       or v_backup.size_bytes is distinct from v_size_bytes
       or v_backup.drive_parent_id is distinct from p_drive_parent_id
    then return; end if;

    if v_backup.status = 'verified' then return next v_backup; return; end if;

    if v_backup.active_claim_token = p_claim_token then
      if v_backup.active_run_id is distinct from v_run.id
         or v_backup.active_attempt_token is distinct from p_attempt_token
      then return; end if;
      return next v_backup; return;
    end if;

    -- A rotated current job claim proves the former source-backup attempt can no
    -- longer mutate through the fenced RPCs. Take it over without changing the
    -- immutable identity. Workbook rows are run-scoped and cannot reach here.
    if p_kind = 'verified_workbook' then return; end if;
    update public.settlement_drive_backups set
      status = 'pending', attempt_count = attempt_count + 1,
      active_run_id = v_run.id, active_claim_token = p_claim_token,
      active_attempt_token = p_attempt_token, next_retry_at = null,
      error_summary = null, updated_at = v_now
    where id = v_backup.id returning * into v_backup;
  end if;

  return next v_backup;
end;
$$;

create or replace function public.verify_settlement_drive_backup(
  p_job_id uuid, p_run_id uuid, p_worker_id text, p_claim_token uuid,
  p_attempt_token uuid, p_backup_id uuid, p_drive_file_id text,
  p_drive_sha256 text, p_drive_version text
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_job public.settlement_jobs;
  v_run public.settlement_processing_runs;
  v_backup public.settlement_drive_backups;
  v_conflict public.settlement_drive_backups;
  v_now timestamptz;
begin
  if p_attempt_token is null
     or p_drive_file_id is null
     or pg_catalog.length(p_drive_file_id) not between 1 and 256
     or p_drive_file_id !~ '^[A-Za-z0-9_-]+$'
     or p_drive_sha256 is null or p_drive_sha256 !~ '^[0-9a-f]{64}$'
     or p_drive_version is null or p_drive_version !~ '^(0|[1-9][0-9]{0,19})$'
  then return false; end if;

  select * into v_job from public.settlement_jobs j where j.id = p_job_id
    and j.worker_id = p_worker_id and j.claim_token = p_claim_token
    and j.status = 'processing' for update of j;
  if not found then return false; end if;
  select * into v_run from public.settlement_processing_runs r where r.id = p_run_id
    and r.job_id = p_job_id and r.worker_id = p_worker_id
    and r.claim_token = p_claim_token and r.status = 'snapshot_ready' for update of r;
  if not found then return false; end if;
  select * into v_backup from public.settlement_drive_backups b where b.id = p_backup_id
    and b.active_run_id = p_run_id and b.active_claim_token = p_claim_token
    and b.active_attempt_token = p_attempt_token for update of b;
  if not found then return false; end if;

  v_now := pg_catalog.clock_timestamp();
  if v_job.lease_expires_at <= v_now or v_run.lease_expires_at <= v_now
     or p_drive_sha256 is distinct from v_backup.content_sha256
  then return false; end if;

  if v_backup.status = 'verified' then
    return v_backup.drive_file_id = p_drive_file_id
       and v_backup.drive_sha256 = p_drive_sha256
       and v_backup.drive_version = p_drive_version;
  end if;

  select * into v_conflict from public.settlement_drive_backups b
   where b.drive_file_id = p_drive_file_id and b.id <> v_backup.id for update of b;
  if found then return false; end if;

  update public.settlement_drive_backups set
    status = 'verified', drive_file_id = p_drive_file_id,
    drive_sha256 = p_drive_sha256, drive_version = p_drive_version,
    uploaded_at = v_now, verified_at = v_now,
    next_retry_at = null, error_summary = null, updated_at = v_now
  where id = v_backup.id;
  return true;
exception when unique_violation then
  return false;
end;
$$;

create or replace function public.retry_settlement_drive_backup(
  p_job_id uuid, p_run_id uuid, p_worker_id text, p_claim_token uuid,
  p_attempt_token uuid, p_backup_id uuid, p_error_summary text,
  p_retry_seconds integer
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_job public.settlement_jobs;
  v_run public.settlement_processing_runs;
  v_backup public.settlement_drive_backups;
  v_now timestamptz;
begin
  if p_attempt_token is null
     or p_error_summary is null or pg_catalog.length(p_error_summary) not between 1 and 500
     or p_retry_seconds is null or p_retry_seconds not between 5 and 86400
  then return false; end if;

  select * into v_job from public.settlement_jobs j where j.id = p_job_id
    and j.worker_id = p_worker_id and j.claim_token = p_claim_token
    and j.status = 'processing' for update of j;
  if not found then return false; end if;
  select * into v_run from public.settlement_processing_runs r where r.id = p_run_id
    and r.job_id = p_job_id and r.worker_id = p_worker_id
    and r.claim_token = p_claim_token and r.status = 'snapshot_ready' for update of r;
  if not found then return false; end if;
  select * into v_backup from public.settlement_drive_backups b where b.id = p_backup_id
    and b.active_run_id = p_run_id and b.active_claim_token = p_claim_token
    and b.active_attempt_token = p_attempt_token for update of b;
  if not found or v_backup.status = 'verified' then return false; end if;

  v_now := pg_catalog.clock_timestamp();
  if v_job.lease_expires_at <= v_now or v_run.lease_expires_at <= v_now then return false; end if;

  if v_backup.status = 'retry' then
    return v_backup.error_summary = p_error_summary;
  end if;

  update public.settlement_drive_backups set
    status = 'retry', next_retry_at = v_now + pg_catalog.make_interval(secs => p_retry_seconds),
    error_summary = p_error_summary, updated_at = v_now
  where id = v_backup.id;
  return true;
end;
$$;

alter table public.settlement_drive_backups enable row level security;
revoke all on table public.settlement_drive_backups from public, anon, authenticated, service_role;
grant select on table public.settlement_drive_backups to service_role;

revoke all on function public.begin_settlement_drive_backup(uuid,uuid,text,uuid,uuid,text,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.verify_settlement_drive_backup(uuid,uuid,text,uuid,uuid,uuid,text,text,text)
  from public, anon, authenticated, service_role;
revoke all on function public.retry_settlement_drive_backup(uuid,uuid,text,uuid,uuid,uuid,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_settlement_drive_backup(uuid,uuid,text,uuid,uuid,text,uuid,text) to service_role;
grant execute on function public.verify_settlement_drive_backup(uuid,uuid,text,uuid,uuid,uuid,text,text,text) to service_role;
grant execute on function public.retry_settlement_drive_backup(uuid,uuid,text,uuid,uuid,uuid,text,integer) to service_role;

commit;
