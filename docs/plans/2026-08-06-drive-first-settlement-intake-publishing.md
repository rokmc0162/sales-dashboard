# Google Drive-First Settlement Intake and Publishing Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 지정된 Google 공유드라이브 월별 작업 폴더를 정산 원본 투입함으로 사용하고, 웹 업로드·Drive UI 업로드를 같은 intake run으로 통합하며, Mac mini가 검증한 결과만 Supabase에 원자적으로 공개하도록 전환한다.

**Architecture:** Vercel은 인증, Drive 작업 폴더 생성, resumable upload session 발급, intake 상태 조회만 담당한다. 파일 bytes는 브라우저에서 Google Drive로 직접 전송하고, Mac mini가 Google Drive Desktop 동기화본을 SSD2 run snapshot으로 복사한 뒤 기존 parser·정규화·Excel generator를 실행한다. 모든 결과는 run별 staging에 저장하며 workbook/golden 검증 통과 후 월별 current publication pointer만 한 트랜잭션으로 전환한다. 웹은 공개된 run metadata·rows·artifact만 읽으며 원장을 요청마다 재조립하지 않는다.

**Tech Stack:** Next.js 16, React 19, TypeScript, Google Drive API v3 resumable upload, `google-auth-library`, Google Shared Drive, Google Drive Desktop, macOS LaunchAgent, SSD2 scratch, PostgreSQL/Supabase, ExcelJS, existing deterministic parser/workbook pipeline.

**Decision status:** 설계·계획 확정. 구현 착수 전 두 개의 외부 gate가 있다. (1) Google Cloud/공유드라이브 권한 및 실제 브라우저-origin resumable CORS spike, (2) 현재 임시 숫자 로그인과 고정 쿠키를 Drive write 권한에 사용하지 않도록 실제 운영자 세션·역할·CSRF/origin 검증을 먼저 마련하는 보안 gate. 실제 Drive 폴더·service identity·비밀값은 이 문서에 기록하지 않는다. 보안 gate 전에는 `DRIVE_UPLOAD_ENABLED=false`를 유지하고 Drive write API를 production에 노출하지 않는다.

---

## 1. 운영자 UX

### 흐름 A — 웹에서 지정 Drive 폴더로 업로드

1. `/settlement`에서 정산월을 선택한다.
2. `새 Drive 작업 폴더 만들기`를 누른다.
3. 서버가 지정 intake root 아래 `INBOX/YYYYMM/run_<opaque-id>` 폴더를 만든다.
4. 사용자가 웹에서 파일·폴더를 선택한다.
5. 서버는 파일마다 Google resumable session URI만 발급한다.
6. 브라우저가 Google에 직접 bytes를 전송하고 진행률·재개 상태를 표시한다.
7. 완료 API가 Drive file ID, parent folder, size, MIME, revision을 서버에서 재검증한다.
8. 모든 파일 완료 후 `업로드 완료·처리 시작`을 누른다.
9. intake run이 `ready`가 되고 Mac mini가 처리한다.

### 흐름 B — Google Drive 화면에서 직접 업로드

1. 웹에서 `새 Drive 작업 폴더 만들기`를 누른다.
2. `Google Drive에서 폴더 열기`를 눌러 지정 run 폴더를 연다.
3. 사용자가 Drive UI에서 파일을 넣는다.
4. 웹으로 돌아와 `Drive 파일 확인·처리 시작`을 누른다.
5. 서버가 해당 run 폴더만 list해 file ID/revision/size를 intake file로 등록한다.
6. 이후는 흐름 A와 동일하다.

### 비상 경로

- 현재 Supabase Storage 웹 업로드는 삭제하지 않는다.
- Google 인증·Drive 장애 때만 `수동 업로드(비상용)`으로 노출한다.
- Drive run과 Supabase fallback run은 동일한 staging/publication gate를 통과해야 한다.

---

## 2. 공유드라이브 폴더 구조

```text
<RIVERSE_SETTLEMENT_ROOT>/
├── INBOX/
│   └── YYYYMM/
│       ├── run_<opaque-id>/
│       │   ├── source files...
│       │   └── app-created metadata only
│       └── run_<opaque-id>/
├── OUTPUT/
│   └── YYYYMM/
│       └── JP_INPUT_<YYYYMM>_<version>.xlsx   # 선택적 운영 백업
└── REJECTED/
    └── YYYYMM/
        └── run_<opaque-id>/                   # 자동 이동은 MVP 이후
```

- 실제 폴더명보다 Drive folder ID를 식별자로 사용한다.
- worker는 지정 root 밖을 scan하지 않는다.
- Google 원본은 in-place 수정·LibreOffice 저장을 하지 않는다.
- OUTPUT 복사는 선택 사항이며 웹 다운로드 원본은 Supabase private artifact다.

---

## 3. 인증·보안 결정

