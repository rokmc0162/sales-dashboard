export type Translate = (ko: string, ja: string) => string;

export type DiffCategory = "missing" | "extra" | "field" | "formula";

export interface DisplayDiff {
  category: DiffCategory;
  field: string | null;
  candidate_value: unknown;
  golden_value: unknown;
}

export interface DisplayCell {
  field: string;
  label: string;
  text: string;
  formula?: string;
}

export interface DisplayValue {
  text: string;
  cells: DisplayCell[];
  hiddenCellCount: number;
  absent: boolean;
  formula?: string;
}

const MAX_TEXT_LENGTH = 90;
const MAX_ROW_CELLS = 20;
const MAX_FORMULA_LENGTH = 34;
const MAX_SERIALIZED_INPUT_LENGTH = 4_000;

const FIELD_LABELS: Record<string, { ko: string; ja: string }> = {
  unique_identifier: { ko: "고유번호", ja: "固有番号" },
  channel_title: { ko: "채널 작품명", ja: "チャネル作品名" },
  channel_title_jp: { ko: "채널 작품명", ja: "チャネル作品名" },
  title_kr: { ko: "한국어 작품명", ja: "韓国語タイトル" },
  title_jp: { ko: "일본어 작품명", ja: "日本語タイトル" },
  updated: { ko: "업데이트", ja: "更新" },
  recoder: { ko: "기록자", ja: "記録者" },
  company: { ko: "회사", ja: "会社" },
  launch_date: { ko: "런칭일", ja: "配信開始日" },
  sales_month: { ko: "매출월", ja: "売上月" },
  month: { ko: "월", ja: "月" },
  settlement_month: { ko: "정산월", ja: "精算月" },
  statement_received: { ko: "정산서 수령일", ja: "明細受領日" },
  deposit_month: { ko: "입금월", ja: "入金月" },
  country: { ko: "국가", ja: "国" },
  clients: { ko: "거래처", ja: "取引先" },
  channel: { ko: "채널", ja: "チャネル" },
  type: { ko: "유형", ja: "種別" },
  distribution_strategy: { ko: "배포 전략", ja: "配信戦略" },
  settlement_currency: { ko: "정산 통화", ja: "精算通貨" },
  vehicle_currency: { ko: "차량 통화", ja: "ビークル通貨" },
  total_amount_jpy: { ko: "총액 JPY", ja: "総額 JPY" },
  fee_jpy: { ko: "수수료 JPY", ja: "手数料 JPY" },
  before_tax_jpy: { ko: "세전 JPY", ja: "税抜 JPY" },
  after_tax_jpy: { ko: "세후 JPY", ja: "税込 JPY" },
  rs: { ko: "RS", ja: "RS" },
  before_tax_income_jpy: { ko: "세전 수익 JPY", ja: "税抜収益 JPY" },
  withholding_tax_jpy: { ko: "원천세 JPY", ja: "源泉税 JPY" },
  tax_jpy: { ko: "세금 JPY", ja: "税金 JPY" },
  after_tax_income_jpy: { ko: "세후 수익 JPY", ja: "税込収益 JPY" },
  after_tax_income_vehicle: { ko: "세후 수익 차량통화", ja: "税込収益ビークル通貨" },
  exchange_rate: { ko: "환율", ja: "為替レート" },
  rate_krw_krw: { ko: "KRW 환율", ja: "KRW レート" },
  fee_krw: { ko: "수수료 KRW", ja: "手数料 KRW" },
  before_tax_krw: { ko: "세전 KRW", ja: "税抜 KRW" },
  after_tax_krw: { ko: "세후 KRW", ja: "税込 KRW" },
  after_tax_income_krw: { ko: "세후 수익 KRW", ja: "税込収益 KRW" },
  vat_krw: { ko: "부가세 KRW", ja: "消費税 KRW" },
  withholding_tax_krw: { ko: "원천세 KRW", ja: "源泉税 KRW" },
  sales_krw: { ko: "매출 KRW", ja: "売上 KRW" },
  mg_begin: { ko: "MG 시작", ja: "MG 開始" },
  mg_increase: { ko: "MG 증가", ja: "MG 増加" },
  mg_decrease: { ko: "MG 감소", ja: "MG 減少" },
  mg_end: { ko: "MG 종료", ja: "MG 終了" },
  note1: { ko: "메모 1", ja: "メモ 1" },
  note2: { ko: "메모 2", ja: "メモ 2" },
  allocation_rate: { ko: "배분율", ja: "配分率" },
  total_allocation_rate: { ko: "총 배분율", ja: "総配分率" },
  distribution_coop_rate: { ko: "배포 협력율", ja: "配信協力率" },
  production_participation_rate: { ko: "제작 참여율", ja: "制作参加率" },
  creator_category: { ko: "작가 구분", ja: "クリエイター区分" },
  creator_allocation_rate: { ko: "작가 배분율", ja: "クリエイター配分率" },
};

const ROW_FIELD_PRIORITY = [
  "unique_identifier",
  "channel_title_jp",
  "channel_title",
  "title_jp",
  "title_kr",
  "channel",
  "type",
  "clients",
  "total_amount_jpy",
  "fee_jpy",
  "before_tax_jpy",
  "after_tax_jpy",
  "rs",
  "before_tax_income_jpy",
  "withholding_tax_jpy",
  "tax_jpy",
  "after_tax_income_jpy",
  "sales_month",
  "settlement_month",
  "deposit_month",
  "month",
  "launch_date",
  "statement_received",
  "company",
  "country",
  "distribution_strategy",
  "settlement_currency",
  "vehicle_currency",
  "exchange_rate",
  "rate_krw_krw",
  "fee_krw",
  "before_tax_krw",
  "after_tax_krw",
  "after_tax_income_vehicle",
  "after_tax_income_krw",
  "vat_krw",
  "withholding_tax_krw",
  "sales_krw",
  "mg_begin",
  "mg_increase",
  "mg_decrease",
  "mg_end",
  "allocation_rate",
  "total_allocation_rate",
  "distribution_coop_rate",
  "production_participation_rate",
  "creator_category",
  "creator_allocation_rate",
  "updated",
  "recoder",
  "note1",
  "note2",
];

