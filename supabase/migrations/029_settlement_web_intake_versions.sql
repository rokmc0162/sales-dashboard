-- 029_settlement_web_intake_versions.sql
--
-- Web settlement intake: private Supabase Storage sources, a mutable draft
-- with optimistic revisions, and immutable submitted versions. Every intake
-- table is read-only for every client role — including service_role, whose
-- broad ALTER DEFAULT PRIVILEGES grant from migration 028 is explicitly
-- revoked below. All mutation flows through the SECURITY DEFINER RPCs in this
-- file, so audit, draft revisions, and immutability cannot be bypassed by
-- direct DML. Queue wiring (settlement_jobs) is intentionally absent — that
-- is migration 030.
--
-- This migration is one transaction and is not written to be re-run; if any
-- statement fails the whole migration rolls back atomically.

begin;

-- Private intake bucket -------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('settlement-intake', 'settlement-intake', false)
on conflict (id) do update set public = false;

-- Central path_key validation -------------------------------------------------
--
-- Canonical client path rules shared by the objects table CHECK and the
-- register RPC: nonempty and bounded, no control characters, no backslash,
-- no leading/trailing/repeated slash, no '.' or '..' segments, already
-- lower-cased, and provably NFC-normalized. IS NFC NORMALIZED raises on
-- non-UTF8 server encodings, so ambiguous input is rejected either way;
-- richer Unicode normalization (NFC pre-normalization of user input,
-- confusable handling) is enforced API-side before values reach the database.

