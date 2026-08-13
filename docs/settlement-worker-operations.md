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

## Version processing and backup transport

Version processing is off by default. `SETTLEMENT_VERSION_PROCESSING_ENABLED=true` enables it in loop mode, and the worker then refuses to start unless both of the following are also configured:

- `SETTLEMENT_VERSION_WORK_ROOT` — run scratch directory; must resolve to a dedicated directory under `/Volumes/SSD_MacMini_2` (SSD2).
- `SETTLEMENT_BACKUP_TRANSPORT` — `local-sync` or `google-drive-api`; any other value fails startup. When unset, the legacy `SETTLEMENT_DRIVE_BACKUP_ENABLED=true` still selects `google-drive-api`.

The worker fails closed: a version run is never claimed unless its verified artifacts can be backed up through the configured transport.

### local-sync transport

`SETTLEMENT_BACKUP_TRANSPORT=local-sync` archives each verified run into the Google Drive Desktop sync mount instead of calling the Drive API. It requires `SETTLEMENT_LOCAL_SYNC_ROOT`, an absolute directory under `/Volumes/SSD_MacMini/CLINK_YANGIL_GoogleDrive`. The worker re-validates that boundary at archive time and rejects symlinked or out-of-root paths.

Each run archives to `<root>/YYYY-MM/vNNN-<sourceVersionId>/run-<runId>/` containing:

- `manifest.json` — copy of the run snapshot manifest
- `원본/<original relative path>` — every source file, verified against the snapshot manifest size and SHA-256 during the copy
- `결과/office-verified.xlsx` and `결과/evidence.json` — the verified workbook and its evidence
- `archive-evidence.json` — sidecar listing every archived file with size and SHA-256; the sidecar's own SHA-256 is recorded in the database

Creation is atomic: files are copied and fsynced into a hidden temp directory inside the version directory, then a single rename publishes the run directory. Replay after a crash or requeue is idempotent — when the run directory already exists, the worker re-hashes it against the expected evidence and reuses it. Any byte or metadata mismatch is an archive conflict that fails the run for manual review; existing archive content is never overwritten. A source file that changes mid-copy also fails the run. Archive success is recorded by `verify_settlement_local_sync_archive` (migration `035_settlement_local_sync_backups.sql`) under the same claim-token fence as the rest of the run, as a `local_sync` row alongside the existing Drive API backup rows.

### google-drive-api transport

`SETTLEMENT_BACKUP_TRANSPORT=google-drive-api` keeps the existing Google Drive API backup path using the `GOOGLE_DRIVE_CLIENT_EMAIL`, `GOOGLE_DRIVE_PRIVATE_KEY`, `GOOGLE_DRIVE_SHARED_DRIVE_ID`, and `GOOGLE_DRIVE_BACKUP_ROOT_FOLDER_ID` credentials. It remains available as the fallback transport when the local sync mount is not used.

### Verification

```sh
npm run test:settlement-local-sync-archive
npm run test:settlement-worker
psql "$SUPABASE_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/test-035-settlement-local-sync-backups.sql
```

The SQL smoke runs in one transaction and rolls back. Never drive a fake intake through the production pipeline outside that rollback: publication evidence is immutable once a run publishes, so fake data cannot be cleaned up afterwards.

## Pre-install checks

1. Confirm migrations `022_settlement_worker_jobs.sql`, `023_fix_settlement_worker_artifact_path.sql`, and `024_release_settlement_worker_job.sql` have already been reviewed and applied through the normal database change process. Version processing with the local-sync transport additionally requires `035_settlement_local_sync_backups.sql`. The installer does not apply SQL.
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

On reinstall the installer re-serializes the optional version-processing and backup keys (`SETTLEMENT_VERSION_PROCESSING_ENABLED`, `SETTLEMENT_BACKUP_TRANSPORT`, `SETTLEMENT_LOCAL_SYNC_ROOT`, `SETTLEMENT_VERSION_WORK_ROOT`, and the Drive API credentials) into the mode-0600 `worker.env`: a fresh nonempty value from the process environment or `.env.local` wins, otherwise the previously installed value survives. A legacy `SETTLEMENT_DRIVE_BACKUP_ENABLED=true` with no explicit transport is migrated to `SETTLEMENT_BACKUP_TRANSPORT=google-drive-api`.

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
