-- 030_settlement_version_job_queue.sql
--
-- Dual-contract settlement queue: existing legacy jobs keep their
-- raw_uploads file contract and stay claimable/drainable by the current
-- worker, while new jobs may instead bind to one submitted immutable web
-- intake version (migration 029). One version creates at most one job, and
-- every claim now rotates an opaque claim_token UUID and increments an
-- attempt counter so later fenced writes can require job + worker + token +
-- unexpired lease.
--
-- Contract rules enforced here:
--   * settlement_jobs.source_version_id: null = legacy job, non-null =
--     version job; immutable after insert; unique (idempotent enqueue).
--   * settlement_job_files: exactly one of upload_id (legacy) /
--     source_version_file_id (version) is set, and the choice must match the
--     owning job's contract — no ambiguous mixed state.
--   * claim_settlement_job keeps its signature and legacy semantics but only
--     claims legacy-contract jobs: the deployed worker cannot process a
--     version job yet, so version jobs stay queued until a version-aware
--     claim ships in a later migration. Legacy queued/running rows remain
--     claimable and drainable exactly as before.
--   * Draft operations never enqueue: the only new enqueue path accepts a
--     submitted immutable version id and snapshots that version's frozen
--     files deterministically.
--
-- This migration is one transaction and is not written to be re-run; if any
-- statement fails the whole migration rolls back atomically.

begin;

-- Dual-contract columns -------------------------------------------------------

alter table settlement_jobs
  add column source_version_id uuid,
  add column claim_token uuid,
  add column attempt_count integer not null default 0;

alter table settlement_jobs
  add constraint settlement_jobs_source_version_id_fkey
    foreign key (source_version_id)
    references settlement_intake_versions(id) on delete restrict,
  add constraint settlement_jobs_source_version_id_uniq
    unique (source_version_id),
  add constraint settlement_jobs_attempt_count_check
    check (attempt_count between 0 and 1000000);

-- A job leased mid-migration predates fencing tokens; stamp one so the
-- token-presence invariant below holds. The current worker fences on
-- worker_id + lease only, so this does not disturb an in-flight run.
update settlement_jobs
   set claim_token = gen_random_uuid()
 where worker_id is not null
   and claim_token is null;

alter table settlement_jobs
  add constraint settlement_jobs_lease_has_claim_token
    check (worker_id is null or claim_token is not null);

alter table settlement_job_files
  alter column upload_id drop not null,
  add column source_version_file_id uuid;

alter table settlement_job_files
  add constraint settlement_job_files_source_version_file_id_fkey
    foreign key (source_version_file_id)
    references settlement_intake_version_files(id) on delete restrict,
  add constraint settlement_job_files_source_version_file_id_uniq
    unique (source_version_file_id),
  add constraint settlement_job_files_exactly_one_source
    check (num_nonnulls(upload_id, source_version_file_id) = 1);

-- Contract guards -------------------------------------------------------------

create or replace function settlement_jobs_source_contract_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.source_version_id is distinct from old.source_version_id then
    raise exception 'settlement job source_version_id is immutable';
  end if;
  return new;
end;
$$;

create or replace function settlement_job_files_contract_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_source_version_id uuid;
begin
  if tg_op = 'UPDATE' then
    if new.job_id is distinct from old.job_id
      or new.upload_id is distinct from old.upload_id
      or new.source_version_file_id is distinct from old.source_version_file_id
      or new.position is distinct from old.position
    then
      raise exception 'settlement job file source binding is immutable';
    end if;
    return new;
  end if;

  select source_version_id into v_source_version_id
  from public.settlement_jobs
  where id = new.job_id;
  if not found then
    raise exception 'unknown settlement job %', new.job_id;
  end if;

  if v_source_version_id is null then
    if new.upload_id is null or new.source_version_file_id is not null then
      raise exception 'legacy settlement jobs accept only upload-contract files';
    end if;
  else
    if new.source_version_file_id is null or new.upload_id is not null then
      raise exception 'version settlement jobs accept only source-version files';
    end if;
    if not exists (
      select 1
      from public.settlement_intake_version_files vf
      where vf.id = new.source_version_file_id
        and vf.version_id = v_source_version_id
        and vf.position = new.position
    ) then
      raise exception 'settlement job file % does not belong to source version %',
        new.source_version_file_id, v_source_version_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_settlement_jobs_source_contract
  before update on settlement_jobs
  for each row execute function settlement_jobs_source_contract_guard();

create trigger trg_settlement_job_files_contract
  before insert or update on settlement_job_files
  for each row execute function settlement_job_files_contract_guard();

-- Version enqueue (service-role only) ------------------------------------------
--
-- Accepts only the id of an already-submitted immutable intake version and
-- snapshots that version's frozen files deterministically (by position).
-- Callers cannot supply months, storage paths, or arbitrary upload lists.
-- Idempotent per source version: a replay returns the existing job id. The
-- per-version advisory lock serializes concurrent enqueues and the
-- settlement_jobs_source_version_id_uniq constraint is the backstop.