create or replace function settlement_intake_path_key_ok(p_path_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_path_key is not null
     and pg_catalog.length(p_path_key) between 1 and 500
     and p_path_key !~ '[[:cntrl:]]'
     and p_path_key !~ '\\'
     and p_path_key !~ '^/'
     and p_path_key !~ '/$'
     and p_path_key !~ '//'
     and p_path_key !~ '(^|/)\.\.?(/|$)'
     and p_path_key = pg_catalog.lower(p_path_key)
     and p_path_key is nfc normalized
$$;

-- Tables ----------------------------------------------------------------------

create table settlement_intake_months (
  id  uuid primary key default gen_random_uuid(),
  month  date not null unique check (month = date_trunc('month', month)::date),
  month_key  varchar(6) not null unique check (month_key ~ '^[0-9]{4}(0[1-9]|1[0-2])$'),
  draft_revision  bigint not null default 0,
  created_by  varchar(200) not null,
  created_at  timestamptz not null default now(),
  constraint settlement_intake_months_month_key_matches
    check (month_key = pg_catalog.to_char(month, 'YYYYMM'))
);

create table settlement_intake_objects (
  id  uuid primary key default gen_random_uuid(),
  intake_id  uuid not null references settlement_intake_months(id),
  status  varchar(20) not null default 'uploading' check (status in ('uploading','finalized','quarantined')),
  storage_bucket  text not null default 'settlement-intake' check (storage_bucket = 'settlement-intake'),
  storage_path  varchar(200) not null unique check (storage_path ~ '^intake/[0-9]{6}/[0-9a-f]{32}/[0-9a-f]{32}$'),
  path_key  varchar(500) not null check (public.settlement_intake_path_key_ok(path_key)),
  display_name  varchar(300) not null check (display_name !~ '[[:cntrl:]]'),
  content_type  varchar(100) not null,
  expected_size_bytes  bigint not null check (expected_size_bytes between 1 and 104857600),
  expected_sha256  char(64) not null check (expected_sha256 ~ '^[0-9a-f]{64}$'),
  observed_size_bytes  bigint check (observed_size_bytes between 1 and 104857600),
  observed_sha256  char(64) check (observed_sha256 ~ '^[0-9a-f]{64}$'),
  quarantine_reason  varchar(500),
  created_by  varchar(200) not null,
  created_at  timestamptz not null default now(),
  check (
    status <> 'finalized' or (
      observed_size_bytes is not null
      and observed_sha256 is not null
      and observed_size_bytes = expected_size_bytes
      and observed_sha256 = expected_sha256
    )
  )
);

-- Canonical client paths must stay unique among live (non-quarantined) objects.
create unique index idx_settlement_intake_objects_path_key
  on settlement_intake_objects (intake_id, path_key)
  where status <> 'quarantined';

create table settlement_intake_draft_entries (
  id  uuid primary key default gen_random_uuid(),
  intake_id  uuid not null references settlement_intake_months(id),
  object_id  uuid not null references settlement_intake_objects(id),
  position  integer not null check (position between 0 and 199),
  revision  bigint not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (intake_id, object_id),
  constraint settlement_intake_draft_entries_position_uniq
    unique (intake_id, position) deferrable initially immediate
);

create table settlement_intake_audit (
  id  bigserial primary key,
  intake_id  uuid not null references settlement_intake_months(id),
  actor  varchar(200) not null,
  action  varchar(100) not null,
  detail  jsonb,
  created_at  timestamptz not null default now()
);

create table settlement_intake_versions (
  id  uuid primary key default gen_random_uuid(),
  intake_id  uuid not null references settlement_intake_months(id),
  version_no  integer not null check (version_no between 1 and 1000000),
  file_count  integer not null check (file_count between 1 and 200),
  total_size_bytes  bigint not null check (total_size_bytes between 1 and 20971520000),
  manifest_sha256  char(64) not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  submitted_by  varchar(200) not null,
  created_at  timestamptz not null default now(),
  unique (intake_id, version_no),
  unique (intake_id, manifest_sha256)
);

create table settlement_intake_version_files (
  id  uuid primary key default gen_random_uuid(),
  version_id  uuid not null references settlement_intake_versions(id) on delete restrict,
  object_id  uuid not null references settlement_intake_objects(id) on delete restrict,
  position  integer not null check (position between 0 and 199),
  path_key  varchar(500) not null,
  display_name  varchar(300) not null,
  size_bytes  bigint not null check (size_bytes between 1 and 104857600),
  sha256  char(64) not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path  varchar(200) not null,
  created_at  timestamptz not null default now(),
  unique (version_id, position),
  unique (version_id, object_id),
  unique (version_id, path_key)
);

-- Trigger functions -----------------------------------------------------------

create or replace function settlement_intake_forbid_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% rows are immutable', tg_table_name;
end;
$$;

create or replace function settlement_intake_objects_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'finalized' then
      raise exception 'finalized intake objects cannot be deleted';
    end if;
    if exists (
      select 1 from public.settlement_intake_version_files vf where vf.object_id = old.id
    ) then
      raise exception 'intake objects referenced by a version cannot be deleted';
    end if;
    return old;
  end if;

  if exists (
    select 1 from public.settlement_intake_version_files vf where vf.object_id = old.id
  ) then
    raise exception 'intake objects referenced by a version cannot be changed';
  end if;

  if new.intake_id is distinct from old.intake_id
    or new.storage_bucket is distinct from old.storage_bucket
    or new.storage_path is distinct from old.storage_path
    or new.path_key is distinct from old.path_key
    or new.display_name is distinct from old.display_name
    or new.content_type is distinct from old.content_type
    or new.expected_size_bytes is distinct from old.expected_size_bytes
    or new.expected_sha256 is distinct from old.expected_sha256
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  then
    raise exception 'intake object identity columns are immutable';
  end if;

  if new.status is distinct from old.status and not (
    (old.status = 'uploading' and new.status in ('finalized','quarantined'))
    or (old.status = 'finalized' and new.status = 'quarantined')
  ) then
    raise exception 'invalid intake object status transition: % -> %', old.status, new.status;
  end if;

  return new;
end;
$$;

create or replace function settlement_intake_version_files_check_source()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_version public.settlement_intake_versions;
  v_object public.settlement_intake_objects;
begin
  select * into v_version
  from public.settlement_intake_versions
  where id = new.version_id;

  if not found then
    raise exception 'unknown settlement intake version %', new.version_id;
  end if;

  -- Version files are appended only by submit_settlement_intake_version, in
  -- the same transaction that creates the version row. Any later append is
  -- rejected: the version's created_at equals now() only inside the
  -- submitting transaction.
  if v_version.created_at <> pg_catalog.now() then
    raise exception 'version files may only be appended in the transaction that submits the version';
  end if;

  select * into v_object
  from public.settlement_intake_objects
  where id = new.object_id
  for no key update;

  if not found then
    raise exception 'unknown settlement intake object %', new.object_id;
  end if;
  if v_object.status <> 'finalized' then
    raise exception 'version files may only reference finalized intake objects';
  end if;
  if v_object.intake_id <> v_version.intake_id then
    raise exception 'version file object % belongs to a different intake', new.object_id;
  end if;
  if new.path_key <> v_object.path_key
     or new.display_name <> v_object.display_name
     or new.size_bytes <> v_object.expected_size_bytes
     or new.sha256 <> v_object.expected_sha256
     or new.storage_path <> v_object.storage_path
  then
    raise exception 'version file snapshot for object % does not match its source object', new.object_id;
  end if;

  return new;
end;
$$;

-- Triggers --------------------------------------------------------------------

create trigger trg_settlement_intake_objects_guard
  before update or delete on settlement_intake_objects
  for each row execute function settlement_intake_objects_guard();

create trigger trg_settlement_intake_audit_immutable
  before update or delete on settlement_intake_audit
  for each row execute function settlement_intake_forbid_change();

create trigger trg_settlement_intake_versions_immutable
  before update or delete on settlement_intake_versions
  for each row execute function settlement_intake_forbid_change();

create trigger trg_settlement_intake_version_files_immutable
  before update or delete on settlement_intake_version_files
  for each row execute function settlement_intake_forbid_change();

create trigger trg_settlement_intake_version_files_source
  before insert on settlement_intake_version_files
  for each row execute function settlement_intake_version_files_check_source();

-- API functions (service-role only) -------------------------------------------
--
-- Lock discipline, identical in every RPC that touches an intake: take the
-- per-intake advisory lock first, then row locks (FOR NO KEY UPDATE), so no
-- pair of RPCs can acquire the same locks in opposite orders.

create or replace function create_settlement_intake(
  p_month_key text,
  p_actor text
)
returns public.settlement_intake_months
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month public.settlement_intake_months;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement_intake_month:' || p_month_key, 0));

  select * into v_month
  from public.settlement_intake_months
  where month_key = p_month_key;
  if found then
    return v_month;
  end if;

  insert into public.settlement_intake_months (month, month_key, created_by)
  values (pg_catalog.to_date(p_month_key, 'YYYYMM'), p_month_key, p_actor)
  returning * into v_month;

  insert into public.settlement_intake_audit (intake_id, actor, action, detail)
  values (v_month.id, p_actor, 'intake_created',
          pg_catalog.jsonb_build_object('month_key', p_month_key));

  return v_month;
end;
$$;

create or replace function register_settlement_intake_object(
  p_intake_id uuid,
  p_path_key text,
  p_display_name text,
  p_content_type text,
  p_expected_size_bytes bigint,
  p_expected_sha256 text,
  p_actor text
)
returns public.settlement_intake_objects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month public.settlement_intake_months;
  v_object public.settlement_intake_objects;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement_intake:' || p_intake_id::text, 0));

  select * into v_month from public.settlement_intake_months where id = p_intake_id;
  if not found then
    raise exception 'unknown settlement intake %', p_intake_id;
  end if;

  -- The API must send an already-canonical path_key; nothing is silently
  -- rewritten here.
  if not public.settlement_intake_path_key_ok(p_path_key) then
    raise exception 'invalid settlement intake path_key';
  end if;

  insert into public.settlement_intake_objects (
    intake_id, storage_path, path_key, display_name, content_type,
    expected_size_bytes, expected_sha256, created_by
  ) values (
    p_intake_id,
    'intake/' || v_month.month_key || '/'
      || pg_catalog.md5(pg_catalog.gen_random_uuid()::text) || '/'
      || pg_catalog.md5(pg_catalog.gen_random_uuid()::text),
    p_path_key,
    p_display_name,
    p_content_type,
    p_expected_size_bytes,
    pg_catalog.lower(p_expected_sha256),
    p_actor
  )
  returning * into v_object;

  insert into public.settlement_intake_audit (intake_id, actor, action, detail)
  values (p_intake_id, p_actor, 'object_registered',
          pg_catalog.jsonb_build_object('object_id', v_object.id, 'path_key', v_object.path_key));

  return v_object;
end;
$$;

create or replace function finalize_settlement_intake_object(
  p_object_id uuid,
  p_observed_size_bytes bigint,
  p_observed_sha256 text,
  p_actor text
)
returns public.settlement_intake_objects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intake_id uuid;
  v_object public.settlement_intake_objects;
begin
  select intake_id into v_intake_id
  from public.settlement_intake_objects
  where id = p_object_id;
  if not found then
    raise exception 'unknown settlement intake object %', p_object_id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement_intake:' || v_intake_id::text, 0));

  select * into v_object
  from public.settlement_intake_objects
  where id = p_object_id
  for no key update;

  if not found then
    raise exception 'unknown settlement intake object %', p_object_id;
  end if;

  if v_object.status = 'finalized'
     and v_object.observed_size_bytes = p_observed_size_bytes
     and v_object.observed_sha256 = pg_catalog.lower(p_observed_sha256) then
    return v_object;
  end if;

  if v_object.status <> 'uploading' then
    raise exception 'settlement intake object % is % and cannot be finalized',
      p_object_id, v_object.status;
  end if;

  update public.settlement_intake_objects
     set status = 'finalized',
         observed_size_bytes = p_observed_size_bytes,
         observed_sha256 = pg_catalog.lower(p_observed_sha256)
   where id = p_object_id
  returning * into v_object;

  insert into public.settlement_intake_audit (intake_id, actor, action, detail)
  values (v_object.intake_id, p_actor, 'object_finalized',
          pg_catalog.jsonb_build_object('object_id', p_object_id));

  return v_object;
end;
$$;

create or replace function quarantine_settlement_intake_object(
  p_object_id uuid,
  p_reason text,
  p_actor text
)
returns public.settlement_intake_objects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_intake_id uuid;
  v_object public.settlement_intake_objects;
begin
  select intake_id into v_intake_id
  from public.settlement_intake_objects
  where id = p_object_id;
  if not found then
    raise exception 'unknown settlement intake object %', p_object_id;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement_intake:' || v_intake_id::text, 0));

  select * into v_object
  from public.settlement_intake_objects
  where id = p_object_id
  for no key update;

  if not found then
    raise exception 'unknown settlement intake object %', p_object_id;
  end if;

  if v_object.status = 'quarantined' then
    return v_object;
  end if;

  update public.settlement_intake_objects
     set status = 'quarantined',
         quarantine_reason = p_reason
   where id = p_object_id
  returning * into v_object;

  insert into public.settlement_intake_audit (intake_id, actor, action, detail)
  values (v_object.intake_id, p_actor, 'object_quarantined',
          pg_catalog.jsonb_build_object('object_id', p_object_id, 'reason', p_reason));

  return v_object;
end;
$$;

create or replace function upsert_settlement_intake_draft_entry(
  p_intake_id uuid,
  p_object_id uuid,
  p_position integer,
  p_expected_draft_revision bigint,
  p_actor text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month public.settlement_intake_months;
  v_object public.settlement_intake_objects;
  v_revision bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement_intake:' || p_intake_id::text, 0));

  select * into v_month
  from public.settlement_intake_months
  where id = p_intake_id
  for no key update;
  if not found then
    raise exception 'unknown settlement intake %', p_intake_id;
  end if;
  if v_month.draft_revision <> p_expected_draft_revision then
    raise exception 'stale draft revision for intake %: expected %, have %',
      p_intake_id, p_expected_draft_revision, v_month.draft_revision;
  end if;

  select * into v_object
  from public.settlement_intake_objects
  where id = p_object_id and intake_id = p_intake_id;
  if not found then
    raise exception 'object % does not belong to intake %', p_object_id, p_intake_id;
  end if;
  if v_object.status = 'quarantined' then
    raise exception 'quarantined object % cannot enter the draft', p_object_id;
  end if;

  insert into public.settlement_intake_draft_entries as d (intake_id, object_id, position)
  values (p_intake_id, p_object_id, p_position)
  on conflict (intake_id, object_id) do update
    set position = excluded.position,
        revision = d.revision + 1,
        updated_at = pg_catalog.now();

  update public.settlement_intake_months
     set draft_revision = draft_revision + 1
   where id = p_intake_id
  returning draft_revision into v_revision;

  insert into public.settlement_intake_audit (intake_id, actor, action, detail)
  values (p_intake_id, p_actor, 'draft_entry_upserted',
          pg_catalog.jsonb_build_object('object_id', p_object_id, 'position', p_position));

  return v_revision;
end;
$$;

create or replace function remove_settlement_intake_draft_entry(
  p_intake_id uuid,
  p_object_id uuid,
  p_expected_draft_revision bigint,
  p_actor text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month public.settlement_intake_months;
  v_revision bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement_intake:' || p_intake_id::text, 0));

  select * into v_month
  from public.settlement_intake_months
  where id = p_intake_id
  for no key update;
  if not found then
    raise exception 'unknown settlement intake %', p_intake_id;
  end if;
  if v_month.draft_revision <> p_expected_draft_revision then
    raise exception 'stale draft revision for intake %: expected %, have %',
      p_intake_id, p_expected_draft_revision, v_month.draft_revision;
  end if;

  delete from public.settlement_intake_draft_entries
  where intake_id = p_intake_id and object_id = p_object_id;
  if not found then
    raise exception 'object % is not part of the draft for intake %', p_object_id, p_intake_id;
  end if;

  update public.settlement_intake_months
     set draft_revision = draft_revision + 1
   where id = p_intake_id
  returning draft_revision into v_revision;

  insert into public.settlement_intake_audit (intake_id, actor, action, detail)
  values (p_intake_id, p_actor, 'draft_entry_removed',
          pg_catalog.jsonb_build_object('object_id', p_object_id));

  return v_revision;
end;
$$;

create or replace function reorder_settlement_intake_draft(
  p_intake_id uuid,
  p_object_ids uuid[],
  p_expected_draft_revision bigint,
  p_actor text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month public.settlement_intake_months;
  v_count integer;
  v_distinct integer;
  v_draft_count integer;
  v_revision bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement_intake:' || p_intake_id::text, 0));

  select * into v_month
  from public.settlement_intake_months
  where id = p_intake_id
  for no key update;
  if not found then
    raise exception 'unknown settlement intake %', p_intake_id;
  end if;
  if v_month.draft_revision <> p_expected_draft_revision then
    raise exception 'stale draft revision for intake %: expected %, have %',
      p_intake_id, p_expected_draft_revision, v_month.draft_revision;
  end if;

  if p_object_ids is not null
     and pg_catalog.cardinality(p_object_ids) > 0
     and pg_catalog.array_ndims(p_object_ids) <> 1
  then
    raise exception 'reorder for intake % requires a one-dimensional object-id array', p_intake_id;
  end if;
  v_count := coalesce(pg_catalog.cardinality(p_object_ids), 0);
  if v_count < 1 or v_count > 200 then
    raise exception 'reorder for intake % must supply between 1 and 200 object ids', p_intake_id;
  end if;
  if exists (select 1 from pg_catalog.unnest(p_object_ids) x where x is null) then
    raise exception 'reorder for intake % contains a null object id', p_intake_id;
  end if;
  select count(distinct x) into v_distinct from pg_catalog.unnest(p_object_ids) x;
  if v_distinct <> v_count then
    raise exception 'reorder for intake % contains duplicate object ids', p_intake_id;
  end if;

  select count(*) into v_draft_count
  from public.settlement_intake_draft_entries
  where intake_id = p_intake_id;
  if v_draft_count <> v_count or exists (
    select 1
    from pg_catalog.unnest(p_object_ids) x
    left join public.settlement_intake_draft_entries d
      on d.intake_id = p_intake_id and d.object_id = x
    where d.id is null
  ) then
    raise exception 'reorder for intake % must list exactly the current draft entries', p_intake_id;
  end if;

  -- Defer the per-intake position uniqueness so a full 200-entry reorder can
  -- be applied as one statement; the new positions are a dense 0..n-1
  -- permutation, so the constraint holds again at commit.
  set constraints public.settlement_intake_draft_entries_position_uniq deferred;

  update public.settlement_intake_draft_entries d
     set position = u.ord::integer - 1,
         revision = d.revision + 1,
         updated_at = pg_catalog.now()
    from pg_catalog.unnest(p_object_ids) with ordinality as u(object_id, ord)
   where d.intake_id = p_intake_id
     and d.object_id = u.object_id;

  update public.settlement_intake_months
     set draft_revision = draft_revision + 1
   where id = p_intake_id
  returning draft_revision into v_revision;

  insert into public.settlement_intake_audit (intake_id, actor, action, detail)
  values (p_intake_id, p_actor, 'draft_reordered',
          pg_catalog.jsonb_build_object('object_count', v_count));

  return v_revision;
end;
$$;

create or replace function submit_settlement_intake_version(
  p_intake_id uuid,
  p_expected_draft_revision bigint,
  p_actor text
)
returns public.settlement_intake_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month public.settlement_intake_months;
  v_existing public.settlement_intake_versions;
  v_version public.settlement_intake_versions;
  v_manifest text;
  v_manifest_sha256 char(64);
  v_file_count integer;
  v_total_size bigint;
  v_version_no integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('settlement_intake:' || p_intake_id::text, 0));

  select * into v_month
  from public.settlement_intake_months
  where id = p_intake_id
  for no key update;
  if not found then
    raise exception 'unknown settlement intake %', p_intake_id;
  end if;
  if v_month.draft_revision <> p_expected_draft_revision then
    raise exception 'stale draft revision for intake %: expected %, have %',
      p_intake_id, p_expected_draft_revision, v_month.draft_revision;
  end if;

  -- Unambiguous manifest: an ordered JSON array (one object per entry, keys
  -- deterministically ordered by jsonb) covering position, object_id, and
  -- every frozen snapshot field.
  select
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'position', d.position,
        'object_id', o.id,
        'path_key', o.path_key,
        'display_name', o.display_name,
        'size_bytes', o.expected_size_bytes,
        'sha256', o.expected_sha256,
        'storage_path', o.storage_path
      )
      order by d.position
    )::text,
    count(*)::integer,
    coalesce(sum(o.expected_size_bytes), 0)
  into v_manifest, v_file_count, v_total_size
  from public.settlement_intake_draft_entries d
  join public.settlement_intake_objects o on o.id = d.object_id
  where d.intake_id = p_intake_id;

  if v_file_count = 0 then
    raise exception 'cannot submit an empty draft for intake %', p_intake_id;
  end if;

  if exists (
    select 1
    from public.settlement_intake_draft_entries d
    join public.settlement_intake_objects o on o.id = d.object_id
    where d.intake_id = p_intake_id and o.status <> 'finalized'
  ) then
    raise exception 'draft for intake % contains non-finalized objects', p_intake_id;
  end if;

  v_manifest_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_manifest, 'UTF8')), 'hex');

  -- Idempotent replay: the same manifest returns the already-submitted version.
  select * into v_existing
  from public.settlement_intake_versions
  where intake_id = p_intake_id and manifest_sha256 = v_manifest_sha256;
  if found then
    return v_existing;
  end if;

  select coalesce(max(version_no), 0) + 1 into v_version_no
  from public.settlement_intake_versions
  where intake_id = p_intake_id;

  insert into public.settlement_intake_versions
    (intake_id, version_no, file_count, total_size_bytes, manifest_sha256, submitted_by)
  values (p_intake_id, v_version_no, v_file_count, v_total_size, v_manifest_sha256, p_actor)
  returning * into v_version;

  insert into public.settlement_intake_version_files
    (version_id, object_id, position, path_key, display_name, size_bytes, sha256, storage_path)
  select v_version.id, o.id, d.position, o.path_key, o.display_name,
         o.expected_size_bytes, o.expected_sha256, o.storage_path
  from public.settlement_intake_draft_entries d
  join public.settlement_intake_objects o on o.id = d.object_id
  where d.intake_id = p_intake_id
  order by d.position;

  insert into public.settlement_intake_audit (intake_id, actor, action, detail)
  values (p_intake_id, p_actor, 'version_submitted',
          pg_catalog.jsonb_build_object('version_id', v_version.id, 'version_no', v_version_no));

  return v_version;
