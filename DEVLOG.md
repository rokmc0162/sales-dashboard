# RVJP 매출 대시보드 — 개발 로그

> **프로젝트**: Riverse Japan 매출 분석 대시보드 + 정산(settlement) 자동화
> **배포**: https://rvjp-dashboard.vercel.app
> **스택**: Next.js 16 (App Router) + React 19 + TypeScript + Tailwind CSS v4 + Recharts + framer-motion
> **백엔드**: Supabase (PostgreSQL) — 대시보드 `daily_sales_v2`, 정산 `sales_records`
> **인증**: Auth0 (ROPG + BFF) + HMAC 서명 세션 쿠키
> **마지막 업데이트**: 2026-08-28

---

## 프로젝트 구조

> 2026-07 이후 무게중심이 정산 파이프라인으로 이동했다.
> 아래는 현재 구조이며, 초기 Vite 시절의 `src/pages/` · `App.tsx` · `i18n/`은 더 이상 없다.

```
app/
├── (protected)/                     인증 필요 페이지 10개
│   ├── dashboard/  titles/  platforms/  reports/  data/
│   ├── initial-sales/  title-compare/  titles-manage/
│   ├── upload/                      속보치·리포트 업로드
│   └── settlement/                  정산 업로드 + 정답지 비교 (탭)
├── (public)/login/                  서버 래퍼 + LoginClient
├── settlement-preview/[month]/      INPUT 워크북 미리보기 (독립 창)
├── settlement-sheet/[id]/           정답지 전체화면 검수 (독립 창)
└── api/                             라우트 59개
    ├── auth/          login refresh logout profile forgot-password
    ├── dashboard/     analysis/     sales/     manage/
    ├── content-master/
    ├── settlement/    upload uploads/prepare export-v2 preview-v2
    │                  comparisons(+diffs, comments, artifacts) reset
    └── health/                      유일한 공개 라우트 (Vercel cron)

src/
├── features/settlement/             정산 파이프라인 (82 files)
│   ├── components/                  SettlementClient, SettlementCompareClient,
│   │                                AnswerWorkbookReview, SettlementSpreadsheetReview,
│   │                                InvestigationThread, InputPreview*
│   ├── lib/parsers/                 registry.ts(자동 감지) + 20종 파서 + ocr-pdf, ai-pdf
│   ├── lib/aggregation/             to-sales-records, strict-record-key
│   ├── lib/export/                  input-v2-filler, carry-forward, workbook-preview
│   ├── lib/comparison/              compare, workbook-review, investigation, presentation
│   ├── lib/storage/                 archive-before-parse, direct-upload, heartbeat-stream
│   └── data/                        aliases/*.json 18개, templates/*.xlsx
├── components/                      대시보드 UI (dashboard, titles, platforms, data, shared)
├── lib/
│   ├── session.ts                   HMAC 세션 서명/검증 (Web Crypto, Node+Edge 공용)
│   ├── api-auth.ts                  requireApiAuth — 모든 API 라우트의 인증 게이트
│   ├── supabase.ts / supabase-server.ts
│   └── design-tokens.ts  animations.ts  utils.ts
├── providers/AuthProvider.tsx       세션 복원, login/logout/refresh
├── context/AppContext.tsx           언어·통화 등 전역 상태
├── utils/                           platformConfig, upload/parsers, reportExporter
└── types/

scripts/                             테스트 45개 + 시드 + 정산 CLI
supabase/migrations/                 001~021
.github/workflows/ci.yml             lint + tsc + 테스트 전체
```

---

## 작업 히스토리 (최신순)

### 2026-08-28: API 인증 전면 도입 + CI + 문서 정합화

**문제**: API 라우트 60개 중 45개에 인증이 전혀 없었다. `src/lib/supabase-server.ts`가
service role 키를 우선 사용하므로 이 라우트들은 RLS까지 우회했고, `middleware.ts`의 matcher는
`/api`를 제외하므로 페이지 보호도 받지 못했다. 확인된 노출면:

