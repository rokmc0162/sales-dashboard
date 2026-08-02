# Settlement Mac mini Worker Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Move long-running settlement parsing from synchronous Vercel requests into a durable Supabase queue processed by a Mac mini worker, while reusing current parsers and keeping the existing operator web flow.

**Architecture:** The browser uploads immutable files directly to private Supabase Storage, then creates one monthly job containing all upload IDs. A native macOS worker claims queued jobs through a lease-based PostgreSQL RPC, runs the existing prepared-upload parser pipeline for each file, generates and reopens the monthly workbook, stores bounded progress/results, and the web polls an authenticated job-status API. The first release preserves current per-file sales-record writes; atomic staging/promotion is the next safety milestone and must remain explicitly documented.

**Tech Stack:** Next.js 16, React 19, TypeScript, Supabase/PostgreSQL/Storage, existing `parseFile`/`toSalesRecords`/INPUT V2 exporter, Node/tsx, macOS launchd, LibreOffice headless availability.

---

### Task 1: Add durable job queue schema

**Objective:** Create lease-based job and job-file tables with service-role-only worker RPCs and authenticated read protection through API routes.

**Files:**
- Create: `supabase/migrations/022_settlement_worker_jobs.sql`
- Create/Test: `scripts/test-settlement-worker-queue.ts`
- Modify: `package.json`

**Steps:**
1. Add failing schema-contract tests for statuses, RLS, `claim_settlement_job`, lease recovery, and bounded safe result columns.
2. Create `settlement_jobs` and `settlement_job_files` with UUID keys, month, status/stage/progress, worker lease/heartbeat, parser/rule versions, bounded error/summary fields, timestamps, and indexes.
3. Create `claim_settlement_job(worker_id, lease_seconds)` using `FOR UPDATE SKIP LOCKED`; queued jobs and expired claimed/processing jobs are claimable.
4. Create heartbeat/update RPC safeguards or equivalent compare-and-update contract. Revoke public/anon/authenticated execution; grant only service role.
5. Enable RLS; do not add direct client policies. The authenticated web accesses only safe API projections.
6. Run the schema-contract test and SQL parse/apply checks.

### Task 2: Extract reusable prepared-upload processor

**Objective:** Make the current Vercel prepared-upload logic callable from both the API route and local worker without duplication or behavioral regression.

**Files:**
- Create: `src/features/settlement/lib/worker/process-prepared-upload.ts`
- Modify: `app/api/settlement/upload/route.ts`
- Create/Test: `scripts/test-settlement-worker-processor.ts`

**Steps:**
1. Add tests proving result classification and wrapper response behavior.
2. Move prepared-upload download/claim, exact-SHA duplicate gate, lookup loading, parsing, raw record insertion, transform, strict duplicate suppression, and upload status updates into a dependency-injected service.
3. Keep multipart behavior and public API body semantics unchanged.
4. Make the route call the service and return the same `{results:[...]}` shape.
5. Run existing direct-upload, parser, duplicate, heartbeat, and type tests.

### Task 3: Add authenticated job APIs

**Objective:** Let the web enqueue one monthly job after direct uploads and poll a privacy-safe status projection.

**Files:**
- Create: `app/api/settlement/jobs/route.ts`
- Create: `app/api/settlement/jobs/[id]/route.ts`
- Create: `src/features/settlement/lib/worker/job-contract.ts`
- Create/Test: `scripts/test-settlement-job-api.ts`

**Steps:**
1. Validate month, 1–200 unique upload IDs, positions, and bounded folder hints.
2. Verify every upload exists, remains `uploaded`, belongs to the selected month, and has a safe Storage path.
3. Insert one job and ordered job files; reject duplicate assignment.
4. GET returns only job progress, bounded summaries, and per-file filename/status/result/error; never raw records, Storage tokens/paths, amounts, or service credentials.
5. Require existing settlement API auth on every route.
6. Test malformed IDs, cross-month files, duplicates, projection safety, and terminal status detection.

### Task 4: Build the Mac mini worker

**Objective:** Process queued jobs locally with leases, file-level isolation, workbook validation, and crash-safe status updates.