end;
$$;

-- Security --------------------------------------------------------------------

alter table settlement_intake_months enable row level security;
alter table settlement_intake_objects enable row level security;
alter table settlement_intake_draft_entries enable row level security;
alter table settlement_intake_audit enable row level security;
alter table settlement_intake_versions enable row level security;
alter table settlement_intake_version_files enable row level security;

-- Migration 028 grants service_role ALL on future public tables and sequences
-- via ALTER DEFAULT PRIVILEGES. Compose with it explicitly: intake tables are
-- read-only for every client role, so audit, draft revisions, and
-- immutability cannot be bypassed by direct DML — all writes go through the
-- SECURITY DEFINER RPCs above.
revoke all on table settlement_intake_months from public, anon, authenticated, service_role;
revoke all on table settlement_intake_objects from public, anon, authenticated, service_role;
revoke all on table settlement_intake_draft_entries from public, anon, authenticated, service_role;
revoke all on table settlement_intake_audit from public, anon, authenticated, service_role;
revoke all on table settlement_intake_versions from public, anon, authenticated, service_role;
revoke all on table settlement_intake_version_files from public, anon, authenticated, service_role;

grant select on table settlement_intake_months to service_role;
grant select on table settlement_intake_objects to service_role;
grant select on table settlement_intake_draft_entries to service_role;
grant select on table settlement_intake_audit to service_role;
grant select on table settlement_intake_versions to service_role;
grant select on table settlement_intake_version_files to service_role;