### 권장 identity

- 전용 Google service account 또는 전용 Workspace robot account를 사용한다.
- 계정은 RIVERSE 정산 intake root에만 Contributor 이상 권한을 부여한다.
- 전체 회사 공유드라이브에는 멤버로 추가하지 않는다.
- 조직 정책이 service account 공유를 차단하면 Workspace robot OAuth refresh token 방식으로 전환한다.

### 서버 환경변수

```text
GOOGLE_DRIVE_CLIENT_EMAIL
GOOGLE_DRIVE_PRIVATE_KEY
GOOGLE_DRIVE_SHARED_DRIVE_ID
GOOGLE_DRIVE_INTAKE_ROOT_FOLDER_ID
GOOGLE_DRIVE_INTAKE_ROOT_URL
SETTLEMENT_DRIVE_SYNC_ROOT
```

- 값은 Vercel encrypted env와 Mac worker mode-0600 env에만 저장한다.
- Git, browser bundle, API JSON, logs, Discord에 값을 출력하지 않는다.
- 브라우저에는 만료 가능한 resumable session URI만 전달한다.
- session URI는 bearer-like 비밀로 취급해 localStorage·analytics·server log에 저장하지 않는다.
- 모든 Drive API route는 새 server-side operator/admin guard와 same-origin/CSRF 검증을 통과해야 한다.
- 공유드라이브 요청은 `supportsAllDrives=true`를 사용한다.

### Web write authorization gate

- 현재 `requireSettlementApiAuth`의 임시 고정 쿠키 비교는 Drive 생성·업로드·ready·rollback 권한으로 사용하지 않는다.
- Drive write 구현 전에 실제 로그인 세션의 server-side 검증, `settlement_operator`/`settlement_admin` 역할, 만료, actor ID를 도입한다.
- POST/PATCH/DELETE는 same-origin/CSRF token을 검증하고 rollback/publication audit에 actor를 기록한다.
- 기존 `raw_uploads`, `raw_records`, `sales_records`의 authenticated 직접 쓰기 권한을 철회한다. 필요한 읽기는 민감 컬럼을 제거한 safe view/API로 대체한 뒤 철회해 현재 화면을 깨뜨리지 않는다.
- auth migration이 완료되기 전 Drive route는 feature flag로 404/403 처리하며 session URI를 발급하지 않는다.

### Shared Drive API contract

- API principal은 지정 intake root에만 접근하며 create/list/get 권한을 확인한다.
- Drive Desktop 로그인 principal이 같은 root와 run folder를 로컬에서 읽을 수 있는지 별도로 확인한다.
- `files.list`는 parent + `trashed=false` query, `corpora=drive`, `driveId`, `includeItemsFromAllDrives=true`, `supportsAllDrives=true`, pagination을 사용한다.
- MVP는 자동 delete/trash/move를 요구하지 않는다. Contributor가 삭제할 수 없을 수 있으므로 합성 spike 산출물 정리는 권한 있는 운영자 또는 별도 test cleanup principal이 수행한다.
- 폴더 업로드는 relative path에 해당하는 Drive 하위 폴더를 생성하고 ID cache를 사용한다. discover/ready는 재귀 목록을 사용한다.

### 외부 gate

구현 전에 지정 테스트 하위 폴더에서만 아래를 확인한다.

- identity가 folder create/list/file create/file get을 수행할 수 있음
- Drive API가 조직 정책에 의해 차단되지 않음
- browser → resumable session PUT의 CORS가 production origin에서 허용됨
- session 완료 응답의 file ID/size를 서버가 재검증할 수 있음

CORS spike가 실패하면 bytes는 기존 Supabase signed upload로 전송하고 Mac mini가 Drive에 원본 백업을 쓰는 fallback을 사용한다. 이 경우 UI에는 `Drive 직접 업로드`라고 표시하지 않는다.

---

## 4. 상태 모델

```text
creating_folder
→ uploading
→ verifying_drive
→ ready
→ snapshotting
→ queued
→ processing
→ validating
→ review_required | published | failed
```

- `review_required`: 원본 고정(snapshot)·파싱·필수 소스·unsupported·golden 검증 중 자동 공개할 수 없는 문제가 발견되어 사람 검토가 필요한 terminal 상태다. `error_code`로 원인을 구분하며 현재 공개본을 교체하지 않는다.
- `published`: 검증 통과 후 current pointer가 전환된 상태다.
- 동일 manifest digest의 intake audit row는 남을 수 있지만 `duplicate_of`로 canonical intake에 수렴하며 새 processing job/run rows/artifact/version을 만들지 않는다. 이 계획에서 processing run ID는 `settlement_jobs.id`다.
- manifest 변경은 새 version을 만들되 기존 published run을 유지한다.

---

### Task 1: Operator authorization and Google Drive browser spike

