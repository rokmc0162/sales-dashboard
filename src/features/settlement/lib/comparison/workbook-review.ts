import type {
  ComparisonDiffReviewStatus,
  ComparisonInvestigationStatus,
  ComparisonRootCauseStage,
  Json,
  SettlementComparisonDiffRow,
} from "../supabase/types";
import type { ComparisonDiffFinding, ComparisonLocation } from "./compare";
import {
  COMPARE_FIELDS,
  excelCellAddress,
  excelColumnLetter,
  type CellSnapshot,
  type CompareField,
  type InputRowSnapshot,
  type InputSheetSnapshot,
  type SemanticValue,
} from "./workbook";

export const DEFAULT_WORKBOOK_REVIEW_CONTEXT_ROWS = 2;
export const MAX_WORKBOOK_REVIEW_ROWS = 400;
export const MAX_WORKBOOK_REVIEW_COLUMNS = 64;
export const MAX_WORKBOOK_REVIEW_CELLS = 20_000;
export const MAX_WORKBOOK_REVIEW_TEXT_LENGTH = 200;

const MAX_BOUNDED_JSON_DEPTH = 5;
const MAX_BOUNDED_JSON_ENTRIES = 64;

export interface WorkbookReviewColumn {
  field: CompareField;
  column: number;
  letter: string;
}

export interface WorkbookReviewOverlay {
  diff_id: string;
  category: ComparisonDiffFinding["category"];
  field: string | null;
  review_status: ComparisonDiffReviewStatus;
  review_note: string | null;
  investigation_status: ComparisonInvestigationStatus;
  root_cause_stage: ComparisonRootCauseStage | null;
  root_cause_summary: string | null;
  candidate_location: ComparisonLocation | null;
  golden_location: ComparisonLocation | null;
  system_value: Json | null;
  answer_value: Json | null;
}

export interface WorkbookReviewCell {
  field: CompareField;
  column: number;
  /** Golden A1 address; null for a system-only row projected into golden columns. */
  address: string | null;
  state: CellSnapshot["state"];
  value: SemanticValue;
  formula: string | null;
  known: boolean;
  overlays: WorkbookReviewOverlay[];
}

export interface WorkbookReviewRow {
  kind: "answer" | "system-only";
  sheet: string;
  row: number;
  address: string;
  cells: WorkbookReviewCell[];
  row_overlays: WorkbookReviewOverlay[];
}

export interface WorkbookReview {
  sheet_name: string;
  columns: WorkbookReviewColumn[];
  rows: WorkbookReviewRow[];
  context_rows: number;
  row_limit: number;
  total_relevant_rows: number;
  rows_truncated: boolean;
  diff_count: number;
  shown_diff_count: number;
}

export interface BuildWorkbookReviewOptions {
  contextRows?: number;
  maxRows?: number;
}

type FingerprintSource = {
  category: string;
  identity: readonly [string | null, string | null, string | null];
  field: string | null;
  candidate: Json | null;
  golden: Json | null;
};

type MappedFinding = {
  runtime: ComparisonDiffFinding;
  persisted: SettlementComparisonDiffRow;
};

function truncateText(value: string): string {
  return value.length > MAX_WORKBOOK_REVIEW_TEXT_LENGTH
    ? `${value.slice(0, MAX_WORKBOOK_REVIEW_TEXT_LENGTH - 1)}…`
    : value;
}

function boundedJson(value: Json | undefined, depth = 0): Json {
  if (value === undefined) return null;
  if (typeof value === "string") return truncateText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_BOUNDED_JSON_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_BOUNDED_JSON_ENTRIES)
      .map((item) => boundedJson(item, depth + 1));
  }
  const result: Record<string, Json> = {};
  for (const key of Object.keys(value).sort().slice(0, MAX_BOUNDED_JSON_ENTRIES)) {
    result[truncateText(key)] = boundedJson(value[key], depth + 1);
  }
  return result;
}

function boundedSemanticValue(value: SemanticValue): SemanticValue {
  return typeof value === "string" ? truncateText(value) : value;
}

