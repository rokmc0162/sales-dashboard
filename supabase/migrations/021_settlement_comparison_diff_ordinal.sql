alter table settlement_comparison_diffs
  add column if not exists diff_ordinal integer;

with ranked as (
  select
    ctid,
    row_number() over (
      partition by run_id
      order by created_at, ctid
    ) - 1 as diff_ordinal
  from settlement_comparison_diffs
)
update settlement_comparison_diffs as diffs
set diff_ordinal = ranked.diff_ordinal
from ranked
where diffs.ctid = ranked.ctid
  and diffs.diff_ordinal is null;

alter table settlement_comparison_diffs
  alter column diff_ordinal set not null;

create unique index if not exists idx_comparison_diffs_run_ordinal
  on settlement_comparison_diffs (run_id, diff_ordinal);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'settlement_comparison_diffs_diff_ordinal_nonnegative'
      and conrelid = 'settlement_comparison_diffs'::regclass
  ) then
    alter table settlement_comparison_diffs
      add constraint settlement_comparison_diffs_diff_ordinal_nonnegative
      check (diff_ordinal >= 0);
  end if;
end
$$;
