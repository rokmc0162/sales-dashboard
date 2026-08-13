-- 036_settlement_historical_ledger_provenance.sql
-- Bind every verified workbook and publication to its exact prior ledger.

begin;

alter table public.settlement_processing_runs
  add column baseline_month date,
  add column baseline_publication_id uuid references public.settlement_publications(id),
  add column baseline_artifact_sha256 char(64);

alter table public.settlement_processing_runs
  add constraint settlement_processing_runs_baseline_evidence_check
  check (
    (baseline_month is null and baseline_publication_id is null and baseline_artifact_sha256 is null)
    or
    (baseline_month is not null and baseline_artifact_sha256 ~ '^[0-9a-f]{64}$')
  );

-- Preserve the old signature during migration-first rollout, but fail closed:
-- an old worker cannot establish the required historical-ledger provenance.
create or replace function public.mark_settlement_processing_run_workbook_ready(
  p_job_id uuid, p_run_id uuid, p_worker_id text, p_claim_token uuid,
  p_workbook_sha256 text, p_archive_sha256 text, p_size_bytes bigint,
  p_sheet_count integer, p_row_count integer, p_office_verifier text,
  p_office_version text, p_office_archive_sha256 text,
  p_office_sheet_count integer, p_office_row_count integer
)
returns boolean language sql security definer set search_path = ''
as 'select false';

revoke all on function public.mark_settlement_processing_run_workbook_ready(
  uuid,uuid,text,uuid,text,text,bigint,integer,integer,text,text,text,integer,integer
) from public, anon, authenticated, service_role;
grant execute on function public.mark_settlement_processing_run_workbook_ready(
  uuid,uuid,text,uuid,text,text,bigint,integer,integer,text,text,text,integer,integer
) to service_role;

create function public.mark_settlement_processing_run_workbook_ready(
  p_job_id uuid, p_run_id uuid, p_worker_id text, p_claim_token uuid,
  p_workbook_sha256 text, p_archive_sha256 text, p_size_bytes bigint,
  p_sheet_count integer, p_row_count integer, p_office_verifier text,
  p_office_version text, p_office_archive_sha256 text,
  p_office_sheet_count integer, p_office_row_count integer,
  p_baseline_month date, p_baseline_publication_id uuid,
  p_baseline_artifact_sha256 text
)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_job public.settlement_jobs;
  v_run public.settlement_processing_runs;
  v_baseline public.settlement_publications;
  v_now timestamptz;
