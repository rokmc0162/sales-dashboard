// ============================================================
// Core domain types for RVJP Sales Dashboard v2
// ============================================================

/** 일일 매출 기록 (daily_sales_v2 테이블) */
export interface DailySale {
  id: number;
  title_jp: string;
  title_kr: string | null;
  channel: string;
  sale_date: string;
  sales_amount: number;
  data_source: 'weekly_report' | 'sokuhochi' | 'manual';
  is_preliminary: boolean;
}

/** 초기 매출 데이터 (런칭 후 D1~D8, W1~W12 매출 추적) */
export interface InitialSale {
  id: number;
  title_kr: string;
  platform_code: string;
  genre_kr: string | null;
  pf_genre: string | null;
  launch_type: string;
  launch_date: string;
  launch_episodes: number;
  d1: number; d2: number; d3: number; d4: number;
  d5: number; d6: number; d7: number; d8: number;
  w1: number; w2: number; w3: number; w4: number;
  w5: number; w6: number; w7: number; w8: number;
  w9: number; w10: number; w11: number; w12: number;
}

// ============================================================
// RPC response types (Dashboard / Platform / Title)
// ============================================================

/** 대시보드 KPI 집계 결과 (총매출, 이번달/전월, 전월대비 변화율, 활성 작품/플랫폼 수) */
export interface KPIData {
  total_sales: number;
  this_month_sales: number;
  last_month_sales: number;
  mom_change: number;
  active_titles: number;
  active_platforms: number;
}

/** 월별 매출 추이 행 */
export interface MonthlyTrendRow {
  month: string;
  total_sales: number;
}

/** 플랫폼별 매출 요약 행 */
export interface PlatformSummaryRow {
  channel: string;
  total_sales: number;
  title_count: number;
  avg_daily: number;
}

/** 매출 상위 작품 행 */
export interface TopTitleRow {
  title_jp: string;
  title_kr: string | null;
  channels: string[];
  total_sales: number;
  day_count: number;
}

/** ��장/하락 알림 행 (전월 대비 증감) */
export interface GrowthAlertRow {
  title_jp: string;
  title_kr: string | null;
  this_month: number;
  last_month: number;
  growth_pct: number;
}

/** 플���폼 상세 정보 (총매출, 월별 추이, 상위 작품 등) */
export interface PlatformDetailData {
  total_sales: number;
  title_count: number;
  daily_avg: number;
  monthly_trend: Array<{ month: string; sales: number }>;
  top_titles: Array<{ title_jp: string; title_kr: string | null; total_sales: number }>;
}

/** 작품별 매출 요약 행 */
export interface TitleSummaryRow {
  title_jp: string;
  title_kr: string | null;
  channels: string[];
  first_date: string;
  total_sales: number;
  day_count: number;
}

/** 작품 상세 정보 (총매출, 채널, 월별 추이, 플랫폼 비중, 최근 일별 매출) */
export interface TitleDetailData {
  total_sales: number;
  title_kr: string | null;
  channels: string[];
  monthly_trend: Array<{ month: string; sales: number }>;
  platform_breakdown: Array<{ channel: string; sales: number }>;
  daily_recent: Array<{ date: string; sales: number }>;
}

/** 매출 데이터 upsert 결과 */
export interface UpsertResult {
  inserted: number;
  updated: number;
}

/** 업로드 이력 로그 (upload_logs 테이블) */
export interface UploadLog {
  id: string;
  upload_type: string;
  source_file: string | null;
  row_count: number;
  status: string;
  error_message: string | null;
  storage_path: string | null;
  created_at: string;
}

// ============================================================
// Analysis types (Genre / Company / Format / Trend / Ranking)
// ============================================================

/** 장르별 매출 요약 (RPC 응답) */
export interface GenreSalesRow {
  genre_code: string;
  genre_kr: string;
  total_sales: number;
  title_count: number;
  avg_daily: number;
}

/** 제작사별 매출 요약 (RPC 응답) */
export interface CompanySalesRow {
  company_name: string;
  total_sales: number;
  title_count: number;
  avg_daily: number;
}

/** 콘텐츠 포맷별 매출 (웹툰/만화 등) */
export interface FormatSalesRow {
  content_format: string;
  total_sales: number;
  title_count: number;
}

/** 일별 매출 추이 행 */
export interface DailyTrendRow {
  day: string;
  total_sales: number;
}

/** 주별 매출 추이 행 */
export interface WeeklyTrendRow {
  week: string;
  total_sales: number;
}

/** 플랫폼x장르 교차 매출 매트릭스 행 */
export interface PlatformGenreMatrixRow {
  channel: string;
  genre_kr: string;
  total_sales: number;
}

/** 특정 기간의 KPI 집계 */
export interface PeriodKPIData {
  total_sales: number;
  active_titles: number;
  active_platforms: number;
}

/** 작품 랭킹 행 (현재/이전 기간 매출 및 순위 변동) */
export interface TitleRankingRow {
  title_jp: string;
  title_kr: string | null;
  channels: string[];
  current_sales: number;
  prev_sales: number;
  rank_change: number;
}

/** 플랫폼 건강도 월별 지표 */
export interface PlatformHealthMonth {
  month: string;
  total_sales: number;
  active_titles: number;
  daily_avg: number;
}

/** 플랫폼 건강도 응답 데이터 */
export interface PlatformHealthData {
  monthly_health: PlatformHealthMonth[];
}

/** 작품 마스터 정보 (titles 테이블 + 장르/제작사 조인) */
export interface TitleMasterRow {
  id: string;
  title_jp: string;
  title_kr: string | null;
  content_format: string;
  genre_id: number | null;
  genre_name?: string;
  production_company_id: number | null;
  company_name?: string;
  serial_status: string | null;
  latest_episode_count: number | null;
  service_launch_date: string | null;
  is_active: boolean;
}

/** base_title로 그룹화된 작품 요약 */
export interface GroupedTitleProduct extends TitleSummaryRow {
  product_type: string;
}

export interface GroupedTitle {
  base_title: string;
  products: GroupedTitleProduct[];
  total_sales: number;
  channels: string[];
}

/** 날짜 범위 (시작일~종료일) */
export interface DateRange {
  startDate: string;
  endDate: string;
}

/** 기간 프리셋 (이번달, 지난달, 분기, 연간, 최근 N일, 전체) */
export type DatePreset = 'thisMonth' | 'lastMonth' | 'thisQuarter' | 'thisYear' | 'last7days' | 'last30days' | 'last90days' | 'all';