create or replace function enqueue_settlement_version_job(
  p_source_version_id uuid,
  p_actor text,
  p_parser_version text default null,
  p_rule_version text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.settlement_intake_versions;
  v_month date;
  v_job_id uuid;
begin
  if p_source_version_id is null then
    raise exception 'source version id is required';
  end if;
  if coalesce(pg_catalog.length(p_parser_version), 0) > 64
     or coalesce(pg_catalog.length(p_rule_version), 0) > 64 then
    raise exception 'version too long';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement_version_job:' || p_source_version_id::text, 0));

  select * into v_version
  from public.settlement_intake_versions
  where id = p_source_version_id;
  if not found then
    raise exception 'unknown settlement intake version %', p_source_version_id;
  end if;

  select month into v_month
  from public.settlement_intake_months
  where id = v_version.intake_id;

  select id into v_job_id
  from public.settlement_jobs
  where source_version_id = p_source_version_id;
  if found then
    return v_job_id;
  end if;

  insert into public.settlement_jobs (
    month, progress_total, parser_version, rule_version, source_version_id
  ) values (
    v_month,
    v_version.file_count,
    nullif(pg_catalog.left(p_parser_version, 64), ''),
    nullif(pg_catalog.left(p_rule_version, 64), ''),
    p_source_version_id
  ) returning id into v_job_id;

  insert into public.settlement_job_files (job_id, source_version_file_id, position)
  select v_job_id, vf.id, vf.position
  from public.settlement_intake_version_files vf
  where vf.version_id = p_source_version_id
  order by vf.position;

  insert into public.settlement_intake_audit (intake_id, actor, action, detail)
  values (v_version.intake_id, p_actor, 'version_job_enqueued',
          pg_catalog.jsonb_build_object(
            'job_id', v_job_id,
            'source_version_id', p_source_version_id,
            'version_no', v_version.version_no));

  return v_job_id;
end;
$$;

-- Legacy claim, now token-rotating and legacy-only ------------------------------
--
-- Same signature and ordering semantics as migration 022: oldest queued job
-- first, expired-lease claimed/processing rows are reclaimable, FOR UPDATE
-- SKIP LOCKED keeps concurrent claimers safe. New: every successful claim
-- rotates claim_token and increments attempt_count, and only legacy-contract
-- jobs (source_version_id is null) are eligible — the deployed worker has no
-- version processing yet, so version jobs must not be handed to it.

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
    where source_version_id is null
      and (
        status = 'queued'
        or (
          status in ('claimed','processing')
          and lease_expires_at < clock_timestamp()
        )
      )
    order by created_at, id
    for update skip locked
    limit 1
  )
  update settlement_jobs j
  set status = 'claimed',
      worker_id = p_worker_id,
      claim_token = gen_random_uuid(),
      attempt_count = least(j.attempt_count + 1, 1000000),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      heartbeat_at = clock_timestamp(),
      started_at = coalesce(j.started_at, clock_timestamp()),
      updated_at = clock_timestamp()
  from candidate
  where j.id = candidate.id
  returning j.*;
end;
$$;

-- Security --------------------------------------------------------------------
-- Consistent with 028/029: anon/authenticated/public get nothing; only
-- service_role may execute the queue RPCs. Table privileges for
-- settlement_jobs/settlement_job_files were already locked down in 022/028.

revoke all on function enqueue_settlement_version_job(uuid, text, text, text) from public, anon, authenticated;
revoke all on function claim_settlement_job(text, integer) from public, anon, authenticated;
revoke all on function settlement_jobs_source_contract_guard() from public, anon, authenticated;
revoke all on function settlement_job_files_contract_guard() from public, anon, authenticated;

grant execute on function enqueue_settlement_version_job(uuid, text, text, text) to service_role;
grant execute on function claim_settlement_job(text, integer) to service_role;

commit;

-- rollback (manual — run as ONE transaction; restores the pure legacy queue):
--   begin;
--   drop trigger trg_settlement_job_files_contract on settlement_job_files;
--   drop trigger trg_settlement_jobs_source_contract on settlement_jobs;
--   drop function enqueue_settlement_version_job(uuid, text, text, text);
--   drop function settlement_job_files_contract_guard();
--   drop function settlement_jobs_source_contract_guard();
--   -- version-contract jobs cannot exist in the legacy schema; they are
--   -- unprocessed queue rows (never claimable by the legacy worker), so
--   -- deleting them loses no processing evidence:
--   delete from settlement_job_files where source_version_file_id is not null;
--   delete from settlement_jobs where source_version_id is not null;
--   alter table settlement_job_files
--     drop constraint settlement_job_files_exactly_one_source,
--     drop constraint settlement_job_files_source_version_file_id_uniq,
--     drop constraint settlement_job_files_source_version_file_id_fkey,
--     drop column source_version_file_id,
--     alter column upload_id set not null;
--   alter table settlement_jobs
--     drop constraint settlement_jobs_lease_has_claim_token,
--     drop constraint settlement_jobs_attempt_count_check,
--     drop constraint settlement_jobs_source_version_id_uniq,
--     drop constraint settlement_jobs_source_version_id_fkey,
--     drop column attempt_count,
--     drop column claim_token,
--     drop column source_version_id;
--   -- then re-run the claim_settlement_job definition from
--   -- 022_settlement_worker_jobs.sql to restore the pre-030 claim behavior;
--   commit;