revoke all on sequence settlement_intake_audit_id_seq from public, anon, authenticated, service_role;

revoke all on function settlement_intake_path_key_ok(text) from public, anon, authenticated;
revoke all on function create_settlement_intake(text, text) from public, anon, authenticated;
revoke all on function register_settlement_intake_object(uuid, text, text, text, bigint, text, text) from public, anon, authenticated;
revoke all on function finalize_settlement_intake_object(uuid, bigint, text, text) from public, anon, authenticated;
revoke all on function quarantine_settlement_intake_object(uuid, text, text) from public, anon, authenticated;
revoke all on function upsert_settlement_intake_draft_entry(uuid, uuid, integer, bigint, text) from public, anon, authenticated;
revoke all on function remove_settlement_intake_draft_entry(uuid, uuid, bigint, text) from public, anon, authenticated;
revoke all on function reorder_settlement_intake_draft(uuid, uuid[], bigint, text) from public, anon, authenticated;
revoke all on function submit_settlement_intake_version(uuid, bigint, text) from public, anon, authenticated;

grant execute on function create_settlement_intake(text, text) to service_role;
grant execute on function register_settlement_intake_object(uuid, text, text, text, bigint, text, text) to service_role;
grant execute on function finalize_settlement_intake_object(uuid, bigint, text, text) to service_role;
grant execute on function quarantine_settlement_intake_object(uuid, text, text) to service_role;
grant execute on function upsert_settlement_intake_draft_entry(uuid, uuid, integer, bigint, text) to service_role;
grant execute on function remove_settlement_intake_draft_entry(uuid, uuid, bigint, text) to service_role;
grant execute on function reorder_settlement_intake_draft(uuid, uuid[], bigint, text) to service_role;
grant execute on function submit_settlement_intake_version(uuid, bigint, text) to service_role;