**Objective:** Drive write 권한을 실제 운영자에게만 열고, 실제 browser origin에서 공유드라이브 resumable upload가 가능한지 production 코드 변경 전에 증명한다.

**Files:**
- Create: `src/features/settlement/lib/operator-auth.ts`
- Create: `src/features/settlement/lib/csrf.ts`
- Create: `supabase/migrations/025_settlement_operator_security.sql`
- Modify: `src/features/settlement/lib/api-auth.ts`
- Modify: `app/api/settlement/upload/route.ts`
- Modify: `app/api/settlement/uploads/prepare/route.ts`
- Modify: `app/api/settlement/jobs/route.ts`
- Modify: every state-changing comparison/comment/review route under `app/api/settlement/comparisons/**`
- Modify: `app/api/settlement/reset/[month]/route.ts`
- Create: `scripts/test-settlement-operator-auth.ts`
- Create: `scripts/test-settlement-drive-auth.ts`
- Create: `scripts/test-settlement-drive-resumable.ts`
- Create: `app/settlement/drive-upload-spike/page.tsx` (feature-flagged, temporary)
- Create: `scripts/test-settlement-drive-browser.ts`
- Modify: `package.json`
- Do not create: credential files inside the repository

**Steps:**
1. 임시 고정 쿠키가 Drive write와 기존 fallback upload/prepare/job/comparison/reset mutation guard로 사용되면 실패하는 auth test를 먼저 작성한다.
2. 실제 server-side session, operator/admin role, expiry, actor ID, same-origin/CSRF 계약을 정의하고 모든 settlement POST/PATCH/DELETE route inventory에 적용한다.
3. security migration은 `raw_uploads`, `raw_records`, `sales_records`, comparison tables의 authenticated full-write policy를 제거하고 direct insert/update/delete를 철회한다. 현재 화면에 꼭 필요한 읽기는 임시 read-only policy 또는 privacy-safe view로 한정하고 Task 9에서 최종 철회한다.
4. migration test는 anon/authenticated가 raw/result table을 직접 mutate할 수 없고 service-role API만 필요한 작업을 수행하는지 policy catalog와 실제 요청으로 검증한다.
5. `DRIVE_UPLOAD_ENABLED=false`일 때 모든 Drive write route가 404/403이 되는 feature gate를 만든다.
6. `google-auth-library`를 추가하고 package lock을 갱신한다.
7. env name 존재 여부만 검사하고 값을 출력하지 않는 auth test를 작성한다.
8. API principal과 Drive Desktop principal이 같은 지정 테스트 root를 읽는지 각각 확인한다.
9. 지정 테스트 하위 폴더의 metadata를 `supportsAllDrives=true`로 조회한다.
10. 합성 binary 파일용 resumable session을 생성한다.
11. 실제 deployment origin의 feature-flagged page에서 `PUT + Content-Range` preflight/CORS를 실행한다.
12. non-final chunk는 Google protocol의 256 KiB 배수로 전송하고 `308 + Range` offset 재개를 검증한다.
13. `200/201` 완료, network interruption resume, synthetic `404 expired session → 새 session` client fallback을 검증한다.
14. 업로드 파일의 expected parent, size, binary checksum/revision을 server-side read-back한다.
15. service identity에 delete 권한이 없으면 자동 삭제를 시도하지 않고 권한 있는 test cleanup 절차를 기록한다.
16. 실패 시 Drive bytes-direct 설계를 중단하고 Supabase signed-upload fallback decision을 문서화한다.

**Verification:**

```bash
node --import tsx scripts/test-settlement-operator-auth.ts
node --import tsx scripts/test-settlement-drive-auth.ts
node --import tsx scripts/test-settlement-drive-resumable.ts
node --import tsx scripts/test-settlement-drive-browser.ts
```

Expected: temporary-cookie rejection PASS, role/CSRF PASS, secret redaction PASS, folder-scope PASS, actual browser CORS/308-resume/complete PASS.

---

### Task 2: Add Drive intake run schema

**Objective:** Drive 업로드와 manual Drive 업로드를 하나의 durable intake run으로 기록한다.

**Files:**
- Create: `supabase/migrations/026_settlement_drive_intakes.sql`
- Create: `scripts/test-settlement-drive-schema.ts`
- Modify: `src/features/settlement/lib/supabase/types.ts`

**Schema:**

- `settlement_intake_runs`
  - `id`, `month`, `source_kind`
  - `drive_folder_id`, `drive_folder_url`
  - `status`, `manifest_digest`
  - `worker_id`, `claim_token`, `lease_expires_at`, `heartbeat_at`, `attempt_count`
  - bounded file/byte/warning/error counts, bounded `error_code` and privacy-safe `error_summary`
  - `settlement_job_id`, timestamps
  - unique non-null `settlement_job_id` so one intake cannot enqueue two jobs