- `manage/reset-sales` — 하드코딩 리터럴 `'CLINK'` 하나로 전체 매출 삭제
- `sales/upload`, `manage/sales`, `manage/titles` 등 — 인증 없이 매출 쓰기/수정/삭제
- `upload-debug` — 인증 없이 임의 파일 Storage 업로드 (호출부 0개인 dead route)
- `content-master` 2개 — 고정 `rvjp-temporary-mock-access-token` 무조건 허용
- `auth/login` — 숫자 비밀번호면 이메일 무관 로그인 (2026-07-02 `cb106ab`에서 도입)
- 정산 12개 — 고정 문자열 쿠키가 유일한 인증
- `middleware.ts` — 쿠키 **존재 여부만** 검사

**해결 — 서명 세션 쿠키 + 공통 게이트**
- `src/lib/session.ts` 신규: `X-SESSION` HttpOnly 쿠키, HMAC-SHA256, TTL 60분.
  **Web Crypto 단일 구현**이라 Node 라우트와 Edge 미들웨어가 같은 코드를 쓴다
  (구현을 둘로 나누면 미들웨어는 통과시키고 API는 거부하는 불일치가 난다).
  `kid` 기반 시크릿 로테이션(`SESSION_SECRET` / `SESSION_SECRET_PREVIOUS`),
  `ver`로 전체 강제 재로그인, `SESSION_SECRET` 없으면 fail-closed.
- `src/lib/api-auth.ts` 신규: `requireApiAuth(request, { role, mutating })`.
  쓰기 요청은 ADMIN + `Origin` 동일 출처 검증(CSRF). `/api/health` 제외 전 라우트에 적용.
- 클라이언트 `fetch` 호출부는 **한 곳도 수정하지 않았다** — 쿠키는 자동 전송된다.
  Bearer 방식이었다면 호출부 13곳 + 라우트 59곳을 모두 고쳐야 했다.
- `requireSettlementApiAuth`는 시그니처를 유지한 채 내부만 공통 게이트 호출로 교체(호출부 15곳은 `await`만 추가).
- 임시 로그인 우회는 전부 `ALLOW_TEMP_LOGIN` 뒤로. 프로덕션 미설정 → 차단.
- 로그인 페이지: 서버 래퍼가 `tempMode`를 주입해 폼을 분기. 게이트가 꺼지면 이메일+비밀번호 폼이 나온다
  (이전에는 이메일 입력란 자체가 없어 우회를 끄면 아무도 로그인할 수 없었다).
- `middleware.ts`: 존재 검사 → 서명 검증. 미인증 리다이렉트에 `?next=`로 목적지 보존.
- `upload-debug` 라우트 삭제 (UI는 Supabase Storage SDK를 직접 사용).

**롤아웃**: `/api/auth/refresh`가 세션을 재발급하므로, 기존 `X-REFRESH-TOKEN`만 가진 사용자는
앱 진입 시 `AuthProvider`의 refresh 호출로 자동 마이그레이션된다.

**남은 것**: 세션이 stateless라 로그아웃 후에도 유출된 쿠키는 TTL(60분)까지 유효하다.
즉시 폐기가 필요해지면 서버측 denylist를 추가해야 한다.

**CI 신규**: `.github/workflows/ci.yml` — push/PR마다 lint + `tsc --noEmit` + 테스트 7그룹.
`scripts/test-*.ts`는 전부 오프라인이라 시크릿이 필요 없다.
신규 테스트 `test-session-cookie.ts`(서명·변조·만료·로테이션·fail-closed·payload 위생),
`test-api-auth.ts`(401/403·Origin·x-forwarded-host).

**문서**: `README.md`가 Vite 템플릿 기본 문서였던 것을 전면 교체. `CLAUDE.md`의 페이지/API 개수
정정(9→14, 36→59)과 정산 구조 추가. 이 DEVLOG의 구식 구조도 교체.

**변경 파일**: `src/lib/session.ts`(신규), `src/lib/api-auth.ts`(신규), API 라우트 43개,
`middleware.ts`, `app/(public)/login/{page.tsx,LoginClient.tsx}`, `src/features/settlement/lib/api-auth.ts`,
`scripts/test-{session-cookie,api-auth}.ts`(신규), `.github/workflows/ci.yml`(신규),
`README.md`, `CLAUDE.md`, `DEVLOG.md`, `.env.example`

