-- 034_settlement_atomic_publications.sql
-- Atomic, immutable publication of one fully verified version processing run.

begin;

-- A successfully published run is terminal and must never be reclaimed.
alter table public.settlement_processing_runs
  drop constraint settlement_processing_runs_status_check,
  drop constraint settlement_processing_runs_lease_state_check;

alter table public.settlement_processing_runs
  add constraint settlement_processing_runs_status_check
    check (status in ('claimed','snapshotting','snapshot_ready','failed','released','published')),
  add constraint settlement_processing_runs_lease_state_check
    check (
      (status in ('claimed','snapshotting','snapshot_ready') and lease_expires_at is not null and terminal_at is null)
      or
      (status in ('failed','released','published') and lease_expires_at is null and terminal_at is not null)
    );

create table public.settlement_publications (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  month date not null check (month = pg_catalog.date_trunc('month', month)::date),
  intake_id uuid not null references public.settlement_intake_months(id) on delete restrict,
  source_version_id uuid not null references public.settlement_intake_versions(id) on delete restrict,
  job_id uuid not null references public.settlement_jobs(id) on delete restrict,
  run_id uuid not null unique references public.settlement_processing_runs(id) on delete restrict,
  published_worker_id varchar(128) not null check (
    pg_catalog.length(published_worker_id) between 1 and 128
    and published_worker_id !~ '[[:cntrl:]]'
  ),
  published_claim_token uuid not null,
  artifact_bucket text not null check (artifact_bucket = 'upload-debug'),
  artifact_path varchar(200) not null unique check (
    artifact_path ~ '^publications/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/candidate[.]xlsx$'
  ),
  artifact_sha256 char(64) not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_size_bytes bigint not null check (artifact_size_bytes between 1 and 67108864),
  workbook_archive_sha256 char(64) not null check (workbook_archive_sha256 ~ '^[0-9a-f]{64}$'),
  workbook_sheet_count integer not null check (workbook_sheet_count between 1 and 100),
  workbook_row_count integer not null check (workbook_row_count between 1 and 1000000),
  published_at timestamptz not null default pg_catalog.now()
);

create table public.settlement_month_current (
  month date primary key check (month = pg_catalog.date_trunc('month', month)::date),
  publication_id uuid not null unique references public.settlement_publications(id) on delete restrict,
  updated_at timestamptz not null default pg_catalog.now()
);

create table public.settlement_publication_audit (
  id bigserial primary key,
  month date not null,
  publication_id uuid not null references public.settlement_publications(id) on delete restrict,
  previous_publication_id uuid references public.settlement_publications(id) on delete restrict,
  job_id uuid not null,
  run_id uuid not null,
  source_version_id uuid not null,
  action varchar(20) not null check (action = 'publish'),
  created_at timestamptz not null default pg_catalog.now(),
  unique (publication_id, action)
);

create or replace function public.reject_settlement_publication_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'settlement publication evidence is immutable' using errcode = '55000';
end;
$$;

create trigger settlement_publications_immutable
before update or delete on public.settlement_publications
for each row execute function public.reject_settlement_publication_mutation();

create trigger settlement_publication_audit_immutable
before update or delete on public.settlement_publication_audit
for each row execute function public.reject_settlement_publication_mutation();

create or replace function public.publish_settlement_processing_run(
  p_job_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_expected_current_publication_id uuid,
  p_artifact_bucket text,
  p_artifact_path text,
  p_artifact_sha256 text,
  p_artifact_size_bytes bigint
)
returns setof public.settlement_publications
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.settlement_jobs;
  v_run public.settlement_processing_runs;
  v_version public.settlement_intake_versions;
  v_intake public.settlement_intake_months;
  v_existing public.settlement_publications;
  v_current public.settlement_month_current;
  v_publication public.settlement_publications;
  v_now timestamptz;
  v_expected_files integer;
