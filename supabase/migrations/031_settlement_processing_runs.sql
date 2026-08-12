-- 031_settlement_processing_runs.sql
--
-- Immutable attempt identity and fenced snapshot lifecycle for the
-- version-aware settlement worker. Legacy queue RPCs are deliberately not
-- replaced here: claim_settlement_job and every legacy heartbeat/finish/
-- release signature retain the definitions installed by migrations 022-030.
--
-- A processing run snapshots job + source version + attempt + parser/rule
-- versions at claim time. The claim token and worker are also frozen on the
-- run. Every later mutation must match job id, run id, worker id, the exact
-- current token, and an unexpired lease on both rows.
--
-- This migration is one transaction and is not written to be re-run. Any
-- failure rolls the entire schema/privilege change back atomically.

begin;

-- Processing-run evidence ----------------------------------------------------

create table public.settlement_processing_runs (
  id                  uuid primary key default pg_catalog.gen_random_uuid(),
  job_id              uuid not null
                      references public.settlement_jobs(id) on delete restrict,
  source_version_id   uuid not null
                      references public.settlement_intake_versions(id) on delete restrict,
  attempt_no          integer not null check (attempt_no between 1 and 1000000),
  parser_version      varchar(64),
  rule_version        varchar(64),
  status              varchar(20) not null default 'claimed'
                      check (status in (
                        'claimed','snapshotting','snapshot_ready','failed','released'
                      )),
  worker_id           varchar(128) not null
                      check (
                        pg_catalog.length(worker_id) between 1 and 128
                        and worker_id !~ '[[:cntrl:]]'
                      ),
  claim_token         uuid not null,
  lease_expires_at    timestamptz,
  heartbeat_at        timestamptz not null,
  snapshot_manifest_sha256 char(64),
  snapshot_file_count integer,
  snapshot_total_bytes bigint,
  snapshot_ready_at   timestamptz,
  error_summary       varchar(500),
  claimed_at          timestamptz not null default pg_catalog.now(),
  terminal_at         timestamptz,
  created_at          timestamptz not null default pg_catalog.now(),
  updated_at          timestamptz not null default pg_catalog.now(),
  constraint settlement_processing_runs_job_attempt_uniq
    unique (job_id, attempt_no),
  constraint settlement_processing_runs_lease_state_check
    check (
      (
        status in ('claimed','snapshotting','snapshot_ready')
        and lease_expires_at is not null
        and terminal_at is null
      ) or (
        status in ('failed','released')
        and lease_expires_at is null
        and terminal_at is not null
      )
    ),
  constraint settlement_processing_runs_snapshot_evidence_check
    check (
      (
        snapshot_manifest_sha256 is null
        and snapshot_file_count is null
        and snapshot_total_bytes is null
        and snapshot_ready_at is null
      ) or (
        snapshot_manifest_sha256 ~ '^[0-9a-f]{64}$'
        and snapshot_file_count between 1 and 10000
        and snapshot_total_bytes between 1 and 107374182400
        and snapshot_ready_at is not null
      )
    )
);