---

### 2026-07-01 ~ 2026-08-01: 정산(settlement) 파이프라인

대시보드에 정산 자동화가 통합된 4개월. 커밋 약 60개.

**파이프라인** (`d359f9d` → `fa873b0`)
```
원본 파일 → 파싱 전 아카이브(sha256) → 플랫폼 자동 감지 → 20종 파서
  → raw_records(jsonb) → 정규화·중복억제 → sales_records → INPUT 워크북(xlsx)
  → 정답지 대조 → 차이별 조사 스레드
```

**플랫폼 파서 20종**: cmoa, piccoma(+ads/gaiakuhan), booklive, renta, mechacomic, comico,
dmm, line-ebj, line-ad, unext, mediado, mbj, mangabang, kadokawa, ichijinsha, sb-creative,
shueisha, beaglee, lezhin-beltoon. 타이틀 정규화는 `data/aliases/*.json` 18개 + `pg_trgm`.

**집영사 OCR** (`38482ee`, `1bd4a7b`, `3245489`): 명세서가 이미지 PDF라 서버에서
`tesseract.js` + `@napi-rs/canvas`로 OCR. `maxDuration=1800`, 페이지 병렬화, 금액 fast-path.
응답이 수 분간 비어 연결이 끊기므로 heartbeat 스트리밍으로 유지(`3c9d7c6`).
`next.config.ts`의 `outputFileTracingIncludes`로 WASM·언어데이터·네이티브 바인딩을 강제 번들하고,
`npm run deploy`가 번들에 실제로 들어갔는지 검증하는 게이트를 통과해야 배포된다.

**정답지 대조** (`038bb8f`, `111ed01`, `eba27ab`): 사람이 만든 워크북과 시스템 생성 워크북을
비교. `(channel, type, title)` identity multiset 매칭 후, 그룹 내에서 **최소비용 할당**
(작은 그룹은 비트마스크 DP, 큰 그룹은 헝가리안)으로 행을 짝짓는다 — 파일 내 행 순서와 무관하게
결정적. 14개 비즈니스 필드만 비교하고 수식/마스터 유래 컬럼은 제외.
어느 쪽이 틀렸는지 미리 단정하지 않는다(`candidate_correct` / `golden_correct` 둘 다 존재).

**조사 스레드** (`bd72a54`, migration 020): diff마다 `investigation_status` 7단계 +
`root_cause_stage` 10종(source/upload/parser/transform/identity/aggregation/carry/formula/
human_workbook/unknown). 확정 상태로 가려면 원인 요약이 있어야 한다는 DB 제약까지 걸려 있고,
코멘트는 append-only(UPDATE/DELETE 정책을 만들지 않음). CLI도 있다: `npm run settlement:investigations`.

**검수 UI** (`32be280`, `fa873b0`): 정답지 워크북 위에서 diff를 보는 `AnswerWorkbookReview`,
전체화면 스프레드시트 `SettlementSpreadsheetReview`(`/settlement-sheet/[id]`).

**마이그레이션**: 013(정산 초기 스키마) · 014 · 015(Storage 버킷) · 016(batch) ·
017~018(content master) · 019(비교 실행/차이) · 020(조사) · 021(차이 순번)

---

### 2026-04-05: Auth0 인증 + ADMIN 접근 제어 + 디자인 시스템 마이그레이션

**Auth0 인증 시스템 구현**
- BFF 패턴: Next.js Route Handlers가 Auth0 프록시 역할, 클라이언트에 Auth0 크리덴셜 미노출
- Access Token → 클라이언트 메모리, Refresh Token → HTTPOnly cookie (`X-REFRESH-TOKEN`)
- API Routes 5개: `/api/auth/login`, `/refresh`, `/logout`, `/forgot-password`, `/profile`
- `middleware.ts`: 쿠키 기반 라우트 보호 (미인증 → `/login` 리다이렉트)
- `AuthProvider`: 앱 마운트 시 세션 복원, login/logout/refreshToken 관리

