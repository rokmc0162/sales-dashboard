"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  Loader2,
  RefreshCcw,
  UploadCloud,
} from "lucide-react";

import { useApp } from "@/context/AppContext";
import {
  displayValue,
  fieldLabel,
  type DisplayValue,
} from "@/features/settlement/lib/comparison/display";
import {
  alignedRowTable,
  canApplyValueViewFilter,
  differenceText,
  groupCategories,
  groupCounts,
  groupCountsLabel,
  groupDiffs,
  isValueDiffCategory,
} from "@/features/settlement/lib/comparison/presentation";

type ReviewStatus =
  | "pending"
  | "candidate_correct"
  | "golden_correct"
  | "needs_review"
  | "resolved";
type DiffCategory = "missing" | "extra" | "field" | "formula";

type Summary = {
  candidate_rows?: number;
  golden_rows?: number;
  matched_rows?: number;
  exact_rows?: number;
  missing_rows?: number;
  extra_rows?: number;
  field_mismatches?: Record<string, number>;
  diff_total?: number;
  source_warnings?: string[];
  source_uploads_truncated?: boolean;
  source_uploads_observed_count_at_least?: number;
  persisted_diff_count?: number;
  diffs_truncated?: boolean;
};

type Run = {
  id: string;
  month: string;
  status: "processing" | "completed" | "failed";
  answer_filename: string;
  answer_sha256?: string | null;
  candidate_filename?: string | null;
  candidate_sha256?: string | null;
  summary?: Summary | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
};

type Diff = {
  id: string;
  category: DiffCategory;
  identity_channel: string | null;
  identity_type: string | null;
  identity_title: string | null;
  field: string | null;
  candidate_value: unknown;
  golden_value: unknown;
  review_status: ReviewStatus;
  review_note: string | null;
};

const REVIEW_STATUSES: ReviewStatus[] = [
  "pending",
  "candidate_correct",
  "golden_correct",
  "needs_review",
  "resolved",
];
const CATEGORIES: DiffCategory[] = ["missing", "extra", "field", "formula"];
const PAGE_SIZE = 100;
const MAX_ANSWER_BYTES = 3_500_000;

const CATEGORY_BADGE: Record<DiffCategory, string> = {
  missing: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-200",
  extra: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
  field: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-200",
  formula: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-200",
};

const CATEGORY_DOT: Record<DiffCategory, string> = {
  missing: "bg-red-500",
  extra: "bg-amber-500",
  field: "bg-sky-500",
  formula: "bg-violet-500",
};

const CATEGORY_DIFF_TEXT: Record<DiffCategory, string> = {
  missing: "text-red-700 dark:text-red-300",
  extra: "text-amber-700 dark:text-amber-300",
  field: "text-sky-700 dark:text-sky-300",
  formula: "text-violet-700 dark:text-violet-300",
};

type QuickFilter = "all" | "missing" | "extra" | "value";

function displayMonth(month: string) {
  return `${month.slice(0, 4)}-${month.slice(4, 6)}`;
}

function metric(value: unknown) {
  return typeof value === "number" ? value.toLocaleString() : "0";
}

export function latestCompletedRunIdFromResponse(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "";
}

export function displayedFieldMismatchTotal(summary: Summary | null | undefined): number {
  const fieldMismatches = summary?.field_mismatches;
  if (fieldMismatches) {
    return Object.values(fieldMismatches).reduce(
      (sum, count) => sum + (typeof count === "number" ? count : 0),
      0,
    );
  }
  const diffTotal = typeof summary?.diff_total === "number" ? summary.diff_total : 0;
  const missingRows = typeof summary?.missing_rows === "number" ? summary.missing_rows : 0;
  const extraRows = typeof summary?.extra_rows === "number" ? summary.extra_rows : 0;
  return Math.max(0, diffTotal - missingRows - extraRows);
}

function sideValue(diff: Diff, side: "human" | "system", t: (ko: string, ja: string) => string): DisplayValue {
  if (side === "human") return displayValue(diff.golden_value, t, diff.category === "extra");
  return displayValue(diff.candidate_value, t, diff.category === "missing");
}

function runStatusLabel(status: Run["status"], t: (ko: string, ja: string) => string) {
  const labels: Record<Run["status"], string> = {
    processing: t("처리 중", "処理中"),
    completed: t("완료", "完了"),
    failed: t("실패", "失敗"),
  };
  return labels[status] ?? status;
}