begin
  if p_workbook_sha256 is null or p_workbook_sha256 !~ '^[0-9a-f]{64}$'
     or p_archive_sha256 is null or p_archive_sha256 !~ '^[0-9a-f]{64}$'
     or p_size_bytes is null or p_sheet_count is null or p_row_count is null
     or p_office_verifier is distinct from 'libreoffice' or p_office_version is null
     or pg_catalog.length(p_office_version) not between 1 and 200
     or p_office_archive_sha256 is null or p_office_archive_sha256 !~ '^[0-9a-f]{64}$'
     or p_office_sheet_count is null or p_office_row_count is null
     or p_size_bytes not between 1 and 67108864 or p_sheet_count not between 1 and 100
     or p_row_count not between 1 and 1000000 or p_office_sheet_count not between 1 and 100
     or p_office_row_count not between 1 and 1000000
     or p_baseline_month is null or p_baseline_artifact_sha256 is null
     or p_baseline_artifact_sha256 !~ '^[0-9a-f]{64}$'
  then return false; end if;

  select * into v_job from public.settlement_jobs j
   where j.id = p_job_id and j.source_version_id is not null
     and j.worker_id = p_worker_id and j.claim_token = p_claim_token
     and j.status = 'processing' for update of j;
  if not found or p_baseline_month is distinct from (v_job.month - interval '1 month')::date then return false; end if;

  select * into v_run from public.settlement_processing_runs r
   where r.id = p_run_id and r.job_id = p_job_id and r.worker_id = p_worker_id
     and r.claim_token = p_claim_token and r.status = 'snapshot_ready' for update of r;
  if not found then return false; end if;

  v_now := pg_catalog.clock_timestamp();
  if v_job.lease_expires_at < v_now or v_run.lease_expires_at < v_now
     or v_run.stage_ready_at is null then return false; end if;

  if p_baseline_publication_id is not null then
    select * into v_baseline from public.settlement_publications p
     where p.id = p_baseline_publication_id;
    if not found or v_baseline.month is distinct from p_baseline_month
       or v_baseline.artifact_sha256 is distinct from p_baseline_artifact_sha256
    then return false; end if;
  end if;

  if v_run.workbook_ready_at is not null and (
    v_run.workbook_sha256 is distinct from p_workbook_sha256
    or v_run.workbook_archive_sha256 is distinct from p_archive_sha256
    or v_run.workbook_size_bytes is distinct from p_size_bytes
    or v_run.workbook_sheet_count is distinct from p_sheet_count
    or v_run.workbook_row_count is distinct from p_row_count
    or v_run.office_verifier is distinct from p_office_verifier
    or v_run.office_version is distinct from p_office_version
    or v_run.office_archive_sha256 is distinct from p_office_archive_sha256
    or v_run.office_sheet_count is distinct from p_office_sheet_count
    or v_run.office_row_count is distinct from p_office_row_count
    or v_run.baseline_month is distinct from p_baseline_month
    or v_run.baseline_publication_id is distinct from p_baseline_publication_id
    or v_run.baseline_artifact_sha256 is distinct from p_baseline_artifact_sha256)
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
    baseline_month = coalesce(baseline_month, p_baseline_month),
    baseline_publication_id = coalesce(baseline_publication_id, p_baseline_publication_id),
    baseline_artifact_sha256 = coalesce(baseline_artifact_sha256, p_baseline_artifact_sha256),
    workbook_ready_at = coalesce(workbook_ready_at, v_now), heartbeat_at = v_now, updated_at = v_now
   where id = p_run_id;
  update public.settlement_jobs set stage = 'workbook_validation', heartbeat_at = v_now, updated_at = v_now
   where id = p_job_id;
  return true;
end;
$$;

revoke all on function public.mark_settlement_processing_run_workbook_ready(
  uuid,uuid,text,uuid,text,text,bigint,integer,integer,text,text,text,integer,integer,date,uuid,text
) from public, anon, authenticated, service_role;
grant execute on function public.mark_settlement_processing_run_workbook_ready(
  uuid,uuid,text,uuid,text,text,bigint,integer,integer,text,text,text,integer,integer,date,uuid,text
) to service_role;

-- The publication function created by 034 reads the row type dynamically. Add
-- a fail-closed trigger so a publication cannot be inserted if its run lost or
-- changed the exact prior-ledger evidence after workbook validation.
create or replace function public.check_settlement_publication_baseline()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_run public.settlement_processing_runs;
  v_current public.settlement_month_current;
begin
  select * into v_run from public.settlement_processing_runs r where r.id = new.run_id;
  if not found or v_run.baseline_month is distinct from (new.month - interval '1 month')::date
     or v_run.baseline_artifact_sha256 is null then
    raise exception 'settlement publication baseline evidence missing';
  end if;

  -- Serialize against a concurrent publication of the prior month. The 034
  -- publication RPC uses the same advisory key for the month it publishes.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'settlement_publication:' || pg_catalog.to_char(v_run.baseline_month, 'YYYYMM'), 0
    )
  );
  select * into v_current from public.settlement_month_current c
   where c.month = v_run.baseline_month for update of c;
  if v_run.baseline_publication_id is not null then
    if not found or v_current.publication_id is distinct from v_run.baseline_publication_id then
      raise exception 'settlement prior publication changed';
    end if;
  elsif found then
    raise exception 'settlement private baseline is no longer authoritative';
  end if;
  return new;
end;
$$;

create trigger settlement_publication_baseline_gate
before insert on public.settlement_publications
for each row execute function public.check_settlement_publication_baseline();

revoke all on function public.check_settlement_publication_baseline() from public, anon, authenticated, service_role;

commit;
