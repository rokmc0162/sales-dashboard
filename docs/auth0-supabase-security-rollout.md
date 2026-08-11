# Auth0 + Supabase security rollout

Production deployment is blocked until every step below is verified. Never print or copy secret values into logs, chat, source files, or shell history.

## Required order

1. Apply `025_add_upload_log_storage_path.sql`.
2. Apply `026_shared_forgot_password_rate_limit.sql`.
3. Add `RVJP_SUPABASE_SERVICE_ROLE_KEY` as a **Sensitive**, server-only Vercel environment variable for the required environments. (Server clients prefer the `RVJP_` alias and treat plain `SUPABASE_SERVICE_ROLE_KEY` as a compatibility fallback in any environment. They never fall back to anon/public keys.)
4. Confirm Auth0 variables exist in the same Vercel environment scope and mark client secrets Sensitive.
5. Deploy the Auth0-protected application code.
6. Smoke-test with real Auth0 identities:
   - global `ADMIN`
   - `settlement_admin`
   - `settlement_operator`
   - unauthenticated and cross-origin requests
7. Verify upload log read/write, debug signed upload/download/cleanup, and forgot-password shared limiting.
8. Apply `027_revoke_direct_client_access.sql`.
9. Verify with the public anon key that protected tables, views, and RPC functions are denied.
10. Re-run authenticated dashboard, management, sales upload, settlement preview/export, and reset smoke tests.

## Rollback rule

Do not apply migration 027 until steps 1–7 pass. If the code deployment fails before 027, roll back the code while leaving additive migrations 025–026 in place. If a failure occurs after 027, restore the last verified application deployment; do not restore broad anon policies as a shortcut.

## Known safe behavior

- `replaceMonth=1` returns HTTP 409. Automatic pre-delete is disabled until an atomic staging-and-swap workflow exists.
- Missing service-role configuration fails closed.
- Missing trusted Vercel client IP or unavailable shared limiter makes forgot-password return 503 rather than sending an unlimited request.