function reviewStatusLabel(status: ReviewStatus, t: (ko: string, ja: string) => string) {
  const labels: Record<ReviewStatus, string> = {
    pending: t("대기", "未確認"),
    candidate_correct: t("시스템 정리본이 맞음", "システム整理版が正しい"),
    golden_correct: t("사람 작업본이 맞음", "人の作業版が正しい"),
    needs_review: t("검토 필요", "要レビュー"),
    resolved: t("해결됨", "解決済み"),
  };
  return labels[status] ?? status;
}

function categoryLabel(category: DiffCategory, t: (ko: string, ja: string) => string) {
  const labels: Record<DiffCategory, string> = {
    missing: t("사람 작업본에만 있음", "人の作業版のみにあり"),
    extra: t("시스템에만 있음", "システムのみにあり"),
    field: t("값이 다름", "値が異なる"),
    formula: t("값이 다름", "値が異なる"),
  };
  return labels[category] ?? category;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function FormulaChip({ formula, t }: { formula: string; t: (ko: string, ja: string) => string }) {
  return (
    <span className="ml-1.5 inline-flex max-w-full rounded bg-violet-100 px-1.5 py-0.5 align-middle text-[10px] font-semibold text-violet-800 dark:bg-violet-950 dark:text-violet-200">
      {t("수식", "数式")} {formula}
    </span>
  );
}

export default function SettlementCompareClient({ month }: { month: string }) {
  const { t } = useApp();
  const answerInputRef = useRef<HTMLInputElement | null>(null);
  const loadRunsSeqRef = useRef(0);
  const loadRunDetailsSeqRef = useRef(0);
  const compareSeqRef = useRef(0);
  const patchDiffSeqRef = useRef(0);
  const currentMonthRef = useRef(month);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [run, setRun] = useState<Run | null>(null);
  const [diffs, setDiffs] = useState<Diff[]>([]);
  const [totalDiffs, setTotalDiffs] = useState(0);
  const [offset, setOffset] = useState(0);
  const [category, setCategory] = useState<DiffCategory | "">("");
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus | "">("");
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingDiffs, setLoadingDiffs] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [patchingId, setPatchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [answerFile, setAnswerFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [valueViewMode, setValueViewMode] = useState(false);

  currentMonthRef.current = month;

  const monthLabel = t(`${Number(month.slice(0, 4))}년 ${Number(month.slice(4, 6))}월`, `${Number(month.slice(0, 4))}年${Number(month.slice(4, 6))}月`);

  function clearMonthState() {
    setRuns([]);
    setSelectedRunId("");
    setRun(null);
    setDiffs([]);
    setTotalDiffs(0);
    setOffset(0);
    setCategory("");
    setReviewStatus("");
    setNotes({});
    setError(null);
    setAnswerFile(null);
    setDragActive(false);
    setLoadingDiffs(false);
    setExpandedGroups(new Set());
    setValueViewMode(false);
    if (answerInputRef.current) answerInputRef.current.value = "";
  }

  function invalidateRunDetails() {
    loadRunDetailsSeqRef.current += 1;
  }

  async function loadRuns(selectMode: "none" | "latest" | "latest-completed" = "none") {
    const requestSeq = ++loadRunsSeqRef.current;
    const requestMonth = month;
    setLoadingRuns(true);
    setError(null);
    try {
      const res = await fetch(`/api/settlement/comparisons?month=${requestMonth}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (requestSeq !== loadRunsSeqRef.current || requestMonth !== currentMonthRef.current) return;
      const nextRuns = (json.runs ?? []) as Run[];
      setRuns(nextRuns);
      if (nextRuns.length > 0 && selectMode === "latest") {
        invalidateRunDetails();
        setSelectedRunId(nextRuns[0].id);
      } else if (nextRuns.length > 0 && selectMode === "latest-completed") {
        // The API resolves this independently of the 50-item history window.
        const completedId = latestCompletedRunIdFromResponse(json.latest_completed_run_id);
        if (completedId) {
          invalidateRunDetails();
          setSelectedRunId(completedId);
        } else {
          invalidateRunDetails();
          setSelectedRunId("");
          setRun(null);
          setDiffs([]);
          setTotalDiffs(0);
          setNotes({});
        }
      } else if (nextRuns.length === 0) {
        invalidateRunDetails();
        setSelectedRunId("");
        setRun(null);
        setDiffs([]);
        setTotalDiffs(0);
        setNotes({});
      }
    } catch (e) {
      if (requestSeq !== loadRunsSeqRef.current || requestMonth !== currentMonthRef.current) return;
      setError((e as Error).message);
    } finally {
      if (requestSeq === loadRunsSeqRef.current && requestMonth === currentMonthRef.current) {
        setLoadingRuns(false);
      }
    }
  }

  async function loadRunDetails(id: string, nextOffset = offset) {
    const requestSeq = ++loadRunDetailsSeqRef.current;
    const requestMonth = month;
    if (!id) {
      setRun(null);
      setDiffs([]);
      setTotalDiffs(0);
      return;
    }
    setLoadingDiffs(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        offset: String(nextOffset),
        limit: String(PAGE_SIZE),
      });
      if (category) params.set("category", category);
      if (reviewStatus) params.set("review_status", reviewStatus);
      const res = await fetch(`/api/settlement/comparisons/${id}?${params.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (requestSeq !== loadRunDetailsSeqRef.current || requestMonth !== currentMonthRef.current) return;
      setRun(json.run as Run);
      const nextDiffs = (json.diffs ?? []) as Diff[];
      setDiffs(nextDiffs);
      setTotalDiffs(Number(json.pagination?.total ?? 0));
      setNotes(Object.fromEntries(nextDiffs.map((d) => [d.id, d.review_note ?? ""])));
      setExpandedGroups(new Set());
    } catch (e) {
      if (requestSeq !== loadRunDetailsSeqRef.current || requestMonth !== currentMonthRef.current) return;
      setError((e as Error).message);
    } finally {
      if (requestSeq === loadRunDetailsSeqRef.current && requestMonth === currentMonthRef.current) {
        setLoadingDiffs(false);
      }
    }
  }

  useEffect(() => {
    compareSeqRef.current += 1;
    patchDiffSeqRef.current += 1;
    setSubmitting(false);
    setPatchingId(null);
    invalidateRunDetails();
    clearMonthState();
    // Show this month's newest completed run right away; processing/failed
    // runs stay unselected so a broken result is never presented by default.
    void loadRuns("latest-completed");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  useEffect(() => {
    if (selectedRunId) void loadRunDetails(selectedRunId, offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId, offset, category, reviewStatus]);

  function applyAnswerFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setError(t("사람 작업본은 .xlsx 파일이어야 합니다.", "人の作業版は .xlsx である必要があります。"));
      return;
    }
    if (file.size > MAX_ANSWER_BYTES) {
      setError(t("사람 작업본 파일은 3.5MB 이하만 업로드할 수 있습니다.", "人の作業版ファイルは3.5MB以下のみアップロードできます。"));
      return;
    }
    setError(null);
    setAnswerFile(file);
  }

  function selectAnswer(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    applyAnswerFile(file);
  }

  function dropAnswer(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (submitting) return;
    const file = e.dataTransfer.files?.[0];
    if (file) applyAnswerFile(file);
  }

  function clearAnswer() {
    setAnswerFile(null);
    if (answerInputRef.current) answerInputRef.current.value = "";
  }

  async function compareAnswer() {
    if (!answerFile) return;
    const requestSeq = ++compareSeqRef.current;
    const requestMonth = month;
    const isCurrentRequest = () => requestSeq === compareSeqRef.current && requestMonth === currentMonthRef.current;
    setSubmitting(true);
    setError(null);
    // Cancel the initial/history list request before clearing the old run so it
    // cannot reselect a stale result while this comparison is in progress.
    loadRunsSeqRef.current += 1;
    // Drop the previous run immediately so its result and artifact links
    // cannot stay visible while this comparison runs or after it fails.
    invalidateRunDetails();
    setSelectedRunId("");
    setRun(null);
    setDiffs([]);
    setTotalDiffs(0);
    setOffset(0);
    setNotes({});
    setLoadingDiffs(false);
    try {
      const form = new FormData();
      form.append("month", requestMonth);
      form.append("answer", answerFile);
      const res = await fetch("/api/settlement/comparisons", { method: "POST", body: form });
      if (!isCurrentRequest()) return;
      const json = await res.json().catch(() => ({}));
      if (!isCurrentRequest()) return;
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      await loadRuns("latest");
      if (!isCurrentRequest()) return;
      if (json.run_id) {
        invalidateRunDetails();
        setSelectedRunId(String(json.run_id));
        setOffset(0);
      }
      setAnswerFile(null);
      if (answerInputRef.current) answerInputRef.current.value = "";
    } catch (e) {
      if (!isCurrentRequest()) return;
      const message = (e as Error).message;
      await loadRuns("none");
      if (!isCurrentRequest()) return;
      setError(message);
    } finally {
      if (isCurrentRequest()) {
        setSubmitting(false);
      }
    }
  }

  async function patchDiff(diff: Diff, status: ReviewStatus) {
    const requestSeq = ++patchDiffSeqRef.current;
    const requestMonth = month;
    const isCurrentRequest = () => requestSeq === patchDiffSeqRef.current && requestMonth === currentMonthRef.current;
    setPatchingId(diff.id);
    setError(null);
    try {
      const res = await fetch(`/api/settlement/comparisons/diffs/${diff.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ review_status: status, note: notes[diff.id] ?? "" }),
      });
      if (!isCurrentRequest()) return;
      const json = await res.json().catch(() => ({}));
      if (!isCurrentRequest()) return;
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const updated = json.diff as Diff;
      setDiffs((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
      setNotes((prev) => ({ ...prev, [updated.id]: updated.review_note ?? "" }));
    } catch (e) {
      if (!isCurrentRequest()) return;
      setError((e as Error).message);
    } finally {
      if (isCurrentRequest()) {
        setPatchingId(null);
      }
    }
  }

  const summary = run?.summary ?? null;
  const sourceWarnings = useMemo(
    () => (Array.isArray(summary?.source_warnings) ? summary.source_warnings : []),
    [summary],
  );
  const fieldMismatchEntries = useMemo(
    () =>
      Object.entries(summary?.field_mismatches ?? {})
        .filter(([, count]) => typeof count === "number" && count > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8),
    [summary],
  );
  const fieldMismatchTotal = useMemo(
    () => displayedFieldMismatchTotal(summary),
    [summary],
  );
  const pageStart = totalDiffs === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, totalDiffs);

  const valueFilterAvailable = canApplyValueViewFilter({
    category,
    offset,
    totalDiffs,
    pageSize: PAGE_SIZE,
  });
  const valueViewActive = valueViewMode && valueFilterAvailable;
  const visibleDiffs = useMemo(
    () => (valueViewActive ? diffs.filter((d) => isValueDiffCategory(d.category)) : diffs),
    [diffs, valueViewActive],
  );
  const diffGroups = useMemo(() => groupDiffs(visibleDiffs), [visibleDiffs]);
  const activeQuickFilter: QuickFilter | null = valueViewActive
    ? "value"
    : category === ""
      ? "all"
      : category === "missing" || category === "extra"
        ? category
        : null;

  function applyQuickFilter(mode: QuickFilter) {
    const nextCategory: DiffCategory | "" = mode === "missing" || mode === "extra" ? mode : "";
    setValueViewMode(mode === "value");
    if (nextCategory !== category || offset !== 0) {
      invalidateRunDetails();
      setCategory(nextCategory);
      setOffset(0);
    }
  }

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div>
        <h2 className="text-lg font-bold text-slate-950 dark:text-white">
          {t("사람 작업본과 시스템 정리본 비교", "人の作業版とシステム整理版の比較")} · {monthLabel}
        </h2>
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-stretch">
          <div
            role="button"
            tabIndex={0}
            aria-label={t("사람 작업본 .xlsx 선택 또는 끌어다 놓기", "人の作業版 .xlsx を選択またはドラッグ＆ドロップ")}
            onClick={() => {
              if (!submitting) answerInputRef.current?.click();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                if (!submitting) answerInputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={dropAnswer}
            className={`flex min-h-36 flex-1 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
              dragActive
                ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30"
                : "border-slate-300 bg-slate-50 hover:border-emerald-400 dark:border-slate-700 dark:bg-slate-950"
            }`}
          >
            <UploadCloud className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
            {answerFile ? (
              <>
                <p className="break-all text-sm font-semibold text-slate-900 dark:text-white">{answerFile.name}</p>
                <p className="text-xs text-slate-500 dark:text-slate-400">{formatBytes(answerFile.size)}</p>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    clearAnswer();
                  }}
                  disabled={submitting}
                  className="mt-1 rounded-lg border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
                >
                  {t("선택 해제", "選択解除")}
                </button>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {t("사람 작업본 OUTPUT .xlsx를 여기에 끌어다 놓거나 클릭해 선택하세요.", "人の作業版 OUTPUT .xlsx をここにドラッグ＆ドロップするか、クリックして選択してください。")}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t(".xlsx 1개, 3.5MB 이하 · 현재 정산월의 시스템 정리본 INPUT과 비교합니다.", ".xlsx 1件、3.5MB以下 · 現在の精算月のシステム整理版 INPUT と比較します。")}
                </p>
              </>
            )}
          </div>
          <input ref={answerInputRef} type="file" accept=".xlsx" className="hidden" disabled={submitting} onChange={selectAnswer} />
          <button
            type="button"
            onClick={() => void compareAnswer()}
            disabled={submitting || !answerFile}
            className="inline-flex items-center justify-center rounded-xl bg-emerald-600 px-6 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50 lg:self-stretch"
          >
            {submitting ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <CheckCircle2 className="mr-2 h-5 w-5" />}
            {t("비교하기", "比較実行")}
          </button>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          <AlertCircle className="mr-2 inline h-4 w-4 align-[-3px]" />
          {error}
        </div>
      )}

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-950 dark:text-white">{t("비교 결과", "比較結果")}</h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {run
                ? `${run.answer_filename} · ${displayMonth(run.month.replaceAll("-", "").slice(0, 6))} · ${runStatusLabel(run.status, t)}`
                : t("사람 작업본을 업로드해 비교를 실행하거나, 아래 비교 이력에서 선택해 주세요.", "人の作業版をアップロードして比較を実行するか、下の比較履歴から選択してください。")}
            </p>
          </div>
          {run && (
            <div className="flex flex-wrap gap-2">
              <a
                href={`/api/settlement/comparisons/${run.id}/artifacts/answer`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-800 dark:border-slate-700 dark:text-slate-100"
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {t("사람 작업본 열기", "人の作業版を開く")}
              </a>
              <a
                href={`/api/settlement/comparisons/${run.id}/artifacts/candidate`}
                target="_blank"
                rel="noreferrer"
                className={`inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold dark:border-slate-700 ${run.candidate_filename ? "text-slate-800 dark:text-slate-100" : "pointer-events-none opacity-50"}`}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                {t("시스템 정리본 열기", "システム整理版を開く")}
              </a>
            </div>
          )}
        </div>
        {run?.error && (
          <p className="mt-3 rounded-lg bg-red-50 p-3 text-xs text-red-800 dark:bg-red-950/40 dark:text-red-200">{run.error}</p>
        )}
        {sourceWarnings.length > 0 && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {t("누락 소스 family", "不足ソースfamily")}: {sourceWarnings.join(", ")}
          </div>
        )}
        {summary?.diffs_truncated && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {t(
              `차이가 매우 많아 ${metric(summary.persisted_diff_count)}건까지만 검토 목록에 저장됐습니다.`,
              `差分が非常に多いため、レビュー一覧には${metric(summary.persisted_diff_count)}件まで保存されました。`,
            )}
          </div>
        )}
        {summary?.source_uploads_truncated && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {t(
              `소스 업로드가 많아 처음 500건만 manifest에 저장했습니다. 관측 수는 최소 ${metric(summary.source_uploads_observed_count_at_least)}건입니다.`,
              `ソースアップロードが多いため、manifestには最初の500件のみ保存しました。観測数は少なくとも${metric(summary.source_uploads_observed_count_at_least)}件です。`,
            )}
          </div>
        )}
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [t("시스템 정리본 행", "システム整理版の行"), summary?.candidate_rows],
            [t("사람 작업본 행", "人の作業版の行"), summary?.golden_rows],
            [t("매칭 행", "照合行"), summary?.matched_rows],
            [t("완전 일치", "完全一致"), summary?.exact_rows],
            [t("사람 작업본에만 있음", "人の作業版のみにあり"), summary?.missing_rows],
            [t("시스템에만 있음", "システムのみにあり"), summary?.extra_rows],
            [t("차이 총계", "差分合計"), summary?.diff_total],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400">{label}</p>
              <p className="mt-1 text-2xl font-bold text-slate-950 dark:text-white">{metric(value)}</p>
            </div>
          ))}
        </div>
        {fieldMismatchEntries.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {fieldMismatchEntries.map(([field, count]) => (
              <span
                key={field}
                className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                {fieldLabel(field, t)} {metric(count)}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-bold text-slate-950 dark:text-white">{t("차이 목록", "差分一覧")}</h2>
          <div className="flex flex-wrap gap-2">
            <select
              value={category}
              onChange={(e) => {
                invalidateRunDetails();
                setValueViewMode(false);
                setCategory(e.target.value as DiffCategory | "");
                setOffset(0);
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950"
            >
              <option value="">{t("전체 분류", "全分類")}</option>
              {CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c, t)}</option>)}
            </select>
            <select
              value={reviewStatus}
              onChange={(e) => {
                invalidateRunDetails();
                setReviewStatus(e.target.value as ReviewStatus | "");
                setOffset(0);
              }}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-950"
            >
              <option value="">{t("전체 상태", "全状態")}</option>
              {REVIEW_STATUSES.map((s) => <option key={s} value={s}>{reviewStatusLabel(s, t)}</option>)}
            </select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(
            [
              { mode: "all", label: t("전체", "全体") },
              { mode: "missing", label: t("시스템 누락", "システム欠落") },
              { mode: "extra", label: t("시스템 추가", "システム追加") },
              { mode: "value", label: t("값 차이", "値の差") },
            ] as Array<{ mode: QuickFilter; label: string }>
          ).map(({ mode, label }) => {
            const disabled = mode === "value" && !valueFilterAvailable;
            const active = activeQuickFilter === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => applyQuickFilter(mode)}
                disabled={disabled}
                title={
                  disabled
                    ? t(
                        "차이가 한 페이지를 넘어 값 차이 필터를 정확히 적용할 수 없습니다. 분류 선택을 이용해 주세요.",
                        "差分が1ページを超えるため、値の差フィルタを正確に適用できません。分類の選択をご利用ください。",
                      )
                    : undefined
                }
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  active
                    ? "border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
                    : "border-slate-300 bg-white text-slate-700 hover:border-emerald-300 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
                }`}
              >
                {label}
              </button>
            );
          })}
          {valueViewActive && (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {t(`값 차이 ${visibleDiffs.length}건 표시 중`, `値の差${visibleDiffs.length}件表示中`)}
            </span>
          )}
        </div>
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
          <p className="font-semibold text-slate-900 dark:text-white">
            {t(
              `차이 총계는 사람 작업본에만 있는 행 ${metric(summary?.missing_rows)}건, 시스템에만 있는 행 ${metric(summary?.extra_rows)}건, 값이 다른 셀 ${metric(fieldMismatchTotal)}건을 합산한 것입니다.`,
              `差分合計は、人の作業版のみにある行 ${metric(summary?.missing_rows)}件、システムのみにある行 ${metric(summary?.extra_rows)}件、値が異なるセル ${metric(fieldMismatchTotal)}件の合計です。`,
            )}
          </p>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t(
              "차이는 오류의 증거가 아닙니다. 원본 자료를 확인한 뒤 어떤 쪽을 채택할지 판정해 주세요.",
              "差分は誤りの証拠ではありません。元資料を確認してから、どちらを採用するか判定してください。",
            )}
          </p>
        </div>

        {loadingDiffs && (
          <div className="mt-4 rounded-xl bg-slate-50 py-10 text-center text-sm text-slate-500 dark:bg-slate-950 dark:text-slate-400">
            <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
            {t("불러오는 중", "読み込み中")}
          </div>
        )}
        {!loadingDiffs && visibleDiffs.length === 0 && (
          <div className="mt-4 rounded-xl bg-slate-50 py-10 text-center text-sm text-slate-500 dark:bg-slate-950 dark:text-slate-400">
            {t("표시할 차이가 없습니다.", "表示する差分はありません。")}
          </div>
        )}
        {!loadingDiffs && visibleDiffs.length > 0 && (
          <ul className="mt-4 space-y-2">
            {diffGroups.map((group) => {
              const counts = groupCounts(group.diffs);
              const expanded = expandedGroups.has(group.key);
              const pendingCount = group.diffs.filter((d) => d.review_status === "pending").length;
              return (
                <li key={group.key} className="rounded-xl border border-slate-200 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={expanded}
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl px-3 py-2.5 text-left transition hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:hover:bg-slate-950/60"
                  >
                    <ChevronDown className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${expanded ? "" : "-rotate-90"}`} />
                    <span className="flex shrink-0 items-center gap-1" aria-hidden>
                      {groupCategories(group.diffs).map((c) => (
                        <span key={c} className={`h-2 w-2 rounded-full ${CATEGORY_DOT[c]}`} />
                      ))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {group.title || t("(작품명 없음)", "(タイトルなし)")}
                      </span>
                      <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                        {group.channel || "-"} · {group.type || "-"}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                        {groupCountsLabel(counts, t)}
                      </span>
                      {pendingCount > 0 ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
                          {t(`대기 ${pendingCount}`, `未確認 ${pendingCount}`)}
                        </span>
                      ) : (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
                          {t("검토 완료", "レビュー済み")}
                        </span>
                      )}
                    </span>
                  </button>
                  {expanded && (
                    <div className="border-t border-slate-200 px-3 pb-3 dark:border-slate-800">
                      <div className="overflow-x-auto">
                        <table className="mt-2 w-full min-w-[560px] border-collapse text-xs">
                          <thead>
                            <tr className="text-left text-slate-500 dark:text-slate-400">
                              <th className="w-[26%] py-1.5 pr-3 font-semibold">{t("항목", "項目")}</th>
                              <th className="w-[28%] py-1.5 pr-3 font-semibold text-emerald-700 dark:text-emerald-300">{t("사람 작업본", "人の作業版")}</th>
                              <th className="w-[28%] py-1.5 pr-3 font-semibold">{t("시스템 작업본", "システム作業版")}</th>
                              <th className="py-1.5 font-semibold">{t("차이", "差異")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.diffs.map((diff) => {
                              const humanValue = sideValue(diff, "human", t);
                              const systemValue = sideValue(diff, "system", t);
                              const isValueDiff = isValueDiffCategory(diff.category);
                              const aligned = isValueDiff ? null : alignedRowTable(humanValue, systemValue);
                              return (
                                <Fragment key={diff.id}>
                                  {isValueDiff ? (
                                    <tr className="border-t border-slate-100 dark:border-slate-800/60">
                                      <td className="py-2 pr-3 align-top font-medium text-slate-900 dark:text-slate-100">
                                        {fieldLabel(diff.field, t)}
                                        {diff.category === "formula" && (
                                          <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${CATEGORY_BADGE.formula}`}>
                                            {t("수식", "数式")}
                                          </span>
                                        )}
                                      </td>
                                      <td className="break-words py-2 pr-3 align-top text-slate-900 dark:text-slate-100">
                                        {humanValue.text}
                                        {humanValue.formula && <FormulaChip formula={humanValue.formula} t={t} />}
                                      </td>
                                      <td className="break-words py-2 pr-3 align-top text-slate-900 dark:text-slate-100">
                                        {systemValue.text}
                                        {systemValue.formula && <FormulaChip formula={systemValue.formula} t={t} />}
                                      </td>
                                      <td className={`py-2 align-top font-semibold ${CATEGORY_DIFF_TEXT[diff.category]}`}>
                                        {differenceText(diff, t)}
                                      </td>
                                    </tr>
                                  ) : (
                                    <>
                                      <tr className="border-t border-slate-100 dark:border-slate-800/60">
                                        <td className="py-2 pr-3 align-top">
                                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${CATEGORY_BADGE[diff.category]}`}>
                                            {categoryLabel(diff.category, t)}
                                          </span>
                                        </td>
                                        <td className={`py-2 pr-3 align-top ${humanValue.absent ? "font-semibold text-red-700 dark:text-red-300" : "text-slate-600 dark:text-slate-300"}`}>
                                          {humanValue.absent ? t("이 행이 없습니다", "この行はありません") : t("행 있음", "行あり")}
                                        </td>
                                        <td className={`py-2 pr-3 align-top ${systemValue.absent ? "font-semibold text-red-700 dark:text-red-300" : "text-slate-600 dark:text-slate-300"}`}>
                                          {systemValue.absent ? t("이 행이 없습니다", "この行はありません") : t("행 있음", "行あり")}
                                        </td>
                                        <td className={`py-2 align-top font-semibold ${CATEGORY_DIFF_TEXT[diff.category]}`}>
                                          {differenceText(diff, t)}
                                        </td>
                                      </tr>
                                      {aligned?.rows.map((row) => (
                                        <tr key={`${diff.id}:${row.field}`} className="border-t border-slate-100 dark:border-slate-800/60">
                                          <td className="py-1.5 pr-3 align-top text-slate-500 dark:text-slate-400">{row.label}</td>
                                          <td className="break-words py-1.5 pr-3 align-top text-slate-900 dark:text-slate-100">
                                            {row.human ? (
                                              <>
                                                {row.human.text}
                                                {row.human.formula && <FormulaChip formula={row.human.formula} t={t} />}
                                              </>
                                            ) : (
                                              <span className="text-red-400 dark:text-red-500">—</span>
                                            )}
                                          </td>
                                          <td className="break-words py-1.5 pr-3 align-top text-slate-900 dark:text-slate-100">
                                            {row.system ? (
                                              <>
                                                {row.system.text}
                                                {row.system.formula && <FormulaChip formula={row.system.formula} t={t} />}
                                              </>
                                            ) : (
                                              <span className="text-red-400 dark:text-red-500">—</span>
                                            )}
                                          </td>
                                          <td className="py-1.5 align-top text-slate-400">-</td>
                                        </tr>
                                      ))}
                                      {aligned && aligned.hiddenCount > 0 && (
                                        <tr className="border-t border-slate-100 dark:border-slate-800/60">
                                          <td colSpan={4} className="py-1.5 text-slate-500 dark:text-slate-400">
                                            {t(`외 ${aligned.hiddenCount}개 셀`, `ほか${aligned.hiddenCount}セル`)}
                                          </td>
                                        </tr>
                                      )}
                                    </>
                                  )}
                                  <tr>
                                    <td colSpan={4} className="pb-3 pt-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <select
                                          value={diff.review_status}
                                          onChange={(e) => void patchDiff(diff, e.target.value as ReviewStatus)}
                                          disabled={patchingId === diff.id}
                                          className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950"
                                        >
                                          {REVIEW_STATUSES.map((s) => <option key={s} value={s}>{reviewStatusLabel(s, t)}</option>)}
                                        </select>
                                        <input
                                          value={notes[diff.id] ?? ""}
                                          onChange={(e) => setNotes((prev) => ({ ...prev, [diff.id]: e.target.value.slice(0, 2000) }))}
                                          placeholder={t("메모", "メモ")}
                                          className="min-w-48 flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs dark:border-slate-700 dark:bg-slate-950"
                                        />
                                        <button
                                          type="button"
                                          onClick={() => void patchDiff(diff, diff.review_status)}
                                          disabled={patchingId === diff.id}
                                          className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold dark:border-slate-700"
                                        >
                                          {patchingId === diff.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}
                                          {t("저장", "保存")}
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>{pageStart}-{pageEnd} / {totalDiffs}</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                invalidateRunDetails();
                setOffset(Math.max(0, offset - PAGE_SIZE));
              }}
              disabled={offset === 0 || loadingDiffs}
              className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold disabled:opacity-40 dark:border-slate-700"
            >
              {t("이전", "前へ")}
            </button>
            <button
              type="button"
              onClick={() => {
                invalidateRunDetails();
                setOffset(offset + PAGE_SIZE);
              }}
              disabled={offset + PAGE_SIZE >= totalDiffs || loadingDiffs}
              className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold disabled:opacity-40 dark:border-slate-700"
            >
              {t("다음", "次へ")}
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-slate-950 dark:text-white">{t("비교 이력", "比較履歴")}</h2>
          <button
            type="button"
            onClick={() => void loadRuns("none")}
            className="rounded-lg border border-slate-300 p-2 text-slate-700 transition hover:border-emerald-500 dark:border-slate-700 dark:text-slate-200"
            aria-label={t("새로고침", "更新")}
          >
            {loadingRuns ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
          </button>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {runs.length === 0 && (
            <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500 dark:bg-slate-950 dark:text-slate-400 sm:col-span-2 lg:col-span-3">
              {t("아직 비교 실행이 없습니다.", "まだ比較実行がありません。")}
            </p>
          )}
          {runs.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                invalidateRunDetails();
                setSelectedRunId(item.id);
                setOffset(0);
              }}
              className={`w-full rounded-lg border p-3 text-left text-xs transition ${
                item.id === selectedRunId
                  ? "border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
                  : "border-slate-200 bg-white text-slate-700 hover:border-emerald-300 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-semibold">{item.answer_filename}</span>
                <span>{runStatusLabel(item.status, t)}</span>
              </div>
              <div className="mt-1 text-slate-500 dark:text-slate-400">{new Date(item.created_at).toLocaleString()}</div>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