function canonicalJson(value: Json | undefined): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

/** Stable fingerprint; object-key order never affects candidate/golden JSON matching. */
export function workbookReviewFingerprint(source: FingerprintSource): string {
  return canonicalJson([
    source.category,
    [...source.identity],
    source.field,
    source.candidate,
    source.golden,
  ]);
}

function runtimeFingerprint(finding: ComparisonDiffFinding): string {
  return workbookReviewFingerprint({
    category: finding.category,
    identity: [
      finding.identity.channel || null,
      finding.identity.type || null,
      finding.identity.title || null,
    ],
    field: finding.field,
    candidate: finding.candidate,
    golden: finding.golden,
  });
}

function persistedFingerprint(diff: SettlementComparisonDiffRow): string {
  return workbookReviewFingerprint({
    category: diff.category,
    identity: [diff.identity_channel, diff.identity_type, diff.identity_title],
    field: diff.field,
    candidate: diff.candidate_value,
    golden: diff.golden_value,
  });
}

function mapPersistedDiffs(
  findings: readonly ComparisonDiffFinding[],
  persistedDiffs: readonly SettlementComparisonDiffRow[],
): MappedFinding[] {
  if (persistedDiffs.length !== findings.length) {
    throw new Error("runtime and persisted comparison finding counts differ");
  }

  const byOrdinal = new Map<number, SettlementComparisonDiffRow>();
  for (const diff of persistedDiffs) {
    if (!Number.isInteger(diff.diff_ordinal)
      || diff.diff_ordinal < 0
      || diff.diff_ordinal >= findings.length
      || byOrdinal.has(diff.diff_ordinal)) {
      throw new Error("persisted comparison diff ordinals must be unique and contiguous");
    }
    byOrdinal.set(diff.diff_ordinal, diff);
  }

  return findings.map((runtime, index) => {
    const persisted = byOrdinal.get(index);
    if (!persisted) {
      throw new Error("persisted comparison diff ordinals must be unique and contiguous");
    }
    if (persistedFingerprint(persisted) !== runtimeFingerprint(runtime)) {
      throw new Error(`comparison diff fingerprint mismatch at ordinal ${index}`);
    }
    return { runtime, persisted };
  });
}

function boundedLocation(location: ComparisonLocation | null): ComparisonLocation | null {
  if (!location) return null;
  return { ...location, sheet: truncateText(location.sheet), address: truncateText(location.address) };
}

function toOverlay(mapped: MappedFinding): WorkbookReviewOverlay {
  return {
    diff_id: mapped.persisted.id,
    category: mapped.runtime.category,
    field: mapped.runtime.field,
    review_status: mapped.persisted.review_status,
    review_note: mapped.persisted.review_note === null
      ? null
      : truncateText(mapped.persisted.review_note),
    investigation_status: mapped.persisted.investigation_status,
    root_cause_stage: mapped.persisted.root_cause_stage,
    root_cause_summary: mapped.persisted.root_cause_summary === null
      ? null
      : truncateText(mapped.persisted.root_cause_summary),
    candidate_location: boundedLocation(mapped.runtime.candidate_location),
    golden_location: boundedLocation(mapped.runtime.golden_location),
    system_value: mapped.runtime.candidate === null ? null : boundedJson(mapped.runtime.candidate),
    answer_value: mapped.runtime.golden === null ? null : boundedJson(mapped.runtime.golden),
  };
}

function normalizedInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(0, Math.floor(value)), max);
}

function requireGoldenRow(
  golden: InputSheetSnapshot,
  byNumber: ReadonlyMap<number, InputRowSnapshot>,
  location: ComparisonLocation | null,
): InputRowSnapshot {
  if (!location || location.sheet !== golden.sheetName) {
    throw new Error("runtime finding does not map to the golden sheet");
  }
  const row = byNumber.get(location.row);
  if (!row) throw new Error("runtime finding does not map to a golden row");
  return row;
}

