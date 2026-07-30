import {
  signedNumericDeltaText,
  type DiffCategory,
  type DisplayValue,
  type Translate,
} from "./display";

export interface PresentationDiff {
  id?: string;
  category: DiffCategory;
  identity_channel: string | null;
  identity_type: string | null;
  identity_title: string | null;
  field: string | null;
  candidate_value: unknown;
  golden_value: unknown;
}

export interface DiffGroup<T extends PresentationDiff = PresentationDiff> {
  key: string;
  channel: string | null;
  type: string | null;
  title: string | null;
  diffs: T[];
}

export interface GroupCounts {
  missing: number;
  extra: number;
  valueDiffs: number;
  valueFieldCount: number;
}

export interface AlignedRow {
  field: string;
  label: string;
  human: { text: string; formula?: string } | null;
  system: { text: string; formula?: string } | null;
}

export interface AlignedRowTable {
  rows: AlignedRow[];
  hiddenCount: number;
}

export const MAX_ALIGNED_ROWS = 20;

const CATEGORY_ORDER: DiffCategory[] = ["missing", "extra", "field", "formula"];

// JSON tuple key: separator-safe and keeps null distinct from "".
export function groupIdentityKey(
  diff: Pick<PresentationDiff, "id" | "identity_channel" | "identity_type" | "identity_title">,
  fallbackIndex?: number,
): string {
  const identity = [diff.identity_channel, diff.identity_type, diff.identity_title];
  const complete = identity.every(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  if (!complete) {
    // Incomplete identities are unsafe to merge: unrelated missing/extra rows
    // can otherwise collapse into one misleading work group.
    return JSON.stringify(["__incomplete__", diff.id ?? fallbackIndex ?? null]);
  }
  return JSON.stringify([
    diff.identity_channel ?? null,
    diff.identity_type ?? null,
    diff.identity_title ?? null,
  ]);
}

export function groupDiffs<T extends PresentationDiff>(diffs: readonly T[]): DiffGroup<T>[] {
  const groups: DiffGroup<T>[] = [];
  const byKey = new Map<string, DiffGroup<T>>();
  for (const [index, diff] of diffs.entries()) {
    const key = groupIdentityKey(diff, index);
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        channel: diff.identity_channel,
        type: diff.identity_type,
        title: diff.identity_title,
        diffs: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.diffs.push(diff);
  }
  return groups;
}

export function groupCategories(diffs: readonly PresentationDiff[]): DiffCategory[] {
  const present = new Set(diffs.map((diff) => diff.category));
  return CATEGORY_ORDER.filter((category) => present.has(category));
}

export function groupCounts(diffs: readonly PresentationDiff[]): GroupCounts {
  let missing = 0;
  let extra = 0;
  let valueDiffs = 0;
  const valueFields = new Set<string>();
  for (const diff of diffs) {
    if (diff.category === "missing") missing += 1;
    else if (diff.category === "extra") extra += 1;
    else {
      valueDiffs += 1;
      valueFields.add(diff.field ?? "");
    }
  }
  return { missing, extra, valueDiffs, valueFieldCount: valueFields.size };
}

export function groupCountsLabel(counts: GroupCounts, t: Translate): string {
  const parts: string[] = [];
  if (counts.missing > 0) {
    parts.push(t(`시스템 누락 ${counts.missing}행`, `システム欠落${counts.missing}行`));
  }
  if (counts.extra > 0) {
    parts.push(t(`시스템 추가 ${counts.extra}행`, `システム追加${counts.extra}行`));
  }
  if (counts.valueDiffs > 0) {
    parts.push(t(`값 차이 ${counts.valueFieldCount}개 항목`, `値の差${counts.valueFieldCount}項目`));
  }
  return parts.join(" · ");
}

export function differenceText(diff: PresentationDiff, t: Translate): string {
  if (diff.category === "missing") return t("시스템에 행 없음", "システムに行なし");
  if (diff.category === "extra") return t("사람 작업본에 행 없음", "人の作業版に行なし");
  const delta = signedNumericDeltaText(diff.candidate_value, diff.golden_value);
  if (delta !== null) return delta;
  if (diff.category === "formula") return t("수식/상태 다름", "数式/状態が異なる");
  return t("내용 다름", "内容が異なる");
}

export function alignedRowTable(
  human: DisplayValue,
  system: DisplayValue,
  limit = MAX_ALIGNED_ROWS,
): AlignedRowTable {
  const humanCells = new Map(human.cells.map((cell) => [cell.field, cell]));
  const systemCells = new Map(system.cells.map((cell) => [cell.field, cell]));
  const order = [
    ...human.cells.map((cell) => cell.field),
    ...system.cells.filter((cell) => !humanCells.has(cell.field)).map((cell) => cell.field),
  ];
  const visible = order.slice(0, Math.max(0, limit));
  const rows = visible.map((field) => {
    const humanCell = humanCells.get(field);
    const systemCell = systemCells.get(field);
    return {
      field,
      label: humanCell?.label ?? systemCell?.label ?? field,
      human: humanCell ? { text: humanCell.text, formula: humanCell.formula } : null,
      system: systemCell ? { text: systemCell.text, formula: systemCell.formula } : null,
    };
  });
  const hiddenCount =
    order.length - visible.length + Math.max(human.hiddenCellCount, system.hiddenCellCount);
  return { rows, hiddenCount };
}

export function isValueDiffCategory(category: DiffCategory): boolean {
  return category === "field" || category === "formula";
}

// The "값 차이" quick filter spans two server categories (field + formula), so it
// is only offered as a client-side view when the current page already holds the
// complete result set for the active server filters.
export function canApplyValueViewFilter(input: {
  category: string;
  offset: number;
  totalDiffs: number;
  pageSize: number;
}): boolean {
  return input.category === "" && input.offset === 0 && input.totalDiffs <= input.pageSize;
}
