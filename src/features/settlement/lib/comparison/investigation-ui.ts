/**
 * Pure presentation helpers for the diff-investigation UI: KO/JA labels for
 * investigation statuses and root-cause stages, plus deterministic,
 * non-authoritative root-cause candidates ("원인 후보") derived only from a
 * diff's category/field. Candidates are hints for the operator — never a
 * confirmed cause; confirmation only comes from root_cause_stage/summary.
 */
import type { Translate } from "./display";
import type {
  ComparisonDiffCategory,
  ComparisonInvestigationStatus,
  ComparisonRootCauseStage,
} from "../supabase/types";

export const INVESTIGATION_STATUS_LABELS: Record<
  ComparisonInvestigationStatus,
  { ko: string; ja: string }
> = {
  uninvestigated: { ko: "조사 전", ja: "調査前" },
  question_pending: { ko: "질문 대기", ja: "質問対応待ち" },
  investigating: { ko: "조사 중", ja: "調査中" },
  cause_confirmed: { ko: "원인 확정", ja: "原因確定" },
  fix_in_progress: { ko: "수정 진행 중", ja: "修正対応中" },
  verification_pending: { ko: "검증 대기", ja: "検証待ち" },
  resolved: { ko: "해결됨", ja: "解決済み" },
};

export const ROOT_CAUSE_STAGE_LABELS: Record<
  ComparisonRootCauseStage,
  { ko: string; ja: string }
> = {
  source: { ko: "원본 자료", ja: "元資料" },
  upload: { ko: "업로드", ja: "アップロード" },
  parser: { ko: "파서", ja: "パーサー" },
  transform: { ko: "변환", ja: "変換" },
  identity: { ko: "식별 정보", ja: "識別情報" },
  aggregation: { ko: "집계", ja: "集計" },
  carry: { ko: "이월", ja: "繰越" },
  formula: { ko: "수식", ja: "数式" },
  human_workbook: { ko: "사람 작업본", ja: "人の作業版" },
  unknown: { ko: "원인 미상", ja: "原因不明" },
};

export function investigationStatusLabel(
  status: ComparisonInvestigationStatus,
  t: Translate,
): string {
  const label = INVESTIGATION_STATUS_LABELS[status];
  return label ? t(label.ko, label.ja) : status;
}

export function rootCauseStageLabel(stage: ComparisonRootCauseStage, t: Translate): string {
  const label = ROOT_CAUSE_STAGE_LABELS[stage];
  return label ? t(label.ko, label.ja) : stage;
}

const CONFIRMED_STATUSES = new Set<ComparisonInvestigationStatus>([
  "cause_confirmed",
  "fix_in_progress",
  "verification_pending",
  "resolved",
]);

export function hasConfirmedRootCause(
  status: ComparisonInvestigationStatus,
  stage: ComparisonRootCauseStage | null,
  summary: string | null,
): boolean {
  return CONFIRMED_STATUSES.has(status) && stage !== null && (summary ?? "").trim().length > 0;
}

export interface RootCauseCandidate {
  stage: ComparisonRootCauseStage;
  ko: string;
  ja: string;
}

// Fields that carry row identity: a value mismatch here points at identity
// normalization/matching rather than amounts.
const IDENTITY_FIELDS = new Set([
  "unique_identifier",
  "channel_title",
  "channel_title_jp",
  "title_kr",
  "title_jp",
  "channel",
  "type",
]);

const DATE_FIELDS = new Set([
  "launch_date",
  "updated",
  "sales_month",
  "month",
  "settlement_month",
  "deposit_month",
  "statement_received",
]);

// Amount/tax/RS fields. Suffix/prefix checks are deliberate: a substring
// check like includes("rate") would misclassify distribution_strategy.
function isAmountField(field: string): boolean {
  return (
    /(_jpy|_krw)$/.test(field) ||
    field === "rs" ||
    field.endsWith("_rate") ||
    field.startsWith("mg_")
  );
}

/**
 * Deterministic root-cause candidates for a diff. Purely a function of
 * category/field — no I/O, no randomness — so the same diff always shows the
 * same candidates. The returned texts describe possibilities only.
 */
export function suggestRootCauseCandidates(
  category: ComparisonDiffCategory,
  field: string | null,
): RootCauseCandidate[] {
  if (category === "missing") {
    return [
      {
        stage: "parser",
        ko: "파서가 원본 행을 놓쳤을 가능성",
        ja: "パーサーが元の行を取りこぼした可能性",
      },
      {
        stage: "identity",
        ko: "식별 정보 불일치로 행 매칭에 실패했을 가능성",
        ja: "識別情報の不一致で行の照合に失敗した可能性",
      },
      {
        stage: "carry",
        ko: "이월 행이 생성되지 않았을 가능성",
        ja: "繰越行が生成されなかった可能性",
      },
    ];
  }
  if (category === "extra") {
    return [
      {
        stage: "upload",
        ko: "중복 업로드로 행이 겹쳤을 가능성",
        ja: "重複アップロードで行が重なった可能性",
      },
      {
        stage: "identity",
        ko: "식별 정보 불일치로 별도 행이 생겼을 가능성",
        ja: "識別情報の不一致で別行が生じた可能性",
      },
      {
        stage: "carry",
        ko: "불필요한 이월 행이 생성되었을 가능성",
        ja: "不要な繰越行が生成された可能性",
      },
    ];
  }
  if (category === "formula") {
    return [
      {
        stage: "formula",
        ko: "수식 처리 규칙 차이 가능성",
        ja: "数式処理ルールの差の可能性",
      },
    ];
  }
  if (field && IDENTITY_FIELDS.has(field)) {
    return [
      {
        stage: "identity",
        ko: "식별 정보 정규화/매칭 차이 가능성",
        ja: "識別情報の正規化/照合の差の可能性",
      },
    ];
  }
  if (field && DATE_FIELDS.has(field)) {
    return [
      {
        stage: "transform",
        ko: "날짜·월 변환 또는 정산 주기(케이던스) 차이 가능성",
        ja: "日付・月変換または精算サイクル（ケイデンス）の差の可能性",
      },
    ];
  }
  if (field && isAmountField(field)) {
    return [
      {
        stage: "parser",
        ko: "파서가 금액 셀을 잘못 읽었을 가능성",
        ja: "パーサーが金額セルを読み違えた可能性",
      },
      {
        stage: "aggregation",
        ko: "집계 단계에서 합산이 달라졌을 가능성",
        ja: "集計段階で合算が変わった可能性",
      },
      {
        stage: "formula",
        ko: "수식 계산 차이 가능성",
        ja: "数式計算の差の可能性",
      },
    ];
  }
  return [
    {
      stage: "unknown",
      ko: "자동 후보 없음 — 직접 확인이 필요합니다",
      ja: "自動候補なし — 直接確認が必要です",
    },
  ];
}
