begin;

create table if not exists public.auth_rate_limits (
  limiter_key text primary key,
  window_started_at timestamptz not null,
  attempts integer not null check (attempts > 0)
);

create index if not exists auth_rate_limits_window_started_at_idx
  on public.auth_rate_limits (window_started_at);

alter table public.auth_rate_limits enable row level security;

revoke all privileges on table public.auth_rate_limits from public, anon, authenticated;
grant all privileges on table public.auth_rate_limits to service_role;

create or replace function public.consume_forgot_password_rate_limit(
  p_key text,
  p_limit integer default 5,
  p_window_seconds integer default 600
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  current_attempts integer;
  current_window timestamptz;
  current_time timestamptz := clock_timestamp();
begin
  if p_key is null or length(p_key) <> 64 or p_limit < 1 or p_window_seconds < 1 then
    raise exception 'invalid rate-limit input';
  end if;

  insert into public.auth_rate_limits as limits (
    limiter_key,
    window_started_at,
    attempts
  ) values (
    p_key,
    current_time,
    1
  )
  on conflict (limiter_key) do update
  set
    window_started_at = case
      when limits.window_started_at + make_interval(secs => p_window_seconds) <= current_time
        then current_time
      else limits.window_started_at
    end,
    attempts = case
      when limits.window_started_at + make_interval(secs => p_window_seconds) <= current_time
        then 1
      else limits.attempts + 1
    end
  returning attempts, window_started_at
  into current_attempts, current_window;

  -- Bound cleanup work while preventing distinct hashed IP keys from
  -- accumulating forever. The current key cannot qualify after the upsert.
  delete from public.auth_rate_limits
  where window_started_at < current_time - interval '1 day'
    and limiter_key in (
    select limiter_key
    from public.auth_rate_limits
    where window_started_at < current_time - interval '1 day'
    order by window_started_at
    limit 100
  );

  if current_attempts > p_limit then
    return greatest(
      1,
      ceil(extract(epoch from (
        current_window + make_interval(secs => p_window_seconds) - current_time
      )))::integer
    );
  end if;

  return null;
end
$function$;

revoke execute on function public.consume_forgot_password_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_forgot_password_rate_limit(text, integer, integer)
  to service_role;

commit;
