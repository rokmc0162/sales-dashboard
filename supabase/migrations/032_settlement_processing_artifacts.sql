-- 032_settlement_processing_artifacts.sql
-- Fenced immutable parse-stage and verified-workbook evidence for version runs.
-- The 031 lifecycle status remains snapshot_ready until Drive/publication exists;
-- readiness is expressed by immutable evidence timestamps, avoiding changes to
-- claim/reclaim/heartbeat/fail/release contracts.

begin;

alter table public.settlement_processing_runs
  add column stage_sha256 char(64),
  add column stage_size_bytes bigint,
  add column stage_file_count integer,
  add column stage_raw_row_count integer,
  add column stage_sales_row_count integer,
  add column stage_ready_at timestamptz,
  add column workbook_sha256 char(64),
  add column workbook_archive_sha256 char(64),
  add column workbook_size_bytes bigint,
  add column workbook_sheet_count integer,
  add column workbook_row_count integer,
  add column office_verifier varchar(32),
  add column office_version varchar(200),
  add column office_archive_sha256 char(64),
  add column office_sheet_count integer,
  add column office_row_count integer,
  add column workbook_ready_at timestamptz;

alter table public.settlement_processing_runs
  add constraint settlement_processing_runs_stage_evidence_check
  check (
    (stage_sha256 is null and stage_size_bytes is null and stage_file_count is null
      and stage_raw_row_count is null and stage_sales_row_count is null and stage_ready_at is null)
    or
    (stage_sha256 is not null and stage_size_bytes is not null and stage_file_count is not null
      and stage_raw_row_count is not null and stage_sales_row_count is not null and stage_ready_at is not null
      and stage_sha256 ~ '^[0-9a-f]{64}$' and stage_size_bytes between 1 and 1073741824
      and stage_file_count between 1 and 10000 and stage_raw_row_count between 1 and 1000000
      and stage_sales_row_count between 1 and 1000000)
  ),
  add constraint settlement_processing_runs_workbook_evidence_check
  check (
    (workbook_sha256 is null and workbook_archive_sha256 is null and workbook_size_bytes is null
      and workbook_sheet_count is null and workbook_row_count is null and office_verifier is null
      and office_version is null and office_archive_sha256 is null and office_sheet_count is null
      and office_row_count is null and workbook_ready_at is null)
    or
    (workbook_sha256 is not null and workbook_archive_sha256 is not null and workbook_size_bytes is not null
      and workbook_sheet_count is not null and workbook_row_count is not null and office_verifier is not null
      and office_version is not null and office_archive_sha256 is not null and office_sheet_count is not null
      and office_row_count is not null and workbook_ready_at is not null and stage_ready_at is not null
      and workbook_sha256 ~ '^[0-9a-f]{64}$' and workbook_archive_sha256 ~ '^[0-9a-f]{64}$'
      and workbook_size_bytes between 1 and 67108864 and workbook_sheet_count between 1 and 100
      and workbook_row_count between 1 and 1000000 and office_verifier = 'libreoffice'
      and pg_catalog.length(office_version) between 1 and 200
      and office_archive_sha256 ~ '^[0-9a-f]{64}$' and office_sheet_count between 1 and 100
      and office_row_count between 1 and 1000000)
  );

