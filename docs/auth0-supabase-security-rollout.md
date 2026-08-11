# Auth0 + Supabase security rollout

Production deployment is blocked until every step below is verified. Never print or copy secret values into logs, chat, source files, or shell history.

## Required order

1. Apply `025_add_upload_log_storage_path.sql`.
2. Apply `026_shared_forgot_password_rate_limit.sql`.
3. Apply `027_repair_forgot_password_rate_limit.sql`. It replaces `consume_forgot_password_rate_limit` with unambiguous `v_`-prefixed variables (the original 026 body failed at execution because `current_time` resolved to the SQL `CURRENT_TIME` expression). Idempotent; required on databases that ran the original 026 and harmless on fresh installs.
4. Add `RVJP_DB_ADMIN_TOKEN` as a **Sensitive**, server-only Vercel environment variable for the required environments. Vercel Preview filters env names containing `SERVICE_ROLE_KEY`, so this alias must not contain that substring. (Server clients resolve the key in exactly this order: `RVJP_DB_ADMIN_TOKEN` first, then `RVJP_SUPABASE_SERVICE_ROLE_KEY`, then plain `SUPABASE_SERVICE_ROLE_KEY` as compatibility fallbacks. They never fall back to anon/public keys.)
5. Confirm Auth0 variables exist in the same Vercel environment scope and mark client secrets Sensitive.
6. Deploy the Auth0-protected application code.
7. Smoke-test with real Auth0 identities:
   - global `ADMIN`
   - `settlement_admin`
   - `settlement_operator`
   - unauthenticated and cross-origin requests
8. Verify upload log read/write, debug signed upload/download/cleanup, and forgot-password shared limiting (a live forgot-password call must succeed, confirming the repaired limiter function executes without the `current_time` collision).
9. Apply `028_revoke_direct_client_access.sql`.
10. Verify with the public anon key that protected tables, views, and RPC functions are denied.
11. Re-run authenticated dashboard, management, sales upload, settlement preview/export, and reset smoke tests.

## Rollback rule

Do not apply migration 028 until steps 1–8 pass. If the code deployment fails before 028, roll back the code while leaving additive migrations 025–027 in place. If a failure occurs after 028, restore the last verified application deployment; do not restore broad anon policies as a shortcut.

## Known safe behavior

- `replaceMonth=1` returns HTTP 409. Automatic pre-delete is disabled until an atomic staging-and-swap workflow exists.
- Missing service-role configuration fails closed.
- Missing trusted Vercel client IP or unavailable shared limiter makes forgot-password return 503 rather than sending an unlimited request.