**ADMIN Role 접근 제어**
- Auth0 Post Login Action "Add Roles to Token"이 JWT에 `https://api.riverse.net/roles` claim 주입
- login/refresh API에서 JWT 디코딩 후 ADMIN role 체크 → 비관리자 403 거부
- Auth0에서 role 제거 시 다음 refresh 시점에 자동 차단

**디렉토리 구조 재편**
- 기존 8개 페이지 → `app/(protected)/`로 이동 (URL 변경 없음)
- `app/(public)/login/page.tsx` 신규 (사이드바 없는 독립 페이지)
- `app/(protected)/layout.tsx`: ClientLayout 래퍼

**디자인 시스템 마이그레이션**
- `globals.css`: WCMS 디자인 시스템 기반으로 교체
  - Shadcn UI 시맨틱 토큰 (`--primary`, `--background`, `--foreground` 등)
  - `riverse-blue` / `riverse-slate` 팔레트 (Primary: `#003b71`)
  - `.dark` 클래스 기반 다크 모드 (기존 `.theme-light` 제거)
  - `tw-animate-css` 통합
  - 기존 38개 컴포넌트용 `var(--color-*)` 호환 레이어 유지
- 로그인 페이지: 2컬럼 (네이비 대시보드 프리뷰 + 로그인 폼), Tailwind 시맨틱 토큰
- ClientLayout: `.dark` 클래스 전환, `var(--sidebar)` 사용, 사용자 프로필 + 로그아웃 버튼

**Auth0 환경변수**
- `.env.local` 설정 완료 (AUTH0_DOMAIN, CLIENT_ID/SECRET, AUDIENCE, M2M)
- Vercel 환경변수: 미설정 (Dashboard에서 수동 추가 필요)

**Auth0 Dashboard 확인사항**
- Tenant: `riverse.jp.auth0.com` (JP 리전)
- Application: WCMS (Regular Web Application) — Password Grant 활성화됨
- API: Riverse API (`https://api.riverse.net`) — Allow Offline Access 활성화됨
- M2M: Riverse API (Machine to Machine) — 프로필 수정용
- Roles: ADMIN / STAFF / USER 3개 존재
- Actions: "Add Roles to Token" Post Login Action 배포됨

**변경 파일**: `app/api/auth/*`, `middleware.ts`, `src/providers/AuthProvider.tsx`, `app/(public)/login/page.tsx`, `app/(protected)/layout.tsx`, `app/layout.tsx`, `app/globals.css`, `src/components/layout/ClientLayout.tsx`, `.env.local`, `.env.example`

---

### 2026-03-11: 플랫폼 다이나믹스 → 플랫폼별 분석 통합 `64c6ded`

**문제**: 플랫폼 다이나믹스 페이지의 HHI(허핀달-허쉬만 지수) 등 경제학 전문 용어가 경영진에게도 이해 불가. 플랫폼별 분석과 내용 중복(같은 데이터, 같은 스택 차트).

**해결**:
- `PlatformDynamics.tsx` 삭제, `PlatformAnalysis.tsx`에 통합
- HHI 게이지 → **매출 분산 현황** 카드로 교체:
  - 신호등 (초록/노랑/빨강) + 한줄 설명 ("전체 매출의 48%가 piccoma에 집중")
  - 수평 누적 바로 전체 플랫폼 비중 시각화
  - top1 점유율 기준: <40% 양호, 40-60% 주의, >60% 경고
- 통합 4섹션: 매출 분산 현황 → 전월 대비 변동 → 플랫폼 상세(탭) → 점유율 추이(%)
- `/dynamics` → `/platforms` 리다이렉트 추가
- 사이드바 8개 → 7개 메뉴

**변경 파일**: `PlatformAnalysis.tsx`, `PlatformDynamics.tsx`(삭제), `App.tsx`, `Sidebar.tsx`, `ko.json`, `ja.json`

---

### 2026-03-11: 통합 업로더 `3e05079`

**문제**: 데이터 업로드가 2곳에 분산 — Sidebar의 DataUploader (리포트 Excel) + RawData의 RawDataUploader (속보치). 사용자 혼란.