- `settlement_intake_files`
  - `intake_run_id`, position
  - Drive file ID, binary revision/head revision, filename, normalized relative path
  - content type, size, Drive checksum, local SHA-256
  - upload/verification/snapshot status
- atomic `claim_settlement_intake`, heartbeat, release/fail/complete RPCs with compare-and-set claim token
- canonical manifest digest = sorted normalized relative path + size + content SHA-256; Drive file ID/revision is provenance but excluded from digest so identical bytes replay is idempotent
- one canonical manifest per month across all source kinds after snapshot verification; duplicate source submissions keep provenance but point to the canonical intake
- `finalize_settlement_intake_manifest(intake_id, claim_token, digest)` takes a month+digest advisory transaction lock, resolves an existing canonical intake or atomically sets this intake canonical, and relies on a partial unique constraint for concurrent races
- service-role/direct-Postgres only; no anon/authenticated table policies
- privacy-safe web API projection only

**Acceptance:** invalid month/status/oversized fields fail; expired intake lease is reclaimable; claim token fences stale workers; one canonical intake creates at most one job; concurrent Drive/Supabase submissions with the same bytes/path digest converge to one processing run; changed content creates a new run.

---

### Task 3: Implement private Google Drive server client

**Objective:** Vercel server에서만 Drive folder/session/file verification을 수행한다.

**Files:**
- Create: `src/features/settlement/lib/google-drive/config.ts`
- Create: `src/features/settlement/lib/google-drive/server-client.ts`
- Create: `src/features/settlement/lib/google-drive/contracts.ts`
- Create: `scripts/test-settlement-drive-server-client.ts`

**Implementation:**

- `google-auth-library` JWT/OAuth adapter
- private key newline normalization
- fixed root folder boundary
- run folder create under `INBOX/YYYYMM`
- resumable `files.create?uploadType=resumable&supportsAllDrives=true`
- Shared Drive list uses `q='<parentId>' in parents and trashed=false`, `corpora=drive`, configured `driveId`, `includeItemsFromAllDrives=true`, `supportsAllDrives=true`, and complete pagination
- recursive run-folder discovery with folder-ID cache; Google-native documents, shortcuts, and non-binary objects are rejected
- file get uses explicit fields: ID, parents, name, MIME, size, modified/version/revision fields, available binary checksums
- every returned file must have expected ancestor chain and remain inside configured root
- Google error body/token/session URI must not be logged or returned
- filename and hierarchy are preserved in Drive/UI; DB locator uses opaque IDs

**Tests:** folder escape, wrong parent, duplicate filename, unsupported MIME, oversized file count, expired session, privacy-safe errors.

---

### Task 4: Add authenticated Drive intake APIs

**Objective:** 웹에서 run folder 생성, resumable session 발급, 완료 검증, ready 전환을 안전하게 수행한다.

**Files:**
- Create: `app/api/settlement/drive/intakes/route.ts`
- Create: `app/api/settlement/drive/intakes/[id]/route.ts`
- Create: `app/api/settlement/drive/intakes/[id]/uploads/session/route.ts`
- Create: `app/api/settlement/drive/intakes/[id]/uploads/complete/route.ts`
- Create: `app/api/settlement/drive/intakes/[id]/discover/route.ts`
- Create: `app/api/settlement/drive/intakes/[id]/ready/route.ts`
- Create: `scripts/test-settlement-drive-api.ts`

**Contract:**

- 1–200 files, authoritative selected month, bounded filename/path/size
- session route returns only opaque intake file ID + resumable URI
- complete route ignores client claims until Drive file metadata is server-verified
- discover route recursively lists only one server-created run folder and records normalized relative paths
- ready requires every discovered/expected binary file to be verified
- ready stores an immutable manifest of Drive file ID + binary revision/version + size + available checksum + relative path
- ready transaction re-lists the folder immediately before transition and requires added/deleted/changed file count = 0
- changed Drive folder after ready makes the intake terminal `review_required` with `error_code=source_changed`; `source_changed` is not a status and the frozen run is never mutated
- ready run is immutable; changed inputs require a new intake version
- write routes require operator role + same-origin/CSRF; rollback later requires admin role
- unauthenticated route returns 401; disabled feature returns 404/403; no key/session/file paths in error responses

---

### Task 5: Build resumable Drive browser uploader

**Objective:** 파일 bytes를 Vercel을 거치지 않고 Google에 보내며 진행률과 재개 상태를 표시한다.

**Files:**
- Create: `src/features/settlement/lib/google-drive/drive-upload-client.ts`
- Create: `src/features/settlement/components/SettlementDriveIntake.tsx`
- Modify: `src/features/settlement/components/SettlementClient.tsx`
- Create: `scripts/test-settlement-drive-client.ts`

**UI:**