commit;

-- rollback (manual — run as ONE transaction; schema objects only):
--   begin;
--   drop trigger trg_settlement_intake_version_files_source on settlement_intake_version_files;
--   drop trigger trg_settlement_intake_version_files_immutable on settlement_intake_version_files;
--   drop trigger trg_settlement_intake_versions_immutable on settlement_intake_versions;
--   drop trigger trg_settlement_intake_audit_immutable on settlement_intake_audit;
--   drop trigger trg_settlement_intake_objects_guard on settlement_intake_objects;
--   drop function submit_settlement_intake_version(uuid, bigint, text);
--   drop function reorder_settlement_intake_draft(uuid, uuid[], bigint, text);
--   drop function remove_settlement_intake_draft_entry(uuid, uuid, bigint, text);
--   drop function upsert_settlement_intake_draft_entry(uuid, uuid, integer, bigint, text);
--   drop function quarantine_settlement_intake_object(uuid, text, text);
--   drop function finalize_settlement_intake_object(uuid, bigint, text, text);
--   drop function register_settlement_intake_object(uuid, text, text, text, bigint, text, text);
--   drop function create_settlement_intake(text, text);
--   drop function settlement_intake_version_files_check_source();
--   drop function settlement_intake_objects_guard();
--   drop function settlement_intake_forbid_change();
--   drop table settlement_intake_version_files;
--   drop table settlement_intake_versions;
--   drop table settlement_intake_audit;
--   drop table settlement_intake_draft_entries;
--   drop table settlement_intake_objects;
--   drop table settlement_intake_months;
--   drop function settlement_intake_path_key_ok(text);
--   commit;
--
-- The 'settlement-intake' storage bucket and its uploaded objects are
-- retained by default so no source data is lost on rollback. Removing the
-- bucket is a separate, deliberate operation: empty the bucket through the
-- Storage API first, then remove the bucket row explicitly. Never remove the
-- bucket unconditionally as part of a schema rollback.