**해결**:
- `DataUploader.tsx` 완전 재작성 (두 업로더 기능 통합)
- 파일 드래그 시 자동 분류: `reportExcel` (Daily_raw 시트) vs 속보치 (mechacomic/cmoa/piccoma)
- 3가지 업로드 모드: `report` (전체 교체), `raw` (머지), `mixed` (리포트 기반 + 속보치 머지)
- 폴더 드래그 지원 (`webkitGetAsEntry` API로 재귀 탐색)
- 기존 데이터 on-demand 로드: 캐시 → Supabase → static JSON 순서
- `mergeDailySales()`로 중복 방지 (같은 채널+날짜 범위 제거 후 추가)
- Weekly Report 자동 다운로드
- Sidebar API 변경 없음 (같은 `{ open, onClose }` props)
- `RawData.tsx`에서 속보치 업로드 버튼 제거

**변경 파일**: `DataUploader.tsx`, `RawData.tsx`, `platformParsers.ts`(이전 세션)

---

### 2026-03-03: PeriodAnalysis 흰색 페이지 수정 `d608a43`

**문제**: 기간별 분석 페이지가 완전히 흰색으로 나옴.

**원인**: React Rules of Hooks 위반 — 조건부 early return 아래에 `useMemo` 호출. `if (data.loading) return <skeleton>` 뒤에 useMemo가 있어서 Hook 호출 순서가 변함.

**해결**: 모든 `useMemo`를 early return 위로 이동.

---

### 2026-03-03: 근본적 성능 해결 `070f4ce`

**문제**: 이전 배치 페이지네이션(75번 순차 요청)이 ~30초 걸려서 초기 로딩이 멈춘 것처럼 보임.

**해결**:
- 모듈 레벨 캐시 도입 (React 외부에서 데이터 보관)
- `Promise.all()`로 Supabase 4개 summary 테이블 병렬 요청 (~1초)
- `useDailySales()` 훅: 필요한 페이지에서만 lazy load
- session storage 연동: 새로고침 시 즉시 복원

---

### 2026-03-03: 서버사이드 페이지네이션 `c2b62cf`

**문제**: daily_sales 74,934행을 클라이언트에서 전부 로드하면 브라우저가 멈춤.

**해결**:
- `fetchDailySalesPage()`: Supabase `.range()` + 필터 + 정렬 → 50행씩 반환
- `fetchAllDailySales()`: PeriodAnalysis, CSV 다운로드용 전체 로드 (on-demand)
- `getActiveDatasetId()`: 모듈 변수에 캐싱
- RawData.tsx: `useEffect` 기반 서버사이드 쿼리로 전환
- PeriodAnalysis.tsx: 페이지 방문 시 lazy load + 로딩 스켈레톤

---

### 2026-03-03: Supabase 1000행 제한 해결 `858d1e8`

**문제**: Supabase 기본 `.select()` 최대 1,000행만 반환.

**해결**: `fetchAllRows()` 배치 루프 — 1,000행씩 반복 요청하여 전체 데이터 수집. (이후 서버사이드 페이지네이션으로 대체)

---

### 2026-02-27: 속보치 데이터 자동 취합 시스템 `f2d73a1`

- `platformParsers.ts`: mechacomic (CSV), cmoa (Excel Q003), piccoma (CSV) 자동 파싱
- `RawDataUploader.tsx`: 드래그앤드롭 → 자동 분류 → 미인식 파일 매핑 UI → 파싱 → 프리뷰 → 적용
- `dataConsolidator.ts`: `mergeDailySales()` + `rebuildDataset()` — 기존 데이터와 새 데이터 병합
- `reportGenerator.ts`: Weekly Report Excel 자동 생성
- Supabase `uploadDatasetToSupabase()` 연동

---

### 2026-02-27: AI 인사이트 → 주요 이슈 브리핑 `a2911a7`

- "AI 인사이트" 타이틀을 "주요 이슈 브리핑"으로 변경
- 사이트 톤에 맞게 디자인 조정

---

### 2026-02-27: UI 디테일 조정 `dbb006a`, `cdb1401`

- KPI 카드 폰트 확대 (text-xs → text-sm)
- 총매출 카드에 날짜 범위 표시
- TOP 바차트 hover 커서 제거 + 미세 하이라이트 추가

---

### 2026-02-27: 파비콘 + 브라우저 탭 `43557f0` ~ `4d3d9e7`