begin
  if p_job_id is null or p_run_id is null or p_claim_token is null
     or p_worker_id is null or pg_catalog.length(p_worker_id) not between 1 and 128
     or p_worker_id ~ '[[:cntrl:]]'
     or p_artifact_bucket is distinct from 'upload-debug'
     or p_artifact_path is null
     or p_artifact_path !~ '^publications/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/candidate[.]xlsx$'
     or p_artifact_sha256 is null or p_artifact_sha256 !~ '^[0-9a-f]{64}$'
     or p_artifact_size_bytes is null or p_artifact_size_bytes not between 1 and 67108864
  then return; end if;

  -- A completed identical replay is allowed after the original lease was closed.
  select * into v_existing from public.settlement_publications p where p.run_id = p_run_id;
  if found then
    select * into v_current from public.settlement_month_current c where c.month = v_existing.month;
    if v_existing.job_id = p_job_id
       and v_existing.published_worker_id = p_worker_id
       and v_existing.published_claim_token = p_claim_token
       and v_existing.artifact_bucket = p_artifact_bucket
       and v_existing.artifact_path = p_artifact_path
       and v_existing.artifact_sha256 = p_artifact_sha256
       and v_existing.artifact_size_bytes = p_artifact_size_bytes
       and v_current.publication_id = v_existing.id
    then return next v_existing; end if;
    return;
  end if;

  -- Global lock order is job -> run, matching the worker lifecycle RPCs.
  select * into v_job from public.settlement_jobs j
   where j.id = p_job_id and j.source_version_id is not null
     and j.status = 'processing' and j.worker_id = p_worker_id
     and j.claim_token = p_claim_token
   for update of j;
  if not found then return; end if;

  select * into v_run from public.settlement_processing_runs r
   where r.id = p_run_id and r.job_id = p_job_id
     and r.source_version_id = v_job.source_version_id
     and r.status = 'snapshot_ready' and r.worker_id = p_worker_id
     and r.claim_token = p_claim_token
   for update of r;
  if not found then return; end if;

  v_now := pg_catalog.clock_timestamp();
  if v_job.lease_expires_at <= v_now or v_run.lease_expires_at <= v_now
     or v_run.snapshot_ready_at is null or v_run.snapshot_manifest_sha256 is null
     or v_run.stage_ready_at is null or v_run.stage_sha256 is null
     or v_run.workbook_ready_at is null or v_run.workbook_sha256 is null
     or v_run.workbook_archive_sha256 is null or v_run.workbook_size_bytes is null
     or v_run.workbook_sheet_count is null or v_run.workbook_row_count is null
     or v_run.office_verifier is distinct from 'libreoffice'
  then return; end if;

  if p_artifact_path is distinct from ('publications/' || p_run_id::text || '/candidate.xlsx')
     or p_artifact_sha256 is distinct from v_run.workbook_sha256
     or p_artifact_size_bytes is distinct from v_run.workbook_size_bytes
  then return; end if;

  select * into v_version from public.settlement_intake_versions v
   where v.id = v_job.source_version_id;
  if not found then return; end if;
  select * into v_intake from public.settlement_intake_months i
   where i.id = v_version.intake_id;
  if not found or v_job.month is distinct from v_intake.month then return; end if;

  -- Serialize with draft mutation/submission, which uses this same intake key.
  -- The submit path never locks job/run rows, so this cannot invert our
  -- lifecycle job -> run lock order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement_intake:' || v_intake.id::text, 0)
  );

  -- Only the latest submitted immutable version for the intake may publish.
  if exists (
    select 1 from public.settlement_intake_versions newer
     where newer.intake_id = v_version.intake_id
       and newer.version_no > v_version.version_no
  ) then return; end if;

  -- Snapshot evidence must still equal the frozen version.
  if v_run.snapshot_manifest_sha256 is distinct from v_version.manifest_sha256
     or v_run.snapshot_file_count is distinct from v_version.file_count
     or v_run.snapshot_total_bytes is distinct from v_version.total_size_bytes
  then return; end if;

  -- Exactly one verified manifest backup must bind this source version.
  if (select pg_catalog.count(*) from public.settlement_drive_backups b
       where b.kind = 'source_manifest' and b.source_version_id = v_version.id
         and b.status = 'verified' and b.content_sha256 = v_version.manifest_sha256) <> 1
  then return; end if;

  select pg_catalog.count(*) into v_expected_files
    from public.settlement_intake_version_files f where f.version_id = v_version.id;
  if v_expected_files <> v_version.file_count or exists (
    select 1 from public.settlement_intake_version_files f
     where f.version_id = v_version.id
       and (select pg_catalog.count(*) from public.settlement_drive_backups b
             where b.kind = 'source_file' and b.source_version_file_id = f.id
               and b.source_version_id = v_version.id and b.status = 'verified'
               and b.content_sha256 = f.sha256 and b.size_bytes = f.size_bytes) <> 1
  ) then return; end if;

  -- Exactly one verified workbook backup must match immutable run evidence.
  if (select pg_catalog.count(*) from public.settlement_drive_backups b
       where b.kind = 'verified_workbook' and b.run_id = v_run.id
         and b.source_version_id = v_version.id and b.status = 'verified'
         and b.content_sha256 = v_run.workbook_sha256
         and b.size_bytes = v_run.workbook_size_bytes) <> 1
  then return; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement_publication:' || v_intake.month_key, 0)
  );
  select * into v_current from public.settlement_month_current c
   where c.month = v_intake.month for update of c;
  if found then
    if v_current.publication_id is distinct from p_expected_current_publication_id then return; end if;
  elsif p_expected_current_publication_id is not null then
    return;
  end if;

  insert into public.settlement_publications(
    month,intake_id,source_version_id,job_id,run_id,published_worker_id,published_claim_token,artifact_bucket,artifact_path,
    artifact_sha256,artifact_size_bytes,workbook_archive_sha256,
    workbook_sheet_count,workbook_row_count,published_at
  ) values (
    v_intake.month,v_intake.id,v_version.id,v_job.id,v_run.id,p_worker_id,p_claim_token,p_artifact_bucket,p_artifact_path,
    v_run.workbook_sha256,v_run.workbook_size_bytes,v_run.workbook_archive_sha256,
    v_run.workbook_sheet_count,v_run.workbook_row_count,v_now
  ) returning * into v_publication;

  insert into public.settlement_month_current(month,publication_id,updated_at)
  values (v_intake.month,v_publication.id,v_now)
  on conflict (month) do update
    set publication_id = excluded.publication_id, updated_at = excluded.updated_at;

  insert into public.settlement_publication_audit(
    month,publication_id,previous_publication_id,job_id,run_id,source_version_id,action,created_at
  ) values (
    v_intake.month,v_publication.id,v_current.publication_id,v_job.id,v_run.id,v_version.id,'publish',v_now
  );

  update public.settlement_processing_runs set
    status = 'published', lease_expires_at = null, terminal_at = v_now,
    heartbeat_at = v_now, updated_at = v_now
   where id = v_run.id;
  update public.settlement_jobs set
    status = 'completed', stage = 'completed', lease_expires_at = null,
    worker_id = null, claim_token = null,
    heartbeat_at = v_now, completed_at = v_now, updated_at = v_now,
    artifact_storage_path = p_artifact_path,
    workbook_sheet_count = v_run.workbook_sheet_count,
    workbook_row_count = v_run.workbook_row_count,
    result_summary = 'verified settlement publication completed',
    error_summary = null
   where id = v_job.id;

  return next v_publication;
exception when unique_violation then
  return;
end;
$$;

alter table public.settlement_publications enable row level security;
alter table public.settlement_month_current enable row level security;
alter table public.settlement_publication_audit enable row level security;

revoke all on table public.settlement_publications from public, anon, authenticated, service_role;
revoke all on table public.settlement_month_current from public, anon, authenticated, service_role;
revoke all on table public.settlement_publication_audit from public, anon, authenticated, service_role;
revoke all on sequence public.settlement_publication_audit_id_seq from public, anon, authenticated, service_role;
grant select on table public.settlement_publications to service_role;
grant select on table public.settlement_month_current to service_role;
grant select on table public.settlement_publication_audit to service_role;

revoke all on function public.reject_settlement_publication_mutation() from public, anon, authenticated, service_role;
revoke all on function public.publish_settlement_processing_run(uuid,uuid,text,uuid,uuid,text,text,text,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_settlement_processing_run(uuid,uuid,text,uuid,uuid,text,text,text,bigint)
  to service_role;

commit;