- `Drive 작업 폴더 만들기`
- `웹에서 업로드` / `Google Drive에서 열기` tabs
- 파일별 upload progress, retry, cancel
- 모든 파일 완료 후에만 `처리 시작`
- folder upload relative path를 정규화해 서버가 대응하는 Drive 하위 폴더를 만들도록 전달하고, 같은 폴더의 duplicate normalized path는 거부
- session URI는 React memory에만 두고 로그/localStorage 금지
- 새로고침 시 server intake/file 상태로 복구; session 재개가 불가능하면 새 session 발급
- 현재 Supabase upload는 `비상용 업로드`로 접어 둔다.

**Tests:** 5xx/network resume, cancelled upload, stale month change, partial file success, duplicate click ownership, KO/JA text.

---

### Task 6: Build source-neutral processing and run staging first

**Objective:** Drive scanner를 연결하기 전에 parser/transform을 원본 위치와 분리하고, Drive run이 기존 `sales_records`에 직접 쓰지 못하도록 staging sink를 완성한다.

**Files:**
- Create: `supabase/migrations/027_settlement_generic_job_sources.sql`
- Create: `supabase/migrations/028_settlement_run_staging.sql`
- Create: `src/features/settlement/lib/worker/source-adapter.ts`
- Create: `src/features/settlement/lib/worker/process-settlement-source.ts`
- Create: `src/features/settlement/lib/worker/run-record-sink.ts`
- Modify: `src/features/settlement/lib/worker/process-prepared-upload.ts`
- Modify: `src/features/settlement/lib/worker/run-job.ts`
- Modify: `src/features/settlement/lib/worker/job-contract.ts`
- Modify: `scripts/settlement-worker.ts`
- Modify: worker queue/API/processor tests

**Migration:**

- add nullable `intake_file_id` to `settlement_job_files`
- make `upload_id` nullable
- add XOR check: exactly one of `upload_id` or `intake_file_id`
- add unique non-null `settlement_jobs.intake_run_id`
- keep existing Supabase upload RPC and legacy wrapper behavior available behind fallback flag
- add Drive enqueue RPC that requires intake claim token, `ready/snapshotting` ownership, matching month, and no existing job
- add `settlement_run_raw_records` and `settlement_run_records`, both keyed by run/job ID with retry-safe unique keys

**Refactor contract:**

- Source adapter supplies filename, normalized relative path, size, content type, authoritative month, bytes provider, and provenance.
- Pure parse/transform code returns deterministic parsed rows, sales rows, warnings, and duplicate keys; it does not update `raw_uploads` or production `sales_records`.
- Sink adapter decides between the existing legacy fallback sink and the new run-staging sink.
- Drive source is permitted to use only run staging. A test must fail if Drive processing calls legacy production insert methods.
- Existing Supabase fallback remains operational until Task 9 cutover; the new pipeline can run shadow-only without changing the current page.

**Acceptance:** Supabase and Drive byte fixtures produce identical normalized output; retry creates no duplicate staged rows; parser failure leaves production tables and current publication unchanged.

---

### Task 7: Build Mac Drive scanner, verified SSD2 snapshot, and enqueue

**Objective:** source-neutral staging이 준비된 뒤 ready run의 frozen Drive manifest를 다시 검증하고 SSD2에 불변 snapshot한 다음 정확히 한 job을 enqueue한다.

**Files:**
- Create: `src/features/settlement/lib/drive-intake/scanner.ts`
- Create: `src/features/settlement/lib/drive-intake/manifest.ts`
- Create: `src/features/settlement/lib/drive-intake/snapshot.ts`
- Create: `src/features/settlement/lib/drive-intake/drive-metadata-verifier.ts`
- Create: `src/features/settlement/lib/drive-intake/supabase-fallback-adapter.ts`
- Create: `scripts/test-settlement-drive-scanner.ts`
- Create: `scripts/test-settlement-fallback-intake.ts`
- Modify: `scripts/settlement-worker.ts`
- Modify: `scripts/install-settlement-worker.sh`
- Modify: `ops/com.riverse.settlement-worker.plist.template`

**Processing:**

