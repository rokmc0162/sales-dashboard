# RVJP 매출 대시보드 — 개발 로그

> **프로젝트**: Riverse Japan 프리미엄 매출 분석 대시보드
> **배포**: https://rvjp-dashboard.vercel.app
> **스택**: React 19 + TypeScript (strict) + Vite 7 + Tailwind CSS v4 + Recharts + framer-motion
> **백엔드**: Supabase (PostgreSQL) — daily_sales ~74,934행
> **마지막 업데이트**: 2026-03-11

---

## 프로젝트 구조

```
src/
├── App.tsx                          # 라우터 (7개 페이지 + /dynamics 리다이렉트)
├── main.tsx                         # 엔트리포인트
├── types/index.ts                   # 전체 타입 정의 (DailySale, Currency 등)
│
├── pages/
│   ├── ExecutiveSummary.tsx          # 경영 요약 — KPI 4개 + 차트 4개
│   ├── TitleAnalysis.tsx            # 작품별 분석 — 분할 레이아웃 + 상세
│   ├── PlatformAnalysis.tsx         # 플랫폼별 분석 (Dynamics 통합됨)
│   ├── PeriodAnalysis.tsx           # 기간별 분석 — lazy load dailySales
│   ├── SalesStructure.tsx           # 매출 구조 분석 — 집중도/안정성/히트맵
│   ├── Trends.tsx                   # 트렌드 — 성장률/하락/요일패턴/신규
│   └── RawData.tsx                  # 데이터 — 서버사이드 페이지네이션 50행
│
├── components/
│   ├── DataUploader.tsx             # 통합 업로더 (리포트 Excel + 속보치 자동감지)
│   ├── RawDataUploader.tsx          # [미사용] 구 속보치 업로더 (dead code)
│   ├── PlatformIcon.tsx             # 플랫폼 로고 아이콘 (public/icons/)
│   ├── AIPlatformMonitor.tsx        # 주요 이슈 브리핑
│   ├── charts/KPICard.tsx           # KPI 카드 컴포넌트
│   ├── layout/
│   │   ├── Layout.tsx               # 사이드바 + 콘텐츠 영역
│   │   ├── Sidebar.tsx              # 네비게이션 (7개 메뉴)
│   │   └── DashboardGrid.tsx        # 반응형 그리드
│   └── ui/                          # Shadcn 스타일 UI 컴포넌트
│       ├── card.tsx, badge.tsx, button.tsx, table.tsx
│       ├── tabs.tsx, select.tsx, input.tsx, separator.tsx
│       ├── skeleton.tsx, scroll-area.tsx, tooltip.tsx
│       ├── animated-number.tsx, chart-card.tsx, toggle-group.tsx
│       └── ...
│
├── hooks/
│   ├── useAppState.tsx              # 전역 상태 (language, currency, exchangeRate)
│   └── useDataLoader.ts            # 데이터 로드 + 모듈레벨 캐시 + session storage
│
├── lib/
│   ├── supabase.ts                  # Supabase 클라이언트 + 쿼리 함수들
│   ├── constants.ts                 # tooltipStyle, stagger 애니메이션 설정
│   └── utils.ts                     # cn() 유틸리티
│
├── utils/
│   ├── calculations.ts              # HHI, MoM, 성장률, 요일패턴, 집중도 등
│   ├── platformParsers.ts           # 플랫폼 파일 자동 분류 + 파싱
│   ├── platformConfig.ts            # 플랫폼 브랜드 컬러/이름 설정
│   ├── excelConverter.ts            # Excel → DailySale[] 변환
│   ├── dataConsolidator.ts          # mergeDailySales + rebuildDataset
│   ├── reportGenerator.ts           # Weekly Report Excel 생성
│   ├── formatters.ts                # formatSales, formatSalesShort
│   └── insights.ts                  # AI 브리핑 텍스트 생성
│
└── i18n/
    ├── index.ts                     # t() 함수
    ├── ko.json                      # 한국어
    └── ja.json                      # 일본어
```

---

## 작업 히스토리 (최신순)

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

## Supabase 설정

- **URL**: 환경변수 `VITE_SUPABASE_URL`
- **Anon Key**: 환경변수 `VITE_SUPABASE_ANON_KEY`
- **테이블**: `datasets`, `daily_sales`, `title_summary`, `platform_summary`, `monthly_summary`
- **RLS**: anon key로 select 허용

로컬에서 `.env` 파일 필요:
```
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

Supabase 미설정 시 `public/data/` 정적 JSON 파일로 폴백.

---

## 빌드 & 배포

```bash
npm install          # 의존성 설치
npm run dev          # 개발 서버 (localhost:5173)
npm run build        # 프로덕션 빌드 (tsc + vite)
```

- `main` 브랜치 push → Vercel 자동 배포
- 빌드 경고: `index.js` chunk 1MB+ (Recharts/framer-motion 무거움) — 기능에 영향 없음

---

## 알려진 사항

1. `RawDataUploader.tsx` — 통합 업로더 도입 후 미사용 (dead code). 삭제 가능.
2. `i18n`의 `dynamics.*`, `rawUpload.*` 키 — 더 이상 참조 없음. 정리 가능.
3. `icon/` 폴더 — 미사용 플랫폼 원본 이미지. gitignore 대상.
