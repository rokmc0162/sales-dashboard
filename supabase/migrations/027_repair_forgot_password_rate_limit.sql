begin;

-- Repair for databases where 026 was applied with PL/pgSQL variables named
-- current_attempts/current_window/current_time. Inside the embedded INSERT the
-- name current_time resolved to the SQL CURRENT_TIME expression (time with
-- time zone), so the function failed at execution time. This migration only
-- replaces consume_forgot_password_rate_limit with unambiguous v_ names; it is
-- idempotent and safe on fresh installs that already ran the corrected 026.

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
  v_attempts integer;
  v_window_started_at timestamptz;
  v_now timestamptz := clock_timestamp();
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
    v_now,
    1
  )
  on conflict (limiter_key) do update
  set
    window_started_at = case
      when limits.window_started_at + make_interval(secs => p_window_seconds) <= v_now
        then v_now
      else limits.window_started_at
    end,
    attempts = case
      when limits.window_started_at + make_interval(secs => p_window_seconds) <= v_now
        then 1
      else limits.attempts + 1
    end
  returning attempts, window_started_at
  into v_attempts, v_window_started_at;

  -- Bound cleanup work while preventing distinct hashed IP keys from
  -- accumulating forever. The current key cannot qualify after the upsert.
  delete from public.auth_rate_limits
  where window_started_at < v_now - interval '1 day'
    and limiter_key in (
    select limiter_key
    from public.auth_rate_limits
    where window_started_at < v_now - interval '1 day'
    order by window_started_at
    limit 100
  );

  if v_attempts > p_limit then
    return greatest(
      1,
      ceil(extract(epoch from (
        v_window_started_at + make_interval(secs => p_window_seconds) - v_now
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