1. DB에서 `ready` intake를 claim token과 만료 lease로 원자 claim한다.
2. Mac의 Drive API metadata verifier가 run folder를 재귀 재목록하고 ready manifest의 file ID, revision/version, size, checksum, relative path와 exact-set 비교한다.
3. 추가·삭제·revision/size/checksum metadata 변경, Google-native document, shortcut, duplicate normalized path가 하나라도 있으면 상태 `review_required`, 오류 코드 `source_changed`로 닫고 enqueue하지 않는다.
4. configured Drive Desktop sync root + opaque run folder만 확인한다.
5. temporary/hidden/placeholder 파일을 제외하고 모든 파일을 실제로 읽을 수 있을 때까지 bounded retry한다.
6. 같은 SSD2 volume의 `/runs/.tmp-<run-id>-<claim-token>/input`에 복사하면서 local SHA-256과 ready manifest가 제공한 Drive checksum 알고리즘(MD5/SHA-1/SHA-256 중 authoritative field)을 동일하게 계산한다.
7. local bytes의 Drive checksum이 frozen ready manifest와 정확히 일치해야 한다. 같은 path/size라도 checksum이 다르거나 Drive checksum이 없으면 로컬 복사본을 폐기하고 지정 file ID의 Drive API download로 전환한다.
8. API download bytes도 frozen revision metadata와 checksum을 만족해야 하며, 그렇지 않으면 fail closed 한다.
9. 복사본을 다시 읽어 hash/size/path manifest를 검증하고 fsync 가능한 경계를 마친 뒤 `/runs/<run-id>`로 atomic rename한다.
10. canonical manifest digest는 sorted normalized relative path + size + content SHA-256이며 Drive ID는 provenance에만 저장한다.
11. `finalize_settlement_intake_manifest` RPC가 같은 달의 동일 digest submissions를 source kind와 무관하게 하나의 canonical intake로 수렴시킨다. duplicate intake는 기존 processing run/publication을 참조하고 새 job/rows/artifact를 만들지 않는다.
12. claim token을 요구하는 단일 RPC가 canonical intake당 정확히 한 settlement job을 생성하고 intake의 `settlement_job_id`를 같은 트랜잭션에서 설정한다.
13. worker 중단 시 lease 만료 후 다른 worker가 temp snapshot을 검증·정리하고 final snapshot 또는 enqueue 상태에서 안전하게 재개한다.

**Fallback:** LaunchAgent가 Drive Desktop bytes를 읽지 못하거나 local checksum이 frozen Drive checksum과 맞지 않으면 전체 디스크 권한부터 요구하지 않고 지정 file ID의 Drive API download adapter를 사용한다. checksum이 제공되지 않거나 API bytes도 frozen metadata를 증명하지 못하면 처리하지 않는다. API principal과 Drive Desktop principal은 Task 1에서 같은 root를 보는지 검증돼야 한다.

**Supabase fallback canonical path:**

1. fallback의 upload/prepare 단계는 private Storage `raw_uploads`를 만들되 web route에서 기존 settlement job을 직접 enqueue하지 않는다.
2. `create_supabase_fallback_intake(month, ordered_upload_ids_and_relative_paths, actor)` RPC가 동일한 `settlement_intake_runs/files`에 source kind `supabase_fallback` ready intake를 만든다.
3. Mac intake worker의 Supabase source adapter가 frozen storage objects를 같은 SSD2 temp snapshot으로 내려받아 size와 SHA-256을 검증한다.
4. Drive source와 동일한 `finalize_settlement_intake_manifest` RPC가 month + path + size + content digest를 canonicalize한다.
5. canonical intake만 exactly-once job enqueue RPC를 호출한다. Drive와 fallback이 동시에 같은 bytes를 제출해도 duplicate intake는 `duplicate_of`로 연결되고 새 job을 만들지 않는다.
6. Task 9 cutover에서 기존 web→`enqueue_settlement_job` 직접 경로를 차단하고, 비상 업로드도 이 intake 경로만 사용하도록 강제한다.

---

### Task 8: Add fenced atomic publication and auditable rollback

**Objective:** immutable artifact와 모든 validation이 확인된 run만 월별 current pointer로 공개하고, 실패·stale worker·rollback을 감사 가능하게 만든다.

**Files:**
- Create: `supabase/migrations/029_settlement_run_publication.sql`
- Create: `src/features/settlement/lib/worker/publication-store.ts`
- Create: `src/features/settlement/lib/export/load-published-settlement.ts`
- Create: `scripts/test-settlement-publication.ts`
- Modify: `src/features/settlement/lib/worker/run-job.ts`
- Modify: `src/features/settlement/lib/worker/process-settlement-source.ts`

**Schema:**

- `settlement_publication_versions`: immutable month + version + run ID + manifest digest + parser/rule/validation versions + artifact path/size/SHA-256 + published actor/time
- `settlement_month_current`: one row per month with current version/run pointer and update token
- `settlement_publication_audit`: publish/rollback action, from/to version, actor, reason, timestamp
- `settlement_run_artifacts`: one immutable candidate artifact per run with storage path, size, SHA-256, upload/read-back verification timestamps, verifying worker/claim token, and verification status
- unique run publication and unique `(month, version)` constraints
- `review_required` run and its staged rows/artifact remain queryable but are never inserted into current pointer

**Publication contract:**

