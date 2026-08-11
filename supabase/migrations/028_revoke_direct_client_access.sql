begin;

-- Apply only after the Auth0-protected API deployment is live and
-- SUPABASE_SERVICE_ROLE_KEY is present in the runtime environment.
-- Auth0 is the sole application identity boundary; browser Supabase roles must
-- not bypass it through PostgREST, RPC, views, sequences, or Storage policies.

do $block$
declare
  policy_record record;
begin
  for policy_record in
    select schemaname, tablename, policyname
    from pg_policies
    where (
      schemaname = 'public'
      or (schemaname = 'storage' and tablename = 'objects')
    )
      and (
        'public' = any(roles)
        or 'anon' = any(roles)
        or 'authenticated' = any(roles)
      )
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policy_record.policyname,
      policy_record.schemaname,
      policy_record.tablename
    );
  end loop;
end
$block$;

revoke all privileges on all tables in schema public from public, anon, authenticated;
revoke all privileges on all sequences in schema public from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public
  revoke all privileges on tables from public, anon, authenticated;
alter default privileges in schema public
  revoke all privileges on sequences from public, anon, authenticated;
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public
  grant all privileges on tables to service_role;
alter default privileges in schema public
  grant all privileges on sequences to service_role;
alter default privileges in schema public
  grant execute on functions to service_role;

-- Browser-role Storage policies were catalog-dropped above. Signed upload and
-- download capabilities are issued only by Auth0-protected API routes.

commit;