create or replace function public.mark_settlement_processing_run_stage_ready(
  p_job_id uuid, p_run_id uuid, p_worker_id text, p_claim_token uuid,
  p_stage_sha256 text, p_stage_size_bytes bigint, p_file_count integer,
  p_raw_row_count integer, p_sales_row_count integer
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_job public.settlement_jobs;
  v_run public.settlement_processing_runs;
  v_now timestamptz;
begin
  if p_stage_sha256 is null or p_stage_sha256 !~ '^[0-9a-f]{64}$'
     or p_stage_size_bytes is null or p_file_count is null
     or p_raw_row_count is null or p_sales_row_count is null
     or p_stage_size_bytes < 1 or p_stage_size_bytes > 1073741824
     or p_file_count < 1 or p_file_count > 10000
     or p_raw_row_count < 1 or p_raw_row_count > 1000000
     or p_sales_row_count < 1 or p_sales_row_count > 1000000 then return false; end if;

  select * into v_job from public.settlement_jobs j
   where j.id = p_job_id and j.source_version_id is not null
     and j.worker_id = p_worker_id and j.claim_token = p_claim_token
     and j.status = 'processing' for update of j;
  if not found then return false; end if;
  select * into v_run from public.settlement_processing_runs r
   where r.id = p_run_id and r.job_id = p_job_id and r.worker_id = p_worker_id
     and r.claim_token = p_claim_token and r.status = 'snapshot_ready' for update of r;
  if not found then return false; end if;
  v_now := pg_catalog.clock_timestamp();
  if v_job.lease_expires_at < v_now or v_run.lease_expires_at < v_now
     or v_run.snapshot_ready_at is null then return false; end if;
  if v_run.stage_ready_at is not null and (
    v_run.stage_sha256 is distinct from p_stage_sha256 or v_run.stage_size_bytes is distinct from p_stage_size_bytes
    or v_run.stage_file_count is distinct from p_file_count or v_run.stage_raw_row_count is distinct from p_raw_row_count
    or v_run.stage_sales_row_count is distinct from p_sales_row_count) then return false; end if;

  update public.settlement_processing_runs set
    stage_sha256 = coalesce(stage_sha256, p_stage_sha256),
    stage_size_bytes = coalesce(stage_size_bytes, p_stage_size_bytes),
    stage_file_count = coalesce(stage_file_count, p_file_count),
    stage_raw_row_count = coalesce(stage_raw_row_count, p_raw_row_count),
    stage_sales_row_count = coalesce(stage_sales_row_count, p_sales_row_count),
    stage_ready_at = coalesce(stage_ready_at, v_now), heartbeat_at = v_now, updated_at = v_now
   where id = p_run_id;
  update public.settlement_jobs set stage = 'parsing', heartbeat_at = v_now, updated_at = v_now where id = p_job_id;
  return true;
end;
$$;

create or replace function public.mark_settlement_processing_run_workbook_ready(
  p_job_id uuid, p_run_id uuid, p_worker_id text, p_claim_token uuid,
  p_workbook_sha256 text, p_archive_sha256 text, p_size_bytes bigint,
  p_sheet_count integer, p_row_count integer, p_office_verifier text,
  p_office_version text, p_office_archive_sha256 text,
  p_office_sheet_count integer, p_office_row_count integer
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_job public.settlement_jobs;
  v_run public.settlement_processing_runs;
  v_now timestamptz;
begin
  if p_workbook_sha256 is null or p_workbook_sha256 !~ '^[0-9a-f]{64}$'
     or p_archive_sha256 is null or p_archive_sha256 !~ '^[0-9a-f]{64}$'
     or p_size_bytes is null or p_sheet_count is null or p_row_count is null
     or p_office_verifier is null or p_office_version is null
     or p_office_archive_sha256 is null or p_office_sheet_count is null or p_office_row_count is null
     or p_size_bytes < 1 or p_size_bytes > 67108864 or p_sheet_count < 1 or p_sheet_count > 100
     or p_row_count < 1 or p_row_count > 1000000 or p_office_verifier <> 'libreoffice'
     or p_office_version is null or pg_catalog.length(p_office_version) < 1 or pg_catalog.length(p_office_version) > 200
     or p_office_archive_sha256 is null or p_office_archive_sha256 !~ '^[0-9a-f]{64}$'
     or p_office_sheet_count < 1 or p_office_sheet_count > 100
     or p_office_row_count < 1 or p_office_row_count > 1000000 then return false; end if;

  select * into v_job from public.settlement_jobs j
   where j.id = p_job_id and j.source_version_id is not null
     and j.worker_id = p_worker_id and j.claim_token = p_claim_token
     and j.status = 'processing' for update of j;
  if not found then return false; end if;
  select * into v_run from public.settlement_processing_runs r
   where r.id = p_run_id and r.job_id = p_job_id and r.worker_id = p_worker_id
     and r.claim_token = p_claim_token and r.status = 'snapshot_ready' for update of r;
  if not found then return false; end if;
  v_now := pg_catalog.clock_timestamp();
  if v_job.lease_expires_at < v_now or v_run.lease_expires_at < v_now
     or v_run.stage_ready_at is null then return false; end if;
  if v_run.workbook_ready_at is not null and (
    v_run.workbook_sha256 is distinct from p_workbook_sha256 or v_run.workbook_archive_sha256 is distinct from p_archive_sha256
    or v_run.workbook_size_bytes is distinct from p_size_bytes or v_run.workbook_sheet_count is distinct from p_sheet_count
    or v_run.workbook_row_count is distinct from p_row_count or v_run.office_verifier is distinct from p_office_verifier
    or v_run.office_version is distinct from p_office_version or v_run.office_archive_sha256 is distinct from p_office_archive_sha256
    or v_run.office_sheet_count is distinct from p_office_sheet_count or v_run.office_row_count is distinct from p_office_row_count)
  then return false; end if;

  update public.settlement_processing_runs set
    workbook_sha256 = coalesce(workbook_sha256, p_workbook_sha256),
    workbook_archive_sha256 = coalesce(workbook_archive_sha256, p_archive_sha256),
    workbook_size_bytes = coalesce(workbook_size_bytes, p_size_bytes),
    workbook_sheet_count = coalesce(workbook_sheet_count, p_sheet_count),
    workbook_row_count = coalesce(workbook_row_count, p_row_count),
    office_verifier = coalesce(office_verifier, p_office_verifier),
    office_version = coalesce(office_version, p_office_version),
    office_archive_sha256 = coalesce(office_archive_sha256, p_office_archive_sha256),
    office_sheet_count = coalesce(office_sheet_count, p_office_sheet_count),
    office_row_count = coalesce(office_row_count, p_office_row_count),
    workbook_ready_at = coalesce(workbook_ready_at, v_now), heartbeat_at = v_now, updated_at = v_now
   where id = p_run_id;
  update public.settlement_jobs set stage = 'workbook_validation', heartbeat_at = v_now, updated_at = v_now where id = p_job_id;
  return true;
end;
$$;

revoke all on function public.mark_settlement_processing_run_stage_ready(uuid,uuid,text,uuid,text,bigint,integer,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_settlement_processing_run_workbook_ready(uuid,uuid,text,uuid,text,text,bigint,integer,integer,text,text,text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.mark_settlement_processing_run_stage_ready(uuid,uuid,text,uuid,text,bigint,integer,integer,integer) to service_role;
grant execute on function public.mark_settlement_processing_run_workbook_ready(uuid,uuid,text,uuid,text,text,bigint,integer,integer,text,text,text,integer,integer) to service_role;

commit;