1. Worker generates workbook from the selected run staging plus explicitly approved prior-ledger carry rules.
2. Required-source, unsupported, workbook reopen, deterministic/golden gates finish before publish eligibility.
3. Artifact is uploaded first to immutable content-addressed path and downloaded/read back to verify size and SHA-256. Storage upload is outside the DB transaction; an unreferenced orphan is acceptable and later GC-able, but a pointer to an unverified artifact is not.
4. `record_verified_settlement_artifact(run_id, worker_id, claim_token, storage_path, size, sha256)` RPC verifies the active lease/claim and records the read-back evidence in `settlement_run_artifacts`. Path/size/SHA are immutable after verification.
5. `publish_settlement_run(run_id, worker_id, claim_token, expected_manifest_digest, expected_artifact_id, expected_artifact_sha256)` first obtains a transaction advisory lock derived from the month, inserts the missing `settlement_month_current` sentinel row if this is the first publication, then row-locks it. This fences concurrent first publication as well as later publication.
6. The RPC verifies active lease/claim ownership, eligible validation status, all intake/job files terminal, staged row counts/digests, frozen manifest, and a matching verified `settlement_run_artifacts` row owned by the same run/claim.
7. In one DB transaction it inserts immutable version history, switches current pointer using compare-and-set, appends audit, and marks run/job published.
8. Retry with the same run/artifact is idempotent; stale claim token, unverified artifact, or changed current version fails closed.
9. `rollback_settlement_publication(month, target_version, expected_current_version, admin_actor, reason)` uses the same month advisory + row lock, verifies target immutable version/artifact, switches only the pointer, and appends audit. It never deletes history or production rows.

**Acceptance:** two simultaneous first publications produce one ordered current version; failure injection after artifact upload, before evidence RPC, before publish RPC, and during stale lease leaves current unchanged; same RPC retry adds no duplicate version/audit; rollback and rollback reversal preserve complete history.

---

### Task 9: Make web status/preview/export read published results only

**Objective:** 정산 페이지 요청에서 원장 재조립과 Excel 재생성을 제거한다.

**Files:**
- Create: `supabase/migrations/030_settlement_comparison_run_binding.sql`
- Modify: `src/features/settlement/lib/current-data-routes.ts`
- Modify: `src/features/settlement/lib/active-month-server.ts`
- Modify: `src/features/settlement/lib/supabase/queries.ts`
- Modify: `app/api/settlement/current-status/[month]/route.ts`
- Modify: `app/api/settlement/preview-v2/[month]/route.ts`
- Modify: `app/api/settlement/export-current/[month]/route.ts`
- Modify: `app/api/settlement/export-v2/[month]/route.ts`
- Modify: `app/api/settlement/month-platforms/route.ts`
- Modify: `app/api/settlement/comparisons/route.ts`
- Replace/deprecate: `app/api/settlement/reset/[month]/route.ts`
- Modify: `src/features/settlement/components/SettlementClient.tsx`
- Modify: `src/features/settlement/components/InputPreviewWindow.tsx`
- Create: `app/api/settlement/publications/[month]/versions/route.ts`
- Create: `app/api/settlement/publications/[month]/rollback/route.ts`
- Create: `app/api/settlement/intakes/[id]/discard/route.ts`
- Modify: `src/features/settlement/lib/worker/process-prepared-upload.ts`
- Modify: `src/features/settlement/lib/worker/run-record-sink.ts`
- Modify: `app/api/settlement/uploads/prepare/route.ts`
- Modify: `app/api/settlement/jobs/route.ts`

**Behavior:**

- active month and monthly summary read publication metadata rather than legacy `sales_records` aggregation
- before web cutover, Supabase fallback upload/prepare/job request is changed to create a `supabase_fallback` intake rather than a settlement job; the Mac snapshot/finalize path then creates the canonical job, which uses the same `settlement_run_raw_records`/`settlement_run_records` staging and Task 8 publication RPC as Drive
- set `ALLOW_LEGACY_SETTLEMENT_PRODUCTION_WRITES=false`; tests fail if either Drive or Supabase source directly inserts/deletes production `sales_records`
- status reads current publication metadata only
- platform list reads the selected published run's provenance/rows, not `raw_uploads` globally
- preview reads published run rows or precomputed bounded preview
- migration 030 adds `candidate_run_id` FK to the processing run (`settlement_jobs.id`) and `baseline_publication_version_id` FK to immutable `settlement_publication_versions`; legacy rows may remain null and are labelled legacy, while every new completed comparison requires both bindings
- comparison requires the stored candidate run ID and baseline publication version ID; it does not silently rebuild an unspecified current ledger
- download streams the verified stored artifact; no request-time workbook generation
- current/review run and final published run labels stay distinct
- legacy reset is split into unpublished-intake discard and admin-only publication rollback; published history/rows are never deleted
- rollback requires explicit expected-current version, confirmation, reason, admin actor, and audit
- main page returns no titles/amounts in lightweight status response
- after safe-view/API cutover, authenticated direct access to legacy raw/result tables is revoked

