-- ========================================================================
-- Settlement reconciliation: persistent difference investigations
-- ========================================================================
-- 1. settlement_comparison_diffs gains an investigation lifecycle
--    (investigation_status), the confirmed pipeline stage the root cause
--    lives in (root_cause_stage), and a free-text root-cause summary.
-- 2. settlement_comparison_comments holds the append-only discussion thread
--    per diff (operator questions, hermes answers, system notes).
-- Idempotent: column/table/index additions are guarded with "if not exists",
-- and every check constraint is named and added only when missing in
-- pg_constraint — so a partial earlier run (column added without its check)
-- is repaired instead of erroring or silently staying unconstrained.

alter table settlement_comparison_diffs
  add column if not exists investigation_status text not null default 'uninvestigated',
  add column if not exists root_cause_stage text,
  add column if not exists root_cause_summary text;

create table if not exists settlement_comparison_comments (
  id          uuid primary key default uuid_generate_v4(),
  diff_id     uuid not null references settlement_comparison_diffs(id) on delete cascade,
  author_type text not null,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_comparison_comments_diff_time
  on settlement_comparison_comments (diff_id, created_at);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'settlement_comparison_diffs_investigation_status_check'
      and conrelid = 'settlement_comparison_diffs'::regclass
  ) then
    alter table settlement_comparison_diffs
      add constraint settlement_comparison_diffs_investigation_status_check
      check (investigation_status in
        ('uninvestigated','question_pending','investigating','cause_confirmed',
         'fix_in_progress','verification_pending','resolved'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'settlement_comparison_diffs_root_cause_stage_check'
      and conrelid = 'settlement_comparison_diffs'::regclass
  ) then
    alter table settlement_comparison_diffs
      add constraint settlement_comparison_diffs_root_cause_stage_check
      check (root_cause_stage is null or root_cause_stage in
        ('source','upload','parser','transform','identity',
         'aggregation','carry','formula','human_workbook','unknown'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'settlement_comparison_diffs_root_cause_summary_check'
      and conrelid = 'settlement_comparison_diffs'::regclass
  ) then
    alter table settlement_comparison_diffs
      add constraint settlement_comparison_diffs_root_cause_summary_check
      check (root_cause_summary is null or char_length(root_cause_summary) <= 4000);
  end if;

  -- A confirmed-or-later status must carry an actual confirmed cause: a
  -- non-null stage and a non-blank summary.
  if not exists (
    select 1 from pg_constraint
    where conname = 'settlement_comparison_diffs_confirmed_requires_cause_check'
      and conrelid = 'settlement_comparison_diffs'::regclass
  ) then
    alter table settlement_comparison_diffs
      add constraint settlement_comparison_diffs_confirmed_requires_cause_check
      check (
        investigation_status not in
          ('cause_confirmed','fix_in_progress','verification_pending','resolved')
        or (root_cause_stage is not null
            and btrim(coalesce(root_cause_summary, '')) <> '')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'settlement_comparison_comments_author_type_check'
      and conrelid = 'settlement_comparison_comments'::regclass
  ) then
    alter table settlement_comparison_comments
      add constraint settlement_comparison_comments_author_type_check
      check (author_type in ('operator','hermes','system'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'settlement_comparison_comments_body_check'
      and conrelid = 'settlement_comparison_comments'::regclass
  ) then
    alter table settlement_comparison_comments
      add constraint settlement_comparison_comments_body_check
      check (btrim(body) <> '' and char_length(body) <= 4000);
  end if;
end $$;

-- RLS: same single-tenant policy as the rest of the settlement schema —
-- authenticated users only; no public/anonymous policy is created, so the
-- thread is never publicly readable. The thread is append-only, so only
-- SELECT and INSERT are granted — deliberately no UPDATE/DELETE policy.
-- Service-role routes bypass RLS as before.
alter table settlement_comparison_comments enable row level security;

drop policy if exists "authenticated full access" on settlement_comparison_comments;
drop policy if exists "authenticated select" on settlement_comparison_comments;
create policy "authenticated select" on settlement_comparison_comments
  for select using (auth.role() = 'authenticated');
drop policy if exists "authenticated insert" on settlement_comparison_comments;
create policy "authenticated insert" on settlement_comparison_comments
  for insert with check (auth.role() = 'authenticated');