function rowDigestCells(value: Json | null): Record<string, Json | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const cells = value.cells;
  if (!cells || typeof cells !== "object" || Array.isArray(cells)) return {};
  return cells;
}

function blankCell(field: CompareField, column: number): WorkbookReviewCell {
  return {
    field,
    column,
    address: null,
    state: "blank",
    value: null,
    formula: null,
    known: true,
    overlays: [],
  };
}

function answerCell(
  row: InputRowSnapshot,
  column: WorkbookReviewColumn,
  overlays: WorkbookReviewOverlay[],
): WorkbookReviewCell {
  const cell = row.cells[column.field];
  return {
    field: column.field,
    column: column.column,
    address: excelCellAddress(row.rowNumber, column.column),
    state: cell.state,
    value: boundedSemanticValue(cell.value),
    formula: cell.formula === null ? null : truncateText(cell.formula),
    known: cell.known,
    overlays,
  };
}

function systemOnlyCell(
  column: WorkbookReviewColumn,
  values: Record<string, Json | undefined>,
): WorkbookReviewCell {
  const raw = values[column.field];
  if (raw === undefined) return blankCell(column.field, column.column);
  return {
    field: column.field,
    column: column.column,
    address: null,
    state: "value",
    value: typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
      ? boundedSemanticValue(raw)
      : null,
    formula: null,
    known: true,
    overlays: [],
  };
}

/**
 * Build the bounded, workbook-centered review projection without I/O.
 * Persisted findings are mapped by their comparison-time ordinal.
 */