**Performance target:** all main-page status, active-month, and platform summary paths are bounded indexed reads and never invoke `loadInputV2Records`.

---

### Task 10: Shadow run, golden verification, rollout

**Objective:** 기존 6월 운영 결과를 손상시키지 않고 새 Drive-first pipeline을 증명한다.

**Steps:**

1. 전용 Drive test run folder에 기존 검증 원본의 복사본을 넣는다.
2. scanner → SSD2 snapshot → parser → staging → workbook validation을 shadow mode로 실행한다.
3. publication pointer는 바꾸지 않는다.
4. source file count, SHA-256 manifest, parser classifications, row/key multiset, warnings, workbook sheets/rows, canonical XLSX digest를 기존 검증 결과와 비교한다.
5. ready 후 Drive 파일 추가·삭제·revision 변경을 주입해 snapshot/enqueue가 fail closed 되는지 확인한다.
6. worker 강제중단을 temp snapshot, atomic rename, enqueue, staging, artifact upload, publish RPC 직전에 각각 주입해 lease 회수와 current publication 불변을 확인한다.
7. 같은 manifest 재실행에서 duplicate intake/job/run rows/artifacts/version/audit 0을 확인한다.
8. changed content manifest가 새 version을 만들고 이전 version rollback 및 rollback reversal이 되는지 확인한다.
9. operator/admin/CSRF/feature-flag 권한 matrix와 기존 Supabase fallback upload E2E를 다시 실행한다.
10. active-month/status/platform/preview/comparison/export/reset 전 경로가 published/staged run을 명시적으로 사용하고 legacy full loader/direct table을 호출하지 않는지 검사한다.
11. Codex 독립 리뷰, 전체 settlement/worker tests, TypeScript, ESLint, production build를 통과한다.
12. auth gate → migration → idle worker → shadow run → one production month opt-in → web cutover 순서로 배포한다.
13. 최소 두 월간 fallback을 유지한 뒤 Drive-first를 기본 tab으로 확정한다.

**Deployment gates:**

- 임시 고정 쿠키로 Drive 또는 fallback upload/prepare/job/comparison/reset/publish/rollback mutation 가능한 경로 0
- operator/admin/CSRF/feature flag 권한 matrix PASS
- 자격 증명·session URI 값 노출 0
- 지정 Drive root 밖 list/create 0
- ready manifest 이후 변경·partial·placeholder 파일 처리 0
- intake/job lease stale worker의 enqueue/publish 성공 0
- failed/review run이 current pointer를 변경한 횟수 0
- same manifest duplicate intake/job/row/artifact/version/audit 0
- Drive와 Supabase fallback의 legacy production sink 호출 0
- content-addressed artifact read-back 및 workbook reopen/golden checks PASS
- current status·active month·platform summary가 full loader를 호출하지 않음
- 모든 신규 comparison은 candidate processing run FK와 baseline immutable publication FK를 보유하고 legacy reset은 production history를 삭제하지 않음
- authenticated production browser에서 web upload와 Drive UI upload 모두 완료

---

## 5. 현재 코드 재사용/교체 범위

### 재사용

- parsers와 `toSalesRecords`
- strict duplicate/carry/business rules
- worker lease·heartbeat·safe checkpoint
- workbook generator와 ExcelJS validation
- job polling/new refresh recovery
- preview UI, spreadsheet review, comparison/golden 도구
- Supabase artifact storage와 인증 API

### 교체 또는 일반화

- primary source: Supabase Storage → Drive intake + SSD2 snapshot
- `settlement_job_files.upload_id NOT NULL` → generic source XOR
- per-file production insert → run staging
- request-time status/export generation → published metadata/artifact read
- browser upload section → Drive run folder + resumable upload 중심

### 유지하는 fallback

- existing Supabase signed upload
- existing manual comparison/answer upload
- prior published versions and rollback

---

## 6. 구현 순서 결론

1. **운영자 세션·역할·CSRF gate + 실제 browser-origin Drive resumable spike**
2. **Drive intake schema(lease/claim/immutable ready manifest) + private Drive client/API/UI**
3. **generic source adapter + run staging sink**
4. **Mac metadata recheck + SSD2 atomic snapshot + exactly-once enqueue**
5. **content-addressed artifact + fenced atomic publication/rollback**
6. **active month/status/platform/comparison/export/reset 전체 published-read cutover**
7. **shadow golden·failure injection E2E 후 월별 opt-in**

Drive 업로드 UI만 먼저 배포하고 per-file production insert를 그대로 두는 것은 금지한다. 사용자 편의는 좋아져도 반쪽 결과 공개 위험이 남기 때문이다. Drive-first를 운영 기본값으로 전환하는 시점은 Task 8의 atomic publication과 Task 10의 shadow golden gate가 통과한 뒤다.
