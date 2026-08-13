-- 035_settlement_local_sync_backups.sql
-- Honest local Google Drive Desktop sync evidence alongside Drive API evidence.
begin;

alter table public.settlement_drive_backups
  add column transport_kind varchar(24) not null default 'google_drive_api',
  add column local_relative_path varchar(1000),
  add column local_evidence_sha256 char(64);

alter table public.settlement_drive_backups
  alter column drive_parent_id drop not null,
  drop constraint settlement_drive_backups_state_check,
  add constraint settlement_drive_backups_transport_check check (
    (transport_kind = 'google_drive_api'
      and drive_parent_id is not null and drive_parent_id ~ '^[A-Za-z0-9_-]+$'
      and local_relative_path is null and local_evidence_sha256 is null)
    or
    (transport_kind = 'local_sync'
      and drive_parent_id is null and drive_file_id is null and drive_sha256 is null and drive_version is null
      and local_relative_path is not null
      and local_relative_path ~ '^[0-9]{4}-[0-9]{2}/v[0-9]{3,6}-[0-9a-f-]{36}/run-[0-9a-f-]{36}/.+$'
      and local_evidence_sha256 ~ '^[0-9a-f]{64}$')
  ),
  add constraint settlement_drive_backups_state_check check (
    (status in ('pending','retry') and transport_kind = 'google_drive_api'
      and drive_file_id is null and drive_sha256 is null and drive_version is null
      and uploaded_at is null and verified_at is null)
    or
    (status = 'verified' and transport_kind = 'google_drive_api'
      and drive_file_id is not null and drive_sha256 is not null and drive_version is not null
      and uploaded_at is not null and verified_at is not null
      and pg_catalog.length(drive_file_id) between 1 and 256
      and drive_file_id ~ '^[A-Za-z0-9_-]+$'
      and drive_sha256 ~ '^[0-9a-f]{64}$'
      and drive_version ~ '^(0|[1-9][0-9]{0,19})$')
    or
    (status = 'verified' and transport_kind = 'local_sync'
      and uploaded_at is not null and verified_at is not null)
  );

create unique index settlement_drive_backups_local_path_uniq
  on public.settlement_drive_backups(local_relative_path)
  where transport_kind = 'local_sync';

