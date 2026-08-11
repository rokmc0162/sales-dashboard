# Settlement Worker Operations

The settlement worker is a user LaunchAgent on the Mac mini. It polls the private Supabase queue, processes jobs from the SSD-backed repository, and opens no inbound port.

## Paths and credentials

- Repository: `/Volumes/SSD_MacMini_2/HermesWork/rvjp-human-system-diff-ui`
- Logs: `~/Library/Logs/Riverse/settlement-worker`
- LaunchAgent: `~/Library/LaunchAgents/com.riverse.settlement-worker.plist`
- Installed environment: `~/Library/Application Support/Riverse/settlement-worker/worker.env`
- Installed runtime: `~/Library/Application Support/Riverse/settlement-worker/runtime`

Repository `.env.local` must define `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_DATABASE_URL`, and a server-only Supabase service-role key. The service-role key resolves in the same order as the web server code: `RVJP_DB_ADMIN_TOKEN` first, then `RVJP_SUPABASE_SERVICE_ROLE_KEY`, then `SUPABASE_SERVICE_ROLE_KEY`. The installer copies only those three values into the mode-0600 installed environment file (the resolved service-role key is written under the canonical `RVJP_DB_ADMIN_TOKEN` name); it never prints them or embeds them in the plist.

The service-role key is used for the prepared-upload data pipeline, monthly record loading, and private Storage. Claiming and protected queue state use the direct Postgres URL. The worker never falls back to `NEXT_PUBLIC_SUPABASE_ANON_KEY` and refuses to start without a service-role key. This key stays on the Mac mini only: do not commit `.env.local`, and do not expose the key to the browser or any `NEXT_PUBLIC_` name.

## Pre-install checks

1. Confirm migrations `022_settlement_worker_jobs.sql`, `023_fix_settlement_worker_artifact_path.sql`, and `024_release_settlement_worker_job.sql` have already been reviewed and applied through the normal database change process. The installer does not apply SQL.
2. Install project dependencies in the repository.
3. Confirm `.env.local` contains the URL, database URL, and a service-role key under one of the accepted names.
4. Run the deterministic worker tests:

   ```sh
   npm run test:settlement-worker
   ```

5. Optionally verify one idle claim cycle without installing a service:

   ```sh
   npm run settlement:worker:once
   ```

`--once` still contacts the configured database and may claim one queued job, so use it only when that is intended.

## Install or update

From the repository root:

```sh
sh scripts/install-settlement-worker.sh
```

The installer validates Node.js 20+, the fixed SSD repository, installed runtime dependencies, `.env.local`, and the exact URL/service-role/DB variable names. It stages an atomic runtime bundle, backs up the prior runtime, plist, and installed `worker.env`, installs the user LaunchAgent, and starts it. Any failure after service transition begins restores all three prior files and restarts the previous LaunchAgent when it was running. It does not print or embed credentials.

The service runs:

```text
node --env-file=~/Library/Application\ Support/Riverse/settlement-worker/worker.env ~/Library/Application\ Support/Riverse/settlement-worker/runtime/src/features/settlement/lib/worker/settlement-worker.bundle.mjs
```

`KeepAlive` restarts it after exit, with a 30-second launchd throttle to avoid a rapid crash loop. `ExitTimeOut` gives the worker 30 seconds to reach its checkpoint and close the Postgres connection on termination.

## Status, logs, and restart

```sh
launchctl print "gui/$(id -u)/com.riverse.settlement-worker"
tail -n 100 "$HOME/Library/Logs/Riverse/settlement-worker/stdout.log"
tail -n 100 "$HOME/Library/Logs/Riverse/settlement-worker/stderr.log"
launchctl kickstart -k "gui/$(id -u)/com.riverse.settlement-worker"
```

Logs contain job IDs, outcomes, and bounded counts, not credentials or source record contents. Monitor their size as part of host maintenance and rotate them in the SSD log directory according to the host's retention policy.

## Stop or remove

Stop without deleting the plist:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.riverse.settlement-worker.plist"
```

After stopping, remove the plist only if the service is intentionally being uninstalled. Re-running the installer restores and starts it.

## Failure handling

- SIGTERM/SIGINT waits for the current safe checkpoint and immediately requeues the job when no file is `processing`.
- A crash while a file is still `processing` does not release the job. Its lease expires normally and reclaim remains fail-safe for manual review.
- A per-file failure does not stop the remaining files. The job ends as `completed_with_warnings` when workbook generation and validation still succeed.
- A workbook validation failure ends the job as `failed` and does not publish the candidate artifact.
- If the web polling window expires, refresh the selected month. The authenticated latest-job endpoint recovers the active or most recent job without browser persistence.

## Current transactional boundary

This release writes per-file sales records before workbook validation. Job-scoped staging plus atomic monthly promotion remains a required follow-up before the workflow can be described as fully transactional.