-- Defense in depth: even privileged internal SQL cannot rewrite which source
-- and software versions an attempt represents. Status/evidence columns remain
-- mutable only for the fenced RPCs below. Run rows cannot be deleted.
create or replace function public.settlement_processing_runs_identity_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_job public.settlement_jobs;
begin
  if tg_op = 'DELETE' then
    raise exception 'settlement processing runs cannot be deleted';
  end if;

  if tg_op = 'INSERT' then
    select j.* into v_job
    from public.settlement_jobs j
    where j.id = new.job_id;

    if not found
       or v_job.source_version_id is null
       or new.source_version_id is distinct from v_job.source_version_id
       or new.attempt_no is distinct from v_job.attempt_count
       or new.parser_version is distinct from v_job.parser_version
       or new.rule_version is distinct from v_job.rule_version
       or new.worker_id is distinct from v_job.worker_id
       or new.claim_token is distinct from v_job.claim_token
       or new.lease_expires_at is distinct from v_job.lease_expires_at
       or new.status <> 'claimed'
    then
      raise exception 'settlement processing run identity does not match its claimed version job';
    end if;

    return new;
  end if;

  if new.id is distinct from old.id
     or new.job_id is distinct from old.job_id
     or new.source_version_id is distinct from old.source_version_id
     or new.attempt_no is distinct from old.attempt_no
     or new.parser_version is distinct from old.parser_version
     or new.rule_version is distinct from old.rule_version
     or new.worker_id is distinct from old.worker_id
     or new.claim_token is distinct from old.claim_token
     or new.claimed_at is distinct from old.claimed_at
     or new.created_at is distinct from old.created_at
  then
    raise exception 'settlement processing run identity is immutable';
  end if;

  return new;
end;
$$;

create trigger trg_settlement_processing_runs_identity
  before insert or update or delete on public.settlement_processing_runs
  for each row execute function public.settlement_processing_runs_identity_guard();

-- At most one live run may exist for a logical job. The unique job/attempt
-- constraint preserves complete attempt history; this partial index is the
-- concurrency backstop for active claims.
create unique index idx_settlement_processing_runs_one_active_job
  on public.settlement_processing_runs (job_id)
  where status in ('claimed','snapshotting','snapshot_ready');

create index idx_settlement_jobs_version_claim
  on public.settlement_jobs (created_at, id)
  where source_version_id is not null
    and status in ('queued','claimed','processing')
    and attempt_count < 1000000;

-- Version-only claim ---------------------------------------------------------
--
-- Claim order and SKIP LOCKED match the legacy queue's concurrency model, but
-- the non-null source discriminator makes the contracts mutually exclusive.
-- Reclaim first releases the expired nonterminal run under the job lock; the
-- fresh token, incremented attempt, and new run are then committed atomically.

create or replace function public.claim_settlement_version_job(
  p_worker_id text,
  p_lease_seconds integer default 900
)
returns setof public.settlement_processing_runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.settlement_jobs;
  v_run public.settlement_processing_runs;
  v_now timestamptz;
  v_terminalized integer;
begin
  if p_worker_id is null
     or pg_catalog.length(p_worker_id) < 1
     or pg_catalog.length(p_worker_id) > 128
     or p_worker_id ~ '[[:cntrl:]]'
  then
    raise exception 'invalid worker id';
  end if;
  if p_lease_seconds < 30 or p_lease_seconds > 14400 then
    raise exception 'invalid lease seconds';
  end if;

  select j.* into v_job
  from public.settlement_jobs j
  where j.source_version_id is not null
    and j.attempt_count < 1000000
    and (
      j.status = 'queued'
      or (
        j.status in ('claimed','processing')
        and j.lease_expires_at < pg_catalog.clock_timestamp()
      )
    )
  order by j.created_at, j.id
  for update of j skip locked
  limit 1;

  if not found then
    return;
  end if;

  v_now := pg_catalog.clock_timestamp();

  if v_job.status in ('claimed','processing') then
    update public.settlement_processing_runs r
       set status = 'released',
           lease_expires_at = null,
           error_summary = 'lease expired and claim was superseded',
           terminal_at = v_now,
           updated_at = v_now
     where r.job_id = v_job.id
       and r.source_version_id = v_job.source_version_id
       and r.attempt_no = v_job.attempt_count
       and r.worker_id = v_job.worker_id
       and r.claim_token = v_job.claim_token
       and r.status in ('claimed','snapshotting','snapshot_ready');
    get diagnostics v_terminalized = row_count;
    if v_terminalized <> 1 then
      raise exception 'active version job % has no matching nonterminal processing run', v_job.id;
    end if;
  end if;

  update public.settlement_jobs j
     set status = 'claimed',
         stage = 'queued',
         progress_current = 0,
         worker_id = p_worker_id,
         claim_token = pg_catalog.gen_random_uuid(),
         attempt_count = j.attempt_count + 1,
         lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds),
         heartbeat_at = v_now,
         error_summary = null,
         result_summary = null,
         artifact_storage_path = null,
         workbook_sheet_count = null,
         workbook_row_count = null,
         started_at = coalesce(j.started_at, v_now),
         completed_at = null,
         updated_at = v_now
   where j.id = v_job.id
  returning j.* into v_job;

  insert into public.settlement_processing_runs (
    job_id,
    source_version_id,
    attempt_no,
    parser_version,
    rule_version,
    worker_id,
    claim_token,
    lease_expires_at,
    heartbeat_at,
    claimed_at,
    created_at,
    updated_at
  ) values (
    v_job.id,
    v_job.source_version_id,
    v_job.attempt_count,
    v_job.parser_version,
    v_job.rule_version,
    v_job.worker_id,
    v_job.claim_token,
    v_job.lease_expires_at,
    v_now,
    v_now,
    v_now,
    v_now
  )
  returning * into v_run;

  return next v_run;
  return;