create or replace function public.verify_settlement_local_sync_archive(
  p_job_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_relative_archive_path text,
  p_archive_evidence_sha256 text,
  p_files jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.settlement_jobs;
  v_run public.settlement_processing_runs;
  v_version public.settlement_intake_versions;
  v_intake public.settlement_intake_months;
  v_now timestamptz;
  v_manifest text;
  v_manifest_size bigint;
  v_month_key text;
  v_version_dir text;
  v_expected_count integer;
  v_item jsonb;
  v_kind text;
  v_file_id uuid;
  v_identity text;
  v_sha text;
  v_size bigint;
  v_rel text;
  v_existing public.settlement_drive_backups;
begin
  if p_relative_archive_path is null
     or p_relative_archive_path !~ '^[0-9]{4}-[0-9]{2}/v[0-9]{3,6}-[0-9a-f-]{36}/run-[0-9a-f-]{36}$'
     or p_archive_evidence_sha256 is null
     or p_archive_evidence_sha256 !~ '^[0-9a-f]{64}$'
     or p_files is null or pg_catalog.jsonb_typeof(p_files) <> 'array'
  then return false; end if;

  select * into v_job from public.settlement_jobs j
   where j.id = p_job_id and j.source_version_id is not null
     and j.worker_id = p_worker_id and j.claim_token = p_claim_token
     and j.status = 'processing' for update of j;
  if not found then return false; end if;

  select * into v_run from public.settlement_processing_runs r
   where r.id = p_run_id and r.job_id = p_job_id
     and r.source_version_id = v_job.source_version_id
     and r.worker_id = p_worker_id and r.claim_token = p_claim_token
     and r.status = 'snapshot_ready' for update of r;
  if not found then return false; end if;

  v_now := pg_catalog.clock_timestamp();
  if v_job.lease_expires_at <= v_now or v_run.lease_expires_at <= v_now
     or v_run.snapshot_ready_at is null or v_run.workbook_ready_at is null
     or v_run.workbook_sha256 is null or v_run.workbook_size_bytes is null
  then return false; end if;

  select * into v_version from public.settlement_intake_versions v where v.id = v_run.source_version_id;
  if not found then return false; end if;
  select * into v_intake from public.settlement_intake_months i where i.id = v_version.intake_id;
  if not found then return false; end if;
  v_month_key := pg_catalog.substr(v_intake.month_key, 1, 4) || '-' || pg_catalog.substr(v_intake.month_key, 5, 2);
  v_version_dir := 'v' || pg_catalog.lpad(v_version.version_no::text, 3, '0') || '-' || v_version.id::text;
  if p_relative_archive_path is distinct from v_month_key || '/' || v_version_dir || '/run-' || v_run.id::text
  then return false; end if;

  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'position', f.position, 'object_id', f.object_id, 'path_key', f.path_key,
    'display_name', f.display_name, 'size_bytes', f.size_bytes,
    'sha256', f.sha256, 'storage_path', f.storage_path) order by f.position)::text
    into v_manifest from public.settlement_intake_version_files f where f.version_id = v_version.id;
  if v_manifest is null then return false; end if;
  v_manifest_size := pg_catalog.octet_length(pg_catalog.convert_to(v_manifest, 'UTF8'));
  v_expected_count := v_version.file_count + 3; -- manifest, all sources, office workbook, evidence.json
  if pg_catalog.jsonb_array_length(p_files) <> v_expected_count then return false; end if;

  -- Reject duplicate paths and malformed file evidence.
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_files) e
    where pg_catalog.jsonb_typeof(e) <> 'object'
       or (e->>'relativePath') is null
       or (e->>'sha256') !~ '^[0-9a-f]{64}$'
       or (e->>'sizeBytes') !~ '^[1-9][0-9]*$'
  ) or (
    select pg_catalog.count(*) from (
      select e->>'relativePath' from pg_catalog.jsonb_array_elements(p_files) e group by 1
    ) q
  ) <> v_expected_count then return false; end if;

  if not exists (select 1 from pg_catalog.jsonb_array_elements(p_files) e
    where e->>'relativePath' = 'manifest.json'
      and e->>'sha256' = v_version.manifest_sha256
      and (e->>'sizeBytes')::bigint = v_manifest_size)
  or not exists (select 1 from pg_catalog.jsonb_array_elements(p_files) e
    where e->>'relativePath' = '결과/office-verified.xlsx'
      and e->>'sha256' = v_run.workbook_sha256
      and (e->>'sizeBytes')::bigint = v_run.workbook_size_bytes)
  or not exists (select 1 from pg_catalog.jsonb_array_elements(p_files) e
    where e->>'relativePath' = '결과/evidence.json')
  or exists (
    select 1 from public.settlement_intake_version_files f
    where f.version_id = v_version.id and not exists (
      select 1 from pg_catalog.jsonb_array_elements(p_files) e
      where e->>'relativePath' = '원본/' || f.display_name
        and e->>'sha256' = f.sha256
        and (e->>'sizeBytes')::bigint = f.size_bytes
    )
  ) then return false; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('settlement_local_sync:' || v_run.id::text, 0));

  for v_item in select value from pg_catalog.jsonb_array_elements(p_files)
  loop
    v_rel := v_item->>'relativePath';
    v_sha := v_item->>'sha256';
    v_size := (v_item->>'sizeBytes')::bigint;
    if v_rel = 'manifest.json' then
      v_kind := 'source_manifest'; v_file_id := null; v_identity := 'svm:' || v_version.id::text;
    elsif v_rel = '결과/office-verified.xlsx' then
      v_kind := 'verified_workbook'; v_file_id := null; v_identity := 'run:' || v_run.id::text;
    elsif v_rel like '원본/%' then
      select f.id into v_file_id from public.settlement_intake_version_files f
       where f.version_id = v_version.id and '원본/' || f.display_name = v_rel;
      if not found then return false; end if;
      v_kind := 'source_file'; v_identity := 'svf:' || v_file_id::text;
    else
      continue; -- evidence.json is covered by the immutable sidecar digest, not a publication-required row.
    end if;

    select * into v_existing from public.settlement_drive_backups b where b.backup_identity = v_identity for update of b;
    if found then
      if v_existing.status is distinct from 'verified'
         or v_existing.kind is distinct from v_kind
         or v_existing.source_version_id is distinct from v_version.id
         or v_existing.source_version_file_id is distinct from v_file_id
         or v_existing.run_id is distinct from (case when v_kind = 'verified_workbook' then v_run.id else null end)
         or v_existing.content_sha256 is distinct from v_sha
         or v_existing.size_bytes is distinct from v_size
      then raise exception 'existing backup evidence mismatch' using errcode = '23514'; end if;
      -- Exact verified API/local evidence remains authoritative across source
      -- retries and transport changes. The newly completed local archive is
      -- still preserved on disk and covered by its sidecar.
    else
      insert into public.settlement_drive_backups(
        kind, source_version_id, source_version_file_id, run_id, backup_identity,
        content_sha256, size_bytes, drive_parent_id, transport_kind,
        local_relative_path, local_evidence_sha256, status, attempt_count,
        active_run_id, active_claim_token, active_attempt_token,
        uploaded_at, verified_at, created_at, updated_at
      ) values (
        v_kind, v_version.id, v_file_id,
        case when v_kind = 'verified_workbook' then v_run.id else null end,
        v_identity, v_sha, v_size, null, 'local_sync',
        p_relative_archive_path || '/' || v_rel, p_archive_evidence_sha256,
        'verified', 1, v_run.id, p_claim_token, pg_catalog.gen_random_uuid(),
        v_now, v_now, v_now, v_now
      );
    end if;
  end loop;

  return true;
exception when unique_violation or check_violation or invalid_text_representation then
  return false;
end;
$$;

revoke all on function public.verify_settlement_local_sync_archive(uuid,uuid,text,uuid,text,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_settlement_local_sync_archive(uuid,uuid,text,uuid,text,text,jsonb)
  to service_role;

commit;
