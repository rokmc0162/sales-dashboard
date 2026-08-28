# RVJP Sales Dashboard

Riverse Japan 매출 분석 대시보드 + 일본 만화 플랫폼 **정산(settlement) 자동화** 시스템.

- 배포: https://rvjp-dashboard.vercel.app
- 스택: Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Supabase (PostgreSQL) · Vercel (hnd1)

## 두 개의 서브시스템

**1. 매출 대시보드** — 플랫폼·작품별 매출 분석, 기간 비교, 리포트 내보내기
`app/(protected)/{dashboard,titles,platforms,reports,data,initial-sales,title-compare,titles-manage,upload,settings}`

**2. 정산 파이프라인** — 플랫폼 명세서를 받아 INPUT 워크북을 생성하고, 사람이 만든 정답지와 대조한다
`src/features/settlement/`

```
원본 파일 (xlsx/csv/PDF)
  ↓ 파싱 전에 Storage 아카이브 + sha256          storage/archive-before-parse.ts
  ↓ 플랫폼 자동 감지 (파일명·헤더·시트명 3신호)   parsers/registry.ts
  ↓ 20+ 전용 파서 (스캔 PDF는 로컬 OCR)          parsers/*.ts
  ↓ raw_records (jsonb 원본 보존)
  ↓ 정규화 + 중복 억제                            aggregation/to-sales-records.ts
  ↓ sales_records
  ↓ xlsx 템플릿 채우기                            export/input-v2-filler.ts
INPUT 워크북  →  정답지와 대조                     comparison/compare.ts
                 → 차이별 조사 스레드              comparison/investigation.ts
```

집영사(Shueisha) 명세서는 이미지 PDF라 서버에서 `tesseract.js` + `@napi-rs/canvas`로 OCR한다.
응답이 수 분간 비어 있어 연결이 끊기므로 heartbeat 스트리밍으로 유지한다.

## 로컬 실행

```bash
npm install
cp .env.example .env.local     # 값 채우기
npm run dev
```

로컬에서는 `ALLOW_TEMP_LOGIN=1`을 설정하면 숫자만 입력해 임시 접속할 수 있다.
이 값이 없으면 Auth0 이메일/비밀번호 로그인만 동작한다.

## 환경변수

| 변수 | 필수 | 설명 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✓ | Supabase 프로젝트 URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✓ | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | ✓ | 서버 전용. API 라우트가 RLS를 우회해 사용 |
| `SUPABASE_DATABASE_URL` | ✓ | 정산 비교 API가 쓰는 서버 전용 Postgres pooler URL |
| `SESSION_SECRET` | ✓ | 세션 쿠키 HMAC 서명 키. **없으면 로그인이 fail-closed** |
| `SESSION_SECRET_PREVIOUS` | | 시크릿 교체 중에만 설정. 이전 키로 서명된 세션을 유지 |
| `ALLOW_TEMP_LOGIN` | | `1`이면 임시 로그인 우회 활성화. **프로덕션에서는 미설정** |
| `AUTH0_DOMAIN` / `AUTH0_CLIENT_ID` / `AUTH0_CLIENT_SECRET` / `AUTH0_AUDIENCE` | ✓ | Auth0 로그인 |
| `AUTH0_M2M_CLIENT_ID` / `AUTH0_M2M_CLIENT_SECRET` | | 프로필 수정용 (선택) |

## 인증

Auth0 ROPG를 BFF 패턴으로 감싼다. 로그인 성공 시 두 개의 HttpOnly 쿠키가 발급된다.

- `X-SESSION` — HMAC-SHA256 서명 세션(`src/lib/session.ts`). TTL 60분. **모든 인가 판단의 근거**
- `X-REFRESH-TOKEN` — Auth0 refresh token. 갱신 시 ADMIN role을 재검사하고 세션을 재발급

`middleware.ts`는 페이지 요청에서 세션 **서명을 검증**한다. `/api/*`는 미들웨어 matcher에서
제외되므로, 각 라우트가 직접 `requireApiAuth`(`src/lib/api-auth.ts`)를 호출해야 한다 —
호출하지 않은 라우트는 완전히 공개된다. 쓰기 라우트는 ADMIN + 동일 출처(`Origin`)를 요구한다.

공개 라우트는 `/api/health`(Vercel cron) 하나뿐이다.

## 테스트

프레임워크 없이 `node --import tsx` + `node:assert`로 돌아간다. 전부 오프라인이라 시크릿이 필요 없다.

```bash
npm run test:auth                            # 세션 서명 · API 인증 가드
npm run test:settlement                      # 파서 · 집계 · 비교 · 번들 검증
npm run test:settlement-investigation        # 조사 스레드
npm run test:settlement-comparison-display   # 비교 결과 표시
npm run test:settlement-workbook-review      # 정답지 워크북 검수
npm run test:settlement-spreadsheet-review   # 전체화면 스프레드시트 검수
npm run test:settlement-archive-download     # 아카이브 다운로드
npm run lint
npx tsc --noEmit
```

CI(`.github/workflows/ci.yml`)가 push/PR마다 위 전체를 실행한다.

## 배포

- `main` push → Vercel 자동 빌드·배포
- `npm run deploy` → 리눅스 canvas 바인딩 확보 → 빌드 → **번들 검증** → prebuilt 배포.
  OCR에 필요한 네이티브 바인딩과 언어 데이터가 번들에 실제로 들어갔는지 확인하는 게이트가 있다.

## 디렉터리

```
app/                       페이지 14 + API 라우트 59
  (protected)/             인증 필요 페이지
  (public)/login/          로그인
  settlement-preview/      정산 미리보기 (독립 창)
  settlement-sheet/        정답지 전체화면 검수 (독립 창)
  api/
src/
  components/              대시보드 UI
  features/settlement/     정산 파이프라인 (파서·집계·내보내기·비교·조사)
  lib/                     session.ts, api-auth.ts, supabase 클라이언트
  utils/                   플랫폼 설정, 업로드 파서, Excel 내보내기
scripts/                   테스트 · 시드 · 정산 CLI
supabase/migrations/       001~021
```