end;
$$;

-- Fenced run lifecycle -------------------------------------------------------

create or replace function public.heartbeat_settlement_processing_run(
  p_job_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_locked_id uuid;
  v_job_lease timestamptz;
  v_run_lease timestamptz;
  v_now timestamptz;
  v_new_lease timestamptz;
begin
  if p_lease_seconds < 30 or p_lease_seconds > 14400 then
    return false;
  end if;

  select j.id, j.lease_expires_at into v_locked_id, v_job_lease
  from public.settlement_jobs j
  where j.id = p_job_id
    and j.source_version_id is not null
    and j.worker_id = p_worker_id
    and j.claim_token = p_claim_token
    and j.status in ('claimed','processing')
  for update of j;
  if not found then
    return false;
  end if;

  select r.id, r.lease_expires_at into v_locked_id, v_run_lease
  from public.settlement_processing_runs r
  where r.id = p_run_id
    and r.job_id = p_job_id
    and r.worker_id = p_worker_id
    and r.claim_token = p_claim_token
    and r.status in ('claimed','snapshotting','snapshot_ready')
  for update of r;
  if not found then
    return false;
  end if;

  -- Re-read the wall clock only after both row locks are held. A lease that
  -- expires while this call waits on either lock must not pass the fence.
  v_now := pg_catalog.clock_timestamp();
  if v_job_lease < v_now or v_run_lease < v_now then
    return false;
  end if;
  v_new_lease := v_now + pg_catalog.make_interval(secs => p_lease_seconds);

  update public.settlement_jobs
     set status = 'processing',
         lease_expires_at = v_new_lease,
         heartbeat_at = v_now,
         updated_at = v_now
   where id = p_job_id;

  update public.settlement_processing_runs
     set status = case when status = 'claimed' then 'snapshotting' else status end,
         lease_expires_at = v_new_lease,
         heartbeat_at = v_now,
         updated_at = v_now
   where id = p_run_id;

  return true;
end;
$$;

create or replace function public.mark_settlement_processing_run_snapshot_ready(
  p_job_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_manifest_sha256 text,
  p_file_count integer,
  p_total_bytes bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_locked_id uuid;
  v_job_lease timestamptz;
  v_run_lease timestamptz;
  v_now timestamptz;
begin
  if p_manifest_sha256 is null
     or p_manifest_sha256 !~ '^[0-9a-f]{64}$'
     or p_file_count < 1 or p_file_count > 10000
     or p_total_bytes < 1 or p_total_bytes > 107374182400
  then
    return false;
  end if;

  select j.id, j.lease_expires_at into v_locked_id, v_job_lease
  from public.settlement_jobs j
  where j.id = p_job_id
    and j.source_version_id is not null
    and j.worker_id = p_worker_id
    and j.claim_token = p_claim_token
    and j.status in ('claimed','processing')
  for update of j;
  if not found then
    return false;
  end if;

  select r.id, r.lease_expires_at into v_locked_id, v_run_lease
  from public.settlement_processing_runs r
  where r.id = p_run_id
    and r.job_id = p_job_id
    and r.worker_id = p_worker_id
    and r.claim_token = p_claim_token
    and r.status in ('claimed','snapshotting','snapshot_ready')
  for update of r;
  if not found then
    return false;
  end if;

  v_now := pg_catalog.clock_timestamp();
  if v_job_lease < v_now or v_run_lease < v_now then
    return false;
  end if;

  if exists (
    select 1
    from public.settlement_processing_runs r
    where r.id = p_run_id
      and r.snapshot_ready_at is not null
      and (
        r.snapshot_manifest_sha256 is distinct from p_manifest_sha256
        or r.snapshot_file_count is distinct from p_file_count
        or r.snapshot_total_bytes is distinct from p_total_bytes
      )
  ) then
    return false;
  end if;

  update public.settlement_jobs
     set status = 'processing',
         heartbeat_at = v_now,
         updated_at = v_now
   where id = p_job_id;

  update public.settlement_processing_runs
     set status = 'snapshot_ready',
         snapshot_manifest_sha256 = coalesce(snapshot_manifest_sha256, p_manifest_sha256),
         snapshot_file_count = coalesce(snapshot_file_count, p_file_count),
         snapshot_total_bytes = coalesce(snapshot_total_bytes, p_total_bytes),
         snapshot_ready_at = coalesce(snapshot_ready_at, v_now),
         heartbeat_at = v_now,
         updated_at = v_now
   where id = p_run_id;

  return true;
end;
$$;

create or replace function public.fail_settlement_processing_run(
  p_job_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_error_summary text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_locked_id uuid;
  v_job_lease timestamptz;
  v_run_lease timestamptz;
  v_now timestamptz;
begin
  select j.id, j.lease_expires_at into v_locked_id, v_job_lease
  from public.settlement_jobs j
  where j.id = p_job_id
    and j.source_version_id is not null
    and j.worker_id = p_worker_id
    and j.claim_token = p_claim_token
    and j.status in ('claimed','processing')
  for update of j;
  if not found then
    return false;
  end if;

  select r.id, r.lease_expires_at into v_locked_id, v_run_lease
  from public.settlement_processing_runs r
  where r.id = p_run_id
    and r.job_id = p_job_id
    and r.worker_id = p_worker_id
    and r.claim_token = p_claim_token
    and r.status in ('claimed','snapshotting','snapshot_ready')
  for update of r;
  if not found then
    return false;
  end if;

  v_now := pg_catalog.clock_timestamp();
  if v_job_lease < v_now or v_run_lease < v_now then
    return false;
  end if;

  update public.settlement_processing_runs
     set status = 'failed',
         lease_expires_at = null,
         heartbeat_at = v_now,
         error_summary = nullif(pg_catalog.left(p_error_summary, 500), ''),
         terminal_at = v_now,
         updated_at = v_now
   where id = p_run_id;

  update public.settlement_jobs
     set status = 'failed',
         stage = 'completed',
         worker_id = null,
         lease_expires_at = null,
         heartbeat_at = v_now,
         error_summary = nullif(pg_catalog.left(p_error_summary, 500), ''),
         completed_at = v_now,
         updated_at = v_now
   where id = p_job_id;

  return true;
end;
$$;

create or replace function public.release_settlement_processing_run(
  p_job_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_locked_id uuid;
  v_job_lease timestamptz;
  v_run_lease timestamptz;
  v_now timestamptz;
begin
  select j.id, j.lease_expires_at into v_locked_id, v_job_lease
  from public.settlement_jobs j
  where j.id = p_job_id
    and j.source_version_id is not null
    and j.worker_id = p_worker_id
    and j.claim_token = p_claim_token
    and j.status in ('claimed','processing')
  for update of j;
  if not found then
    return false;
  end if;

  select r.id, r.lease_expires_at into v_locked_id, v_run_lease
  from public.settlement_processing_runs r
  where r.id = p_run_id
    and r.job_id = p_job_id
    and r.worker_id = p_worker_id
    and r.claim_token = p_claim_token
    and r.status in ('claimed','snapshotting','snapshot_ready')
  for update of r;
  if not found then
    return false;
  end if;

  v_now := pg_catalog.clock_timestamp();
  if v_job_lease < v_now or v_run_lease < v_now then
    return false;
  end if;

  update public.settlement_processing_runs
     set status = 'released',
         lease_expires_at = null,
         heartbeat_at = v_now,
         terminal_at = v_now,
         updated_at = v_now
   where id = p_run_id;

  update public.settlement_jobs
     set status = 'queued',
         stage = 'queued',
         progress_current = 0,
         worker_id = null,
         lease_expires_at = null,
         heartbeat_at = v_now,
         updated_at = v_now
   where id = p_job_id;

  return true;
end;
$$;

-- Security -------------------------------------------------------------------
-- Migration 028 grants service_role broad default privileges on later public
-- tables. Revoke those inherited privileges explicitly: run evidence is
-- directly readable only by service_role and mutable only through the fenced
-- SECURITY DEFINER RPCs.

alter table public.settlement_processing_runs enable row level security;

revoke all on table public.settlement_processing_runs
  from public, anon, authenticated, service_role;
grant select on table public.settlement_processing_runs to service_role;

revoke all on function public.settlement_processing_runs_identity_guard()
  from public, anon, authenticated, service_role;
revoke all on function public.claim_settlement_version_job(text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.heartbeat_settlement_processing_run(uuid, uuid, text, uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_settlement_processing_run_snapshot_ready(uuid, uuid, text, uuid, text, integer, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.fail_settlement_processing_run(uuid, uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.release_settlement_processing_run(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.claim_settlement_version_job(text, integer)
  to service_role;
grant execute on function public.heartbeat_settlement_processing_run(uuid, uuid, text, uuid, integer)
  to service_role;
grant execute on function public.mark_settlement_processing_run_snapshot_ready(uuid, uuid, text, uuid, text, integer, bigint)
  to service_role;
grant execute on function public.fail_settlement_processing_run(uuid, uuid, text, uuid, text)
  to service_role;
grant execute on function public.release_settlement_processing_run(uuid, uuid, text, uuid)
  to service_role;

commit;

-- rollback (manual — run as ONE transaction, only before run evidence exists):
--   begin;
--   do $$
--   begin
--     if exists (select 1 from public.settlement_processing_runs) then
--       raise exception '031 rollback refused: processing-run evidence exists';
--     end if;
--   end;
--   $$;
--   drop function public.release_settlement_processing_run(uuid, uuid, text, uuid);
--   drop function public.fail_settlement_processing_run(uuid, uuid, text, uuid, text);
--   drop function public.mark_settlement_processing_run_snapshot_ready(uuid, uuid, text, uuid, text, integer, bigint);
--   drop function public.heartbeat_settlement_processing_run(uuid, uuid, text, uuid, integer);
--   drop function public.claim_settlement_version_job(text, integer);
--   drop trigger trg_settlement_processing_runs_identity on public.settlement_processing_runs;
--   drop function public.settlement_processing_runs_identity_guard();
--   drop table public.settlement_processing_runs;
--   drop index public.idx_settlement_jobs_version_claim;
--   commit;
--
-- This rollback does not replace or drop any legacy RPC because migration 031
-- never changes one. After any processing run exists, preserve its immutable
-- attempt evidence and roll forward instead of dropping the table.
