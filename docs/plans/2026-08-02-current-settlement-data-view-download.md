# Current Parsed Settlement Data View and Download Implementation Plan

> **For Hermes:** Use the Hermes → Claude Code implementation → Codex review → Hermes verification workflow.

**Goal:** Let an authenticated operator view and download the settlement workbook generated from the currently parsed month data even when required source families are still missing, while keeping the strict final workbook download blocked until source completeness passes.

**Architecture:** Reuse `loadInputV2Records(..., { allowIncompleteSources: true })`, `fillInputV2Template`, and the existing workbook preview so page view and download are generated from the same record/workbook path. Add a separate explicitly labeled current-snapshot download route. Surface aggregate row/sheet/warning counts and a clear incomplete-data warning in the settlement page and preview window. Preserve the strict `/api/settlement/export-v2/[month]` behavior unchanged.

**Tech Stack:** Next.js App Router, React, TypeScript, ExcelJS, existing settlement export/preview code, authenticated route guard.

---

### Task 1: Add a reusable current-snapshot export contract

**Objective:** Generate a downloadable workbook from currently parsed records while retaining source completeness warnings.

**Files:**
- Create: `app/api/settlement/export-current/[month]/route.ts`
- Test: `scripts/test-settlement-current-data.ts`
- Modify: `package.json`

**Steps:**
1. Add a failing route-contract test for auth, `YYYYMM` validation, `allowIncompleteSources: true`, empty-data 404, xlsx headers, warning count/status headers, and privacy-safe errors.
2. Implement the route by reusing `loadInputV2Records` and `fillInputV2Template`.
3. Label the file `JP_INPUT_CURRENT_<YYYYMM>.xlsx` and response state as `complete` or `incomplete` based on `sourceWarnings.length`.
4. Do not change the existing strict `export-v2` route.
5. Run the focused test and TypeScript check.

### Task 2: Surface current data status in the main settlement page

**Objective:** Make the existing parsed month data visible and understandable before upload.

**Files:**
- Create: `app/api/settlement/current-status/[month]/route.ts`
- Modify: `src/features/settlement/components/SettlementClient.tsx`
- Create or modify a small client API helper under `src/features/settlement/lib/storage/` only if needed.
- Test: `scripts/test-settlement-current-data.ts`

**Steps:**
1. Add a failing status-route/UI contract test for a separate `3. 현재 정산 데이터` section.
2. Implement an authenticated lightweight status route that calls `loadInputV2Records(..., { allowIncompleteSources: true })` but returns only bounded aggregate metadata: `recordCount`, warning count/state, and no records/titles/amounts/storage paths. Do not fetch or serialize the full workbook preview JSON on the main page.
3. Fetch that lightweight status route for the selected month with stale-request protection.
4. Display loading, no-data, error, and ready states without rendering titles or monetary values on the main page.
5. Add clear buttons:
   - `현재 정산 데이터 보기` → existing `/settlement-preview/<YYYYMM>`
   - `현재 파싱본 Excel 다운로드` → new current export route
   - `완전성 검사 후 최종 Excel` → existing strict export route
6. Show an amber warning when source families are missing and explain that current download is review-only, not a finalized statement.
7. Refresh this summary after upload completion and month reset.
8. Run focused tests and lint.

### Task 3: Make the preview window honest and downloadable

**Objective:** Show source warnings and allow the same current workbook being previewed to be downloaded.

**Files:**
- Modify: `src/features/settlement/components/InputPreviewTable.tsx` (type only if needed)
- Modify: `src/features/settlement/components/InputPreviewWindow.tsx`
- Test: `scripts/test-settlement-current-data.ts`

**Steps:**
1. Extend preview type with bounded `sourceWarnings?: string[]`.
2. Rename the heading to `현재 정산 데이터` / Japanese equivalent.
3. Show row count, sheet count, and amber incomplete-source warning without exposing raw records or storage paths.
4. Point the primary download button to `/api/settlement/export-current/<YYYYMM>.xlsx` and label it as current parsed workbook.
5. Keep the strict final download as a secondary action.
6. Run focused tests and build.

### Task 4: Real June verification and deployment gate

**Objective:** Prove the feature with current production June data without changing financial rows.

**Verification:**
1. Run all settlement tests, TypeScript, ESLint, production build, and `git diff --check`.
2. Codex reviews authentication, warning semantics, stale requests, privacy leakage, and strict-export preservation.
3. Deploy to the existing linked Vercel project only after review PASS.
4. Authenticated production checks for `202606`:
   - preview returns 200, positive rows, positive sheets, warning count;
   - current export returns 200 xlsx, `incomplete` header, reopens with ExcelJS;
   - strict export remains 409 while required sources are missing;
   - `/api/health` remains 200 and DB connected.
5. Verify the canonical operator hostname serves the updated settlement page.

**Acceptance:** Current June data can be viewed and downloaded, incompleteness is unmistakable, strict final export is not weakened, and no production DB rows or source files are modified by verification.
