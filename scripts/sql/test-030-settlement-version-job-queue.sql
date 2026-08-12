-- Live-database contract check for migration 030 (dual-contract settlement
-- version job queue). Run against a database that has migrations up to 030
-- applied, e.g.:
--
--   npm run test:settlement-version-queue-sql
--   (psql "$SUPABASE_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/test-030-settlement-version-job-queue.sql)
--
-- Everything runs in ONE transaction that always ROLLS BACK, so no fixture
-- row survives. While the transaction is open it may briefly hold row locks
-- on claimed queue rows (claim uses FOR UPDATE SKIP LOCKED, so a concurrent
-- real worker skips them); prefer running against staging/dev.

\set ON_ERROR_STOP on

begin;

do $contract$
declare
  v_actor constant text := 'contract-check';
  v_sha_a constant char(64) := repeat('a', 64);
  v_sha_b constant char(64) := repeat('b', 64);
  v_intake public.settlement_intake_months;
  v_obj_a public.settlement_intake_objects;
  v_obj_b public.settlement_intake_objects;
  v_version public.settlement_intake_versions;
  v_job_id uuid;
  v_job_replay uuid;
  v_job public.settlement_jobs;
  v_claimed public.settlement_jobs;
  v_first_token uuid;
  v_upload_legacy uuid;
  v_upload_spare uuid;
  v_legacy_job uuid;
  v_count integer;
begin
  -- ---------------------------------------------------------------
  -- Fixture: one submitted immutable intake version, built through
  -- the real 029 RPCs (year 2999 so it cannot collide with real data).
  -- ---------------------------------------------------------------
  v_intake := public.create_settlement_intake('299901', v_actor);
  v_obj_a := public.register_settlement_intake_object(
    v_intake.id, 'contract-check/a.csv', 'a.csv', 'text/csv',
    10, v_sha_a, v_actor, v_intake.draft_revision, null);
  v_obj_a := public.finalize_settlement_intake_object(v_obj_a.id, 10, v_sha_a, v_actor);
  perform public.upsert_settlement_intake_draft_entry(
    v_intake.id, v_obj_a.id, v_intake.draft_revision, v_actor);
  select * into v_intake from public.settlement_intake_months where id = v_intake.id;

  v_obj_b := public.register_settlement_intake_object(
    v_intake.id, 'contract-check/sub/b.csv', 'b.csv', 'text/csv',
    20, v_sha_b, v_actor, v_intake.draft_revision, null);
  v_obj_b := public.finalize_settlement_intake_object(v_obj_b.id, 20, v_sha_b, v_actor);
  perform public.upsert_settlement_intake_draft_entry(
    v_intake.id, v_obj_b.id, v_intake.draft_revision, v_actor);
  select * into v_intake from public.settlement_intake_months where id = v_intake.id;

  v_version := public.submit_settlement_intake_version(
    v_intake.id, v_intake.draft_revision, v_actor);

  -- ---------------------------------------------------------------
  -- Enqueue: accepts only a submitted version, snapshots its files
  -- deterministically, and is idempotent per source version.
  -- ---------------------------------------------------------------
  v_job_id := public.enqueue_settlement_version_job(v_version.id, v_actor, 'p1', 'r1');
  v_job_replay := public.enqueue_settlement_version_job(v_version.id, v_actor, 'p2-different', null);
  if v_job_replay <> v_job_id then
    raise exception 'CONTRACT FAIL: duplicate enqueue created a second job for one version';
  end if;

  select * into v_job from public.settlement_jobs where id = v_job_id;
  if v_job.source_version_id <> v_version.id
     or v_job.status <> 'queued'
     or v_job.month <> date '2999-01-01'
     or v_job.progress_total <> v_version.file_count then
    raise exception 'CONTRACT FAIL: version job row does not bind the frozen version';
  end if;

  select count(*) into v_count
  from public.settlement_job_files f
  join public.settlement_intake_version_files vf on vf.id = f.source_version_file_id
  where f.job_id = v_job_id
    and f.upload_id is null
    and vf.version_id = v_version.id
    and vf.position = f.position;
  if v_count <> v_version.file_count
     or v_count <> (select count(*) from public.settlement_job_files where job_id = v_job_id) then
    raise exception 'CONTRACT FAIL: job files are not an exact positional snapshot of the version';
  end if;

  begin
    perform public.enqueue_settlement_version_job(gen_random_uuid(), v_actor, null, null);
    raise exception 'CONTRACT FAIL: enqueue accepted an unknown version id';
  exception when others then
    if sqlerrm like 'CONTRACT FAIL%' then raise; end if;
  end;

  -- ---------------------------------------------------------------
  -- Legacy fixture rows (created_at pinned to 2000-01-01 so this job
  -- is deterministically first in claim order on any database).
  -- ---------------------------------------------------------------
  insert into public.raw_uploads (filename, storage_path, settlement_month, status)
  values ('contract-check-legacy.csv', 'uploads/2999-01/contract-check-legacy.csv', date '2999-01-01', 'uploaded')
  returning id into v_upload_legacy;
  insert into public.raw_uploads (filename, storage_path, settlement_month, status)
  values ('contract-check-spare.csv', 'uploads/2999-01/contract-check-spare.csv', date '2999-01-01', 'uploaded')
  returning id into v_upload_spare;

  insert into public.settlement_jobs (month, progress_total, created_at)
  values (date '2999-01-01', 1, timestamptz '2000-01-01T00:00:00Z')
  returning id into v_legacy_job;
  insert into public.settlement_job_files (job_id, upload_id, position)
  values (v_legacy_job, v_upload_legacy, 0);

  -- ---------------------------------------------------------------
  -- Dual-contract enforcement: no ambiguous mixed state.
  -- ---------------------------------------------------------------
  begin
    insert into public.settlement_job_files (job_id, upload_id, position)
    values (v_job_id, v_upload_spare, 199);
    raise exception 'CONTRACT FAIL: version job accepted a legacy upload file';
  exception when others then
    if sqlerrm like 'CONTRACT FAIL%' then raise; end if;
  end;

  begin
    insert into public.settlement_job_files (job_id, upload_id, source_version_file_id, position)
    values (v_legacy_job, v_upload_spare,
            (select id from public.settlement_intake_version_files
              where version_id = v_version.id and position = 0), 1);
    raise exception 'CONTRACT FAIL: a job file accepted both source contracts at once';
  exception when others then
    if sqlerrm like 'CONTRACT FAIL%' then raise; end if;
  end;

  begin
    insert into public.settlement_job_files (job_id, source_version_file_id, position)
    values (v_legacy_job,
            (select id from public.settlement_intake_version_files
              where version_id = v_version.id and position = 0), 1);
    raise exception 'CONTRACT FAIL: legacy job accepted a source-version file';
  exception when others then
    if sqlerrm like 'CONTRACT FAIL%' then raise; end if;
  end;

  begin
    update public.settlement_jobs set source_version_id = null where id = v_job_id;
    raise exception 'CONTRACT FAIL: source_version_id was mutable';
  exception when others then
    if sqlerrm like 'CONTRACT FAIL%' then raise; end if;
  end;

  begin
    update public.settlement_job_files
       set position = 199
     where job_id = v_job_id and position = 0;
    raise exception 'CONTRACT FAIL: version snapshot position was mutable';
  exception when others then
    if sqlerrm like 'CONTRACT FAIL%' then raise; end if;
  end;

  begin
    insert into public.settlement_job_files (job_id, source_version_file_id, position)
    values (
      v_job_id,
      (select id from public.settlement_intake_version_files
        where version_id = v_version.id and position = 0),
      199
    );
    raise exception 'CONTRACT FAIL: version file accepted a mismatched source position';
  exception when others then
    if sqlerrm like 'CONTRACT FAIL%' then raise; end if;
  end;

  -- ---------------------------------------------------------------
  -- Claim: legacy rows stay claimable/drainable, every claim rotates
  -- the fencing token, and version jobs are never handed out.
  -- ---------------------------------------------------------------
  select * into v_claimed from public.claim_settlement_job('contract-check-worker-1', 60);
  if v_claimed.id is distinct from v_legacy_job then
    raise exception 'CONTRACT FAIL: claim did not return the oldest legacy job';
  end if;
  if v_claimed.claim_token is null or v_claimed.attempt_count < 1 then
    raise exception 'CONTRACT FAIL: claim did not stamp claim_token/attempt_count';
  end if;
  v_first_token := v_claimed.claim_token;

  -- expire the lease, reclaim with another worker: still drainable, new token
  update public.settlement_jobs
     set lease_expires_at = clock_timestamp() - interval '1 second'
   where id = v_legacy_job;
  select * into v_claimed from public.claim_settlement_job('contract-check-worker-2', 60);
  if v_claimed.id is distinct from v_legacy_job then
    raise exception 'CONTRACT FAIL: expired-lease legacy job was not reclaimable';
  end if;
  if v_claimed.claim_token is null or v_claimed.claim_token = v_first_token then
    raise exception 'CONTRACT FAIL: reclaim did not rotate the claim token';
  end if;
  if v_claimed.attempt_count < 2 then
    raise exception 'CONTRACT FAIL: reclaim did not increment attempt_count';
  end if;

  select * into v_job from public.settlement_jobs where id = v_job_id;
  if v_job.status <> 'queued' or v_job.worker_id is not null then
    raise exception 'CONTRACT FAIL: a version job was claimed by the legacy claim path';
  end if;

  -- ---------------------------------------------------------------
  -- Privileges: service_role only; anon/authenticated denied (028/029).
  -- ---------------------------------------------------------------
  if has_function_privilege('anon', 'public.enqueue_settlement_version_job(uuid, text, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.enqueue_settlement_version_job(uuid, text, text, text)', 'execute')
     or has_function_privilege('anon', 'public.claim_settlement_job(text, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.claim_settlement_job(text, integer)', 'execute') then
    raise exception 'CONTRACT FAIL: anon/authenticated can execute queue RPCs';
  end if;
  if not has_function_privilege('service_role', 'public.enqueue_settlement_version_job(uuid, text, text, text)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_settlement_job(text, integer)', 'execute') then
    raise exception 'CONTRACT FAIL: service_role cannot execute queue RPCs';
  end if;

  raise notice 'settlement version queue SQL contract: all checks passed (rolling back)';
end;
$contract$;

rollback;
