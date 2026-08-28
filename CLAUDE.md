# RVJP Sales Dashboard

## 개요
일본 만화 플랫폼 매출 분석 + **정산(settlement) 자동화** 시스템.
대시보드(속보치 업로드 → DB 적재 → Weekly Report)와 정산 파이프라인(플랫폼 명세서 → INPUT 워크북 생성 → 정답지 대조) 두 축으로 구성된다. 코드 무게중심은 정산 쪽이다.

## 기술 스택
- Frontend: Next.js 16 (App Router) + React 19 + TypeScript
- UI: Tailwind CSS 4 + Framer Motion + Recharts + Radix UI
- Backend: Next.js API Routes → Supabase (PostgreSQL)
- 배포: Vercel (hnd1 도쿄 리전, GitHub 연동 자동 배포)
- URL: https://rvjp-dashboard.vercel.app

## 폴더 구조
- `app/` — 페이지 14개 + API Routes 59개
  - `(protected)/` — 인증 필요 페이지 10개
  - `(public)/login/` — 로그인 (서버 래퍼 + `LoginClient`)
  - `settlement-preview/[month]`, `settlement-sheet/[id]` — 독립 창. **route group 밖이지만 middleware matcher에는 포함된다**
- `src/features/settlement/` — 정산 파이프라인 (82 files)
  - `lib/parsers/` — 플랫폼 자동 감지(`registry.ts`) + 20종 전용 파서. 스캔 PDF는 `ocr-pdf.ts`
  - `lib/aggregation/` — 정규화 → `sales_records`, strict key 중복 억제
  - `lib/export/` — xlsx 템플릿 채우기, carry-forward
  - `lib/comparison/` — 정답지 대조(`compare.ts`), 조사 스레드(`investigation.ts`)
  - `lib/storage/` — 파싱 전 아카이브, 직접 업로드, heartbeat 스트리밍
  - `data/aliases/` — 플랫폼별 타이틀 별명 JSON 18개
- `src/components/` — 대시보드 UI
- `src/lib/` — `session.ts`(세션 서명), `api-auth.ts`(API 인증 가드), Supabase 클라이언트
- `src/utils/` — 플랫폼 설정, 업로드 파서, Excel 내보내기
- `scripts/` — 테스트 45개 + 시드 + 정산 CLI
- `supabase/migrations/` — 001~021

## 인증 — 새 라우트를 추가할 때 반드시 읽을 것
`/api/*`는 `middleware.ts` matcher에서 **제외**된다. 즉 미들웨어는 API를 보호하지 않는다.
그리고 `src/lib/supabase-server.ts`는 service role 키를 우선 사용하므로 RLS도 우회한다.

**따라서 새 API 라우트는 반드시 직접 가드를 호출해야 한다. 호출하지 않으면 완전히 공개된다.**

```ts
import { requireApiAuth } from "@/lib/api-auth";

export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);            // 조회
  if (unauthorized) return unauthorized;
}

export async function POST(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN", mutating: true });  // 쓰기
  if (unauthorized) return unauthorized;
}
```

- `mutating: true`는 `Origin` 동일 출처 검증을 추가한다 (CSRF).
- 정산 라우트는 `requireSettlementApiAuth(request)`를 쓴다 — 내부적으로 위 헬퍼를 호출한다.
- 공개 라우트는 `/api/health`(Vercel cron) 하나뿐이다.
- 세션은 `X-SESSION` HttpOnly 쿠키(HMAC-SHA256, TTL 60분). `SESSION_SECRET`이 없으면 fail-closed.
- `ALLOW_TEMP_LOGIN=1`은 임시 로그인 우회를 켠다. **프로덕션에서는 미설정.**

## 개발
```
npm run dev      개발 서버
npm run build    프로덕션 빌드
npm run lint     ESLint
npx tsc --noEmit 타입체크
```

## 테스트
프레임워크 없음. `node --import tsx` + `node:assert`, 전부 오프라인이라 시크릿 불필요.

```
npm run test:auth                            세션 서명 · API 인증 가드
npm run test:settlement                      파서 · 집계 · 비교 · 번들 검증
npm run test:settlement-investigation
npm run test:settlement-comparison-display
npm run test:settlement-workbook-review
npm run test:settlement-spreadsheet-review
npm run test:settlement-archive-download
```

CI(`.github/workflows/ci.yml`)가 push/PR마다 전체를 실행한다.
주의: `tsconfig.json`의 `exclude`에 `scripts`가 있어 **테스트 스크립트는 타입체크 대상이 아니다.**

## 배포
- `git push origin main` → Vercel 자동 빌드+배포
- `npm run deploy` → canvas 리눅스 바인딩 확보 → 빌드 → 번들 검증 → prebuilt 배포.
  OCR 네이티브 바인딩·언어 데이터가 번들에 실제로 포함됐는지 검사하는 게이트가 있으므로,
  정산 업로드(OCR) 관련 배포는 이 경로를 쓴다.

## 환경변수
`.env.example` 참조. 필수: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DATABASE_URL`, `SESSION_SECRET`, `AUTH0_*` 4종.

## 알려진 이슈
- 마이그레이션 001과 013이 `platforms` / `titles`를 서로 다른 id 타입으로 중복 정의한다.
  현재는 잠복 상태지만 `raw_uploads.platform_id`에 값을 넣으려는 순간 타입 불일치로 깨진다.
- 세션은 stateless라 로그아웃해도 이미 유출된 쿠키는 TTL(60분)까지 유효하다.