- Riverse 로고 파비콘 적용 (ico + png)
- 브라우저 탭 타이틀: "매출 현황 보드"
- 사이드바 상단: Riverse 로고 이미지 + 부제

---

### 2026-02-27: 전면 리디자인 `a1c5ee3`

- Shadcn UI 스타일 컴포넌트 도입 (card, badge, table, tabs 등)
- 매출 구조 분석 (`SalesStructure.tsx`): 작품 집중도 + 플랫폼 다각화 + 안정성 + 히트맵
- 플랫폼 다이나믹스 (`PlatformDynamics.tsx`): HHI + 의존도 + MoM → **이후 통합됨**
- 트렌드 (`Trends.tsx`): 성장률 TOP + 하락 경고 + 요일 패턴 + 신규 작품

---

### 2026-02-27: 플랫폼 브랜드 시스템 `955d959`, `697e325`

- `platformConfig.ts`: 플랫폼별 브랜드 컬러, 배경색, 테두리 정의
- `PlatformIcon.tsx`: 실제 로고 이미지 (`public/icons/`)
- 전체 차트/배지/탭에 일관된 브랜드 컬러 적용

---

### 2026-02-27: 작품별 분석 리디자인 `f01eac7`

- 좌우 분할 레이아웃 (작품 리스트 + 상세 분석)
- 도넛 차트 라벨 겹침 수정
- 모바일 반응형 UI

---

### 2026-02-26: 초기 릴리스 `4af65e1`

- RVJP 매출 대시보드 v1.0
- 프리미엄 화이트 테마 + RIVERSE 브랜딩
- Vercel SPA 라우팅 설정 (`vercel.json`)

---

## Supabase

- 환경변수: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`(서버 전용), `SUPABASE_DATABASE_URL`(정산 비교 API의 Postgres pooler)
- 대시보드 테이블: `daily_sales_v2`, `titles`, `platforms`, `genres`, `initial_sales`,
  `title_platform_availability`, `audit_logs`, `upload_logs` + 집계 RPC
- 정산 테이블: `raw_uploads`, `raw_records`, `sales_records`, `clients`, `channels`,
  `rs_rules`, `settlement_comparison_runs`, `settlement_comparison_diffs`,
  `settlement_comparison_comments`, `content_master`
- RLS: authenticated 전용. **단, API 라우트는 service role 키를 쓰므로 RLS를 우회한다** —
  인가는 `requireApiAuth`가 담당한다.

---

## 빌드 & 배포

```bash
npm install
npm run dev          # 개발 서버
npm run build        # 프로덕션 빌드
npm run lint
npx tsc --noEmit
npm run deploy       # canvas 바인딩 확보 → 빌드 → 번들 검증 → prebuilt 배포
```

- `main` push → Vercel 자동 배포 (hnd1 도쿄 리전)
- 정산 업로드(OCR) 관련 변경은 `npm run deploy`로 — 번들 검증 게이트를 거친다
- `/api/health`를 5분마다 호출하는 cron으로 콜드 스타트를 방지한다 (`vercel.json`)

---

## 알려진 사항

1. **스키마 이름 충돌** — 마이그레이션 001과 013이 `platforms` / `titles`를 서로 다른 id 타입
   (SERIAL vs uuid)으로 중복 정의한다. `create table if not exists`라 먼저 실행된 001만 살아있다.
   현재는 잠복 상태(정산 코드가 `titles`에서 `id, title_kr`만 읽고 `platform_id`를 쓰지 않음)이나,
   `raw_uploads.platform_id`에 값을 넣으려는 순간 타입 불일치로 깨진다.
2. **세션 즉시 폐기 불가** — stateless 서명 쿠키라 로그아웃해도 유출본은 TTL(60분)까지 유효하다.
3. **테스트가 타입체크에서 빠져 있다** — `tsconfig.json`의 `exclude`에 `scripts`가 있다.
4. **Storage RLS 미점검** — `app/(protected)/upload/page.tsx`가 브라우저에서 anon 키로
   `upload-debug` 버킷에 직접 업로드한다. 버킷 정책이 anon 쓰기를 허용하는지 확인이 필요하다.