**Files:**
- Create: `scripts/settlement-worker.ts`
- Create: `src/features/settlement/lib/worker/run-job.ts`
- Create: `scripts/test-settlement-worker-runner.ts`
- Modify: `package.json`

**Steps:**
1. Require `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_DATABASE_URL`; use the anon key only for the existing data/Storage path and direct Postgres only for protected queue state. Do not require or fall back to an unrelated service-role key.
2. Support `--once` and continuous loop modes with configurable safe polling interval and worker ID.
3. Claim one job atomically, set progress, process ordered files through the reusable processor, and continue after individual file failures.
4. Update job-file status/result with bounded privacy-safe metrics only; heartbeat/renew lease between stages.
5. Load monthly INPUT records, generate the real workbook, reopen it with ExcelJS, store the candidate under an ASCII job-artifact Storage path, and record row/sheet counts without amounts/titles.
6. Mark `completed`, `completed_with_warnings`, or `failed`; preserve a bounded error summary.
7. Make SIGTERM stop after the current safe checkpoint and recover expired leases.
8. Add deterministic dependency-injected tests for success, partial file failure, validation failure, lease loss, and bounded outputs.

### Task 5: Connect the operator web flow

**Objective:** Replace per-file synchronous parse calls with upload-all → enqueue-one-job → poll-status while preserving the same month selection and understandable progress UI.

**Files:**
- Modify: `src/features/settlement/lib/storage/direct-upload-client.ts`
- Modify: `src/features/settlement/components/SettlementClient.tsx`
- Create/Test: `scripts/test-settlement-worker-ui.ts`

**Steps:**
1. Split direct Storage transfer from synchronous processing while retaining the old helper only for legacy tests/fallback.
2. Upload every selected file to Storage, collecting upload IDs and each parent-folder hint.
3. Create one job after all successful transfers; report transfer failures separately.
4. Poll job status with abort/timeout safety and show `업로드 → 대기 → 파싱 N/M → Excel 검증 → 완료/검토 필요`.
5. Refresh month/platform state only after a successful terminal job.
6. On refresh/navigation, load the latest nonterminal job for the selected month so progress is not lost.
7. Keep file contents and monetary values out of browser local storage and status text.
8. Add UI contract tests and run lint/type/build.

### Task 6: Install and verify the Mac service

**Objective:** Run the worker on Mac restart without exposing ports or secrets and prove a real queued job completes.

**Files:**
- Create: `ops/com.riverse.settlement-worker.plist.template`
- Create: `scripts/install-settlement-worker.sh`
- Create: `docs/settlement-worker-operations.md`

**Steps:**
1. Create a user LaunchAgent template that runs from the SSD2 repo, reads `.env.local`, writes bounded logs to SSD2, and restarts on failure with throttling.
2. Installer expands paths without embedding credentials and validates executable/repo/env prerequisites.
3. Apply migration 022 non-destructively to the existing production database.
4. Start the worker and prove idle `--once` exits cleanly.
5. Create a non-destructive duplicate-source test upload/job, let the worker claim it, verify duplicate skip, workbook generation/reopen, terminal status, and no duplicate sales rows.
6. Run all settlement tests, lint/typecheck/build, independent Codex review, commit/push, deploy the existing Vercel project, and verify the canonical production alias.
7. Record the deferred safety milestone: job-scoped staging plus atomic promotion, required before claiming fully transactional monthly replacement.

## Acceptance gates

- Existing synchronous endpoint behavior remains regression-compatible during migration.
- Browser upload no longer waits on long Vercel parsing after cutover.
- Mac mini worker uses a mode-0600 installed environment with anon Storage access plus direct Postgres queue access and exposes no inbound port.
- Queue claim is atomic and expired leases are recoverable.
- Every job/file status is bounded and privacy-safe.
- Real production Storage file can be processed through a queued Mac worker job.
- Generated workbook reopens successfully and output artifact is private.
- No exact duplicate sales rows are inserted during the verification job.
- Full tests, TypeScript, lint for changed files, production build, independent review, Git push, Vercel Ready, and canonical-host browser check pass.
- Atomic staging/promotion is explicitly PARTIAL until implemented in the next milestone.