export function fieldLabel(field: string | null | undefined, t: Translate): string {
  if (!field) return "-";
  const label = FIELD_LABELS[field];
  if (label) return t(label.ko, label.ja);
  return field
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function truncateText(text: string, limit = MAX_TEXT_LENGTH): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonLikeString(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function isScalarSnapshot(value: unknown): value is { state: unknown; value?: unknown; formula?: unknown } {
  if (!isRecord(value)) return false;
  return value.state === "blank" || value.state === "value" || value.state === "formula";
}

function isRowDigest(value: unknown): value is { row?: unknown; cells: Record<string, unknown> } {
  return isRecord(value) && isRecord(value.cells) && ("row" in value || "cells" in value);
}

function decodeKnownSerialized(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.length === 0 || value.length > MAX_SERIALIZED_INPUT_LENGTH) return value;
  if (!isJsonLikeString(value)) return value;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (isScalarSnapshot(parsed) || isRowDigest(parsed)) return parsed;
  } catch {
    return value;
  }

  return value;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export function scalarText(value: unknown): string {
  value = decodeKnownSerialized(value);
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return truncateText(value);
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return String(value);
  if (isRecord(value)) {
    if (value.state === "blank") return "-";
    if ("value" in value) return scalarText(value.value);
  }
  return truncateText(String(value));
}

function formulaText(value: unknown): string | undefined {
  value = decodeKnownSerialized(value);
  if (!isRecord(value)) return undefined;
  const formula = typeof value.formula === "string" ? value.formula : undefined;
  return formula ? truncateText(formula, MAX_FORMULA_LENGTH) : undefined;
}

function rowCells(value: unknown): Record<string, unknown> | null {
  value = decodeKnownSerialized(value);
  if (!isRecord(value) || !isRecord(value.cells)) return null;
  return value.cells;
}

function sortedCellEntries(cells: Record<string, unknown>): Array<[string, unknown]> {
  const entries = Object.entries(cells);
  const priority = new Map(ROW_FIELD_PRIORITY.map((field, index) => [field, index]));
  return entries.sort(([a], [b]) => {
    const ai = priority.get(a) ?? Number.MAX_SAFE_INTEGER;
    const bi = priority.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

export function displayValue(value: unknown, t: Translate, absent = false): DisplayValue {
  if (absent) return { text: t("이 행이 없습니다", "この行はありません"), cells: [], hiddenCellCount: 0, absent: true };
  const cells = rowCells(value);
  if (!cells) {
    return {
      text: scalarText(value),
      cells: [],
      hiddenCellCount: 0,
      absent: false,
      formula: formulaText(value),
    };
  }
  const entries = sortedCellEntries(cells);
  const visibleEntries = entries.slice(0, MAX_ROW_CELLS);
  return {
    text: t("행의 주요 셀", "行の主要セル"),
    cells: visibleEntries.map(([field, cellValue]) => ({
      field,
      label: fieldLabel(field, t),
      text: scalarText(cellValue),
      formula: formulaText(cellValue),
    })),
    hiddenCellCount: Math.max(0, entries.length - visibleEntries.length),
    absent: false,
  };
}

function numericValue(value: unknown): number | null {
  value = decodeKnownSerialized(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (isRecord(value)) return numericValue(value.value);
  return null;
}

export function numericDeltaText(systemValue: unknown, humanValue: unknown, t: Translate): string | null {
  const system = numericValue(systemValue);
  const human = numericValue(humanValue);
  if (system === null || human === null) return null;
  const delta = system - human;
  const sign = delta > 0 ? "+" : "";
  return t(`시스템-사람 ${sign}${formatNumber(delta)}`, `システム-人 ${sign}${formatNumber(delta)}`);
}

export function categorySentence(diff: DisplayDiff, t: Translate): string {
  if (diff.category === "missing") {
    return t(
      "사람 작업본에는 이 행이 있지만 시스템 정리본에는 없습니다.",
      "人の作業版にはこの行がありますが、システム整理版にはありません。",
    );
  }
  if (diff.category === "extra") {
    return t(
      "시스템 정리본에는 이 행이 있지만 사람 작업본에는 없습니다.",
      "システム整理版にはこの行がありますが、人の作業版にはありません。",
    );
  }
  const label = fieldLabel(diff.field, t);
  const human = scalarText(diff.golden_value);
  const system = scalarText(diff.candidate_value);
  const delta = numericDeltaText(diff.candidate_value, diff.golden_value, t);
  if (diff.category === "formula") {
    return t(
      `${label}의 상태 또는 수식이 다릅니다. 사람 작업본 ${human} → 시스템 정리본 ${system}${delta ? ` (${delta})` : ""}`,
      `${label}の状態または数式が異なります。人の作業版 ${human} → システム整理版 ${system}${delta ? ` (${delta})` : ""}`,
    );
  }
  return t(
    `${label}: 사람 작업본 ${human} → 시스템 정리본 ${system}${delta ? ` (${delta})` : ""}`,
    `${label}: 人の作業版 ${human} → システム整理版 ${system}${delta ? ` (${delta})` : ""}`,
  );
}