export function buildWorkbookReview(
  golden: InputSheetSnapshot,
  findings: readonly ComparisonDiffFinding[],
  persistedDiffs: readonly SettlementComparisonDiffRow[],
  options: BuildWorkbookReviewOptions = {},
): WorkbookReview {
  const columns = COMPARE_FIELDS.map((field) => ({
    field,
    column: golden.columns[field],
    letter: excelColumnLetter(golden.columns[field]),
  })).sort((a, b) => a.column - b.column || COMPARE_FIELDS.indexOf(a.field) - COMPARE_FIELDS.indexOf(b.field));
  if (columns.length > MAX_WORKBOOK_REVIEW_COLUMNS) {
    throw new Error("golden workbook has too many review columns");
  }

  const contextRows = normalizedInteger(
    options.contextRows,
    DEFAULT_WORKBOOK_REVIEW_CONTEXT_ROWS,
    MAX_WORKBOOK_REVIEW_ROWS,
  );
  const requestedRows = normalizedInteger(
    options.maxRows,
    MAX_WORKBOOK_REVIEW_ROWS,
    MAX_WORKBOOK_REVIEW_ROWS,
  );
  const cellBoundRows = Math.floor(MAX_WORKBOOK_REVIEW_CELLS / Math.max(1, columns.length));
  const rowLimit = Math.min(requestedRows, cellBoundRows);
  const mapped = mapPersistedDiffs(findings, persistedDiffs);
  const goldenRowsByNumber = new Map(golden.rows.map((row) => [row.rowNumber, row]));
  const cellOverlays = new Map<number, Map<string, WorkbookReviewOverlay[]>>();
  const rowOverlays = new Map<number, WorkbookReviewOverlay[]>();
  const targetGoldenRows = new Set<number>();
  const systemOnly: Array<{ mapped: MappedFinding; overlay: WorkbookReviewOverlay }> = [];

  for (const item of mapped) {
    const { runtime } = item;
    const overlay = toOverlay(item);
    if (runtime.category === "extra") {
      if (!runtime.candidate_location || runtime.candidate_location.column !== null) {
        throw new Error("extra finding has no candidate row location");
      }
      systemOnly.push({ mapped: item, overlay });
      continue;
    }

    const row = requireGoldenRow(golden, goldenRowsByNumber, runtime.golden_location);
    targetGoldenRows.add(row.rowNumber);
    if (runtime.category === "missing") {
      if (runtime.golden_location?.column !== null) {
        throw new Error("missing finding must use a whole-row location");
      }
      const overlays = rowOverlays.get(row.rowNumber);
      if (overlays) overlays.push(overlay);
      else rowOverlays.set(row.rowNumber, [overlay]);
      continue;
    }

    if (!runtime.field || !(runtime.field in golden.columns)) {
      throw new Error("field finding does not map to a golden column");
    }
    const field = runtime.field as CompareField;
    if (runtime.golden_location?.column !== golden.columns[field]) {
      throw new Error("field finding has an inconsistent golden column");
    }
    const byField = cellOverlays.get(row.rowNumber) ?? new Map<string, WorkbookReviewOverlay[]>();
    const overlays = byField.get(field);
    if (overlays) overlays.push(overlay);
    else byField.set(field, [overlay]);
    cellOverlays.set(row.rowNumber, byField);
  }

  systemOnly.sort((a, b) => {
    const rowA = a.mapped.runtime.candidate_location?.row ?? 0;
    const rowB = b.mapped.runtime.candidate_location?.row ?? 0;
    return rowA - rowB;
  });

  const relevantAnswerRows = golden.rows
    .map((row, index) => {
      let distance = Number.POSITIVE_INFINITY;
      for (const target of targetGoldenRows) distance = Math.min(distance, Math.abs(row.rowNumber - target));
      return { row, index, distance };
    })
    .filter((entry) => entry.distance <= contextRows);
  const totalRelevantRows = relevantAnswerRows.length + systemOnly.length;

  let answerCapacity = Math.min(relevantAnswerRows.length, Math.ceil(rowLimit / 2));
  let systemCapacity = Math.min(systemOnly.length, Math.floor(rowLimit / 2));
  let unallocated = rowLimit - answerCapacity - systemCapacity;
  const extraAnswerCapacity = Math.min(relevantAnswerRows.length - answerCapacity, unallocated);
  answerCapacity += extraAnswerCapacity;
  unallocated -= extraAnswerCapacity;
  systemCapacity += Math.min(systemOnly.length - systemCapacity, unallocated);

  const systemOnlyShown = systemOnly.slice(0, systemCapacity);
  const selectedAnswerRows = relevantAnswerRows
    .slice()
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .slice(0, answerCapacity)
    .sort((a, b) => a.index - b.index);

  const answerRows: WorkbookReviewRow[] = selectedAnswerRows.map(({ row }) => ({
    kind: "answer",
    sheet: truncateText(golden.sheetName),
    row: row.rowNumber,
    address: `${row.rowNumber}:${row.rowNumber}`,
    cells: columns.map((column) =>
      answerCell(row, column, cellOverlays.get(row.rowNumber)?.get(column.field) ?? []),
    ),
    row_overlays: rowOverlays.get(row.rowNumber) ?? [],
  }));

  const systemRows: WorkbookReviewRow[] = systemOnlyShown.map(({ mapped: item, overlay }) => {
    const location = item.runtime.candidate_location;
    if (!location) throw new Error("extra finding has no candidate row location");
    const values = rowDigestCells(item.runtime.candidate);
    return {
      kind: "system-only",
      sheet: truncateText(location.sheet),
      row: location.row,
      address: truncateText(location.address),
      cells: columns.map((column) => systemOnlyCell(column, values)),
      row_overlays: [overlay],
    };
  });

  const rows = [...answerRows, ...systemRows];
  const shownDiffIds = new Set<string>();
  for (const row of rows) {
    for (const overlay of row.row_overlays) shownDiffIds.add(overlay.diff_id);
    for (const cell of row.cells) {
      for (const overlay of cell.overlays) shownDiffIds.add(overlay.diff_id);
    }
  }

  return {
    sheet_name: truncateText(golden.sheetName),
    columns,
    rows,
    context_rows: contextRows,
    row_limit: rowLimit,
    total_relevant_rows: totalRelevantRows,
    rows_truncated: totalRelevantRows > rows.length,
    diff_count: mapped.length,
    shown_diff_count: shownDiffIds.size,
  };
}
