"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, RefreshCcw } from "lucide-react";

import { useApp } from "@/context/AppContext";
import InvestigationThread from "@/features/settlement/components/InvestigationThread";
import {
  displayValue,
  fieldLabel,
  scalarText,
  type Translate,
} from "@/features/settlement/lib/comparison/display";
import {
  investigationStatusLabel,
  rootCauseStageLabel,
} from "@/features/settlement/lib/comparison/investigation-ui";
import type {
  WorkbookReview,
  WorkbookReviewOverlay,
  WorkbookReviewRow,
} from "@/features/settlement/lib/comparison/workbook-review";

export interface WorkbookOverlayTarget {
  overlay: WorkbookReviewOverlay;
  rowIndex: number;
  cellIndex: number | null;
}

export function workbookRowHasDifference(row: WorkbookReviewRow): boolean {
  return row.row_overlays.length > 0 || row.cells.some((cell) => cell.overlays.length > 0);
}

export function visibleWorkbookRows(
  review: WorkbookReview,
  includeContext: boolean,
): WorkbookReviewRow[] {
  return includeContext ? review.rows : review.rows.filter(workbookRowHasDifference);
}

/** Difference order follows the visible table: row marker, then cells left-to-right. */
export function flattenWorkbookOverlays(
  review: WorkbookReview,
  includeContext: boolean,
): WorkbookOverlayTarget[] {
  const seen = new Set<string>();
  const targets: WorkbookOverlayTarget[] = [];

  review.rows.forEach((row, rowIndex) => {
    if (!includeContext && !workbookRowHasDifference(row)) return;
    const append = (overlay: WorkbookReviewOverlay, cellIndex: number | null) => {
      if (seen.has(overlay.diff_id)) return;
      seen.add(overlay.diff_id);
      targets.push({ overlay, rowIndex, cellIndex });
    };
    row.row_overlays.forEach((overlay) => append(overlay, null));
    row.cells.forEach((cell, cellIndex) => {
      cell.overlays.forEach((overlay) => append(overlay, cellIndex));
    });
  });

  return targets;
}

function targetElementId(runId: string, target: Pick<WorkbookOverlayTarget, "rowIndex" | "cellIndex">) {
  return `workbook-review-${runId}-${target.rowIndex}-${target.cellIndex ?? "row"}`;
}

function reviewStatusLabel(status: WorkbookReviewOverlay["review_status"], t: Translate) {
  const labels = {
    pending: t("대기", "未確認"),
    candidate_correct: t("시스템 정리본이 맞음", "システム整理版が正しい"),
    golden_correct: t("사람 작업본이 맞음", "人の作業版が正しい"),
    needs_review: t("검토 필요", "要レビュー"),
    resolved: t("해결됨", "解決済み"),
  };
  return labels[status];
}

function differenceExplanation(overlay: WorkbookReviewOverlay, t: Translate) {
  if (overlay.category === "missing") {
    return t(
      "이 행은 사람 정답지에는 있지만 시스템 정리본에는 없습니다.",
      "この行は人の正解ファイルにはありますが、システム整理版にはありません。",
    );
  }
  if (overlay.category === "extra") {
    return t(
      "이 행은 시스템 정리본에만 있고 사람 정답지에는 없습니다.",
      "この行はシステム整理版のみにあり、人の正解ファイルにはありません。",
    );
  }
  const label = fieldLabel(overlay.field, t);
  return overlay.category === "formula"
    ? t(
        `${label} 셀의 수식 또는 계산 결과가 서로 다릅니다.`,
        `${label}セルの数式または計算結果が異なります。`,
      )
    : t(`${label} 셀의 값이 서로 다릅니다.`, `${label}セルの値が異なります。`);
}

function locationText(location: WorkbookReviewOverlay["golden_location"], t: Translate) {
  return location ? `${location.sheet}!${location.address}` : t("해당 위치 없음", "該当位置なし");
}

function BoundedValue({
  value,
  absent,
  t,
}: {
  value: WorkbookReviewOverlay["answer_value"];
  absent: boolean;
  t: Translate;
}) {
  const shown = displayValue(value, t, absent);
  return (
    <div className="min-w-0 text-sm text-slate-900 dark:text-slate-100">
      <p className="break-words font-medium">{shown.text}</p>
      {shown.formula ? (
        <p className="mt-1 break-all font-mono text-xs text-violet-700 dark:text-violet-300">
          = {shown.formula}
        </p>
      ) : null}
      {shown.cells.length > 0 ? (
        <dl className="mt-2 grid gap-1 text-xs">
          {shown.cells.map((cell) => (
            <div key={cell.field} className="grid grid-cols-[minmax(7rem,0.4fr)_1fr] gap-2">
              <dt className="text-slate-500 dark:text-slate-400">{cell.label}</dt>
              <dd className="break-words text-slate-800 dark:text-slate-200">
                {cell.text}
                {cell.formula ? ` · =${cell.formula}` : ""}
              </dd>
            </div>
          ))}
          {shown.hiddenCellCount > 0 ? (
            <div className="text-slate-500 dark:text-slate-400">
              {t(`외 ${shown.hiddenCellCount}개 셀`, `ほか${shown.hiddenCellCount}セル`)}
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

function withQuestionPending(review: WorkbookReview, diffId: string): WorkbookReview {
  const update = (overlay: WorkbookReviewOverlay) =>
    overlay.diff_id === diffId
      ? { ...overlay, investigation_status: "question_pending" as const }
      : overlay;
  return {
    ...review,
    rows: review.rows.map((row) => ({
      ...row,
      row_overlays: row.row_overlays.map(update),
      cells: row.cells.map((cell) => ({ ...cell, overlays: cell.overlays.map(update) })),
    })),
  };
}

export default function AnswerWorkbookReview({ runId }: { runId: string }) {
  const { t } = useApp();
  const requestSeqRef = useRef(0);
  const [review, setReview] = useState<WorkbookReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [includeContext, setIncludeContext] = useState(true);
  const [selectedDiffId, setSelectedDiffId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    setReview(null);
    setSelectedDiffId(null);

    void (async () => {
      try {
        const response = await fetch(
          `/api/settlement/comparisons/${encodeURIComponent(runId)}/workbook-review`,
          { signal: controller.signal },
        );
        const json = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
          throw new Error(message);
        }
        if (controller.signal.aborted || requestSeq !== requestSeqRef.current) return;
        setReview(json.review as WorkbookReview);
      } catch (cause) {
        if (!controller.signal.aborted && requestSeq === requestSeqRef.current) {
          setError((cause as Error).message);
        }
      } finally {
        if (!controller.signal.aborted && requestSeq === requestSeqRef.current) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [retryKey, runId]);

  const visibleRows = useMemo(
    () => (review ? visibleWorkbookRows(review, includeContext) : []),
    [includeContext, review],
  );
  const targets = useMemo(
    () => (review ? flattenWorkbookOverlays(review, includeContext) : []),
    [includeContext, review],
  );
  const selectedTarget = targets.find((target) => target.overlay.diff_id === selectedDiffId) ?? null;
  const selectedIndex = selectedTarget
    ? targets.findIndex((target) => target.overlay.diff_id === selectedTarget.overlay.diff_id)
    : -1;

  function selectTarget(target: WorkbookOverlayTarget) {
    setSelectedDiffId(target.overlay.diff_id);
    window.requestAnimationFrame(() => {
      document.getElementById(targetElementId(runId, target))?.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "center",
      });
    });
  }

  function selectAdjacent(direction: -1 | 1) {
    if (targets.length === 0) return;
    const nextIndex = selectedIndex === -1
      ? direction === 1 ? 0 : targets.length - 1
      : Math.min(targets.length - 1, Math.max(0, selectedIndex + direction));
    selectTarget(targets[nextIndex]);
  }

  function markQuestionPending(diffId: string) {
    setReview((current) => current ? withQuestionPending(current, diffId) : current);
  }

  if (loading) {
    return (
      <section className="rounded-2xl border border-emerald-200 bg-white p-5 shadow-sm dark:border-emerald-900 dark:bg-slate-900">
        <p className="text-sm text-slate-600 dark:text-slate-300" role="status">
          <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
          {t("정답지 표를 불러오는 중입니다.", "正解ファイルの表を読み込んでいます。")}
        </p>
      </section>
    );
  }

  if (error || !review) {
    return (
      <section className="rounded-2xl border border-red-200 bg-red-50 p-5 dark:border-red-900 dark:bg-red-950/30">
        <p className="text-sm text-red-800 dark:text-red-200" role="alert">
          <AlertCircle className="mr-2 inline h-4 w-4 align-[-3px]" />
          {error ?? t("정답지 표를 표시할 수 없습니다.", "正解ファイルの表を表示できません。")}
        </p>
        <button
          type="button"
          onClick={() => setRetryKey((value) => value + 1)}
          className="mt-3 inline-flex items-center rounded-lg border border-red-300 bg-white px-3 py-2 text-xs font-semibold text-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
        >
          <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
          {t("다시 시도", "再試行")}
        </button>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-sm dark:border-emerald-900 dark:bg-slate-900">
      <div className="border-b border-emerald-100 p-5 dark:border-emerald-950">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold text-slate-950 dark:text-white">
                {t("사람 정답지에서 차이 확인", "人の正解ファイルで差分を確認")}
              </h2>
              <span className="max-w-full truncate rounded-md bg-emerald-700 px-2 py-1 font-mono text-[11px] font-semibold text-white">
                {review.sheet_name}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {t(
                "색이 있는 셀이나 행을 누르면 정답지와 시스템 값을 같은 위치에서 확인할 수 있습니다.",
                "色付きのセルまたは行を押すと、正解ファイルとシステムの値を同じ位置で確認できます。",
              )}
            </p>
          </div>
          <button
            type="button"
            aria-pressed={includeContext}
            onClick={() => setIncludeContext((value) => !value)}
            className={`rounded-lg border px-3 py-2 text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
              includeContext
                ? "border-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100"
                : "border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-200"
            }`}
          >
            {t("앞뒤 문맥 행 포함", "前後の文脈行を含める")}
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-700 dark:text-slate-200" aria-label={t("차이 색상 범례", "差分色の凡例")}>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-amber-300 bg-amber-100" />{t("값·수식 차이", "値・数式の差")}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-red-300 bg-red-100" />{t("시스템에 없는 정답 행", "システムにない正解行")}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm border border-sky-300 bg-sky-100" />{t("시스템에만 있는 행", "システムのみにある行")}</span>
          <span className="text-slate-500 dark:text-slate-400">
            {t(`차이 ${review.shown_diff_count}건 · 표시 행 ${visibleRows.length}개`, `差分${review.shown_diff_count}件 · 表示行${visibleRows.length}件`)}
          </span>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => selectAdjacent(-1)}
              disabled={targets.length === 0 || selectedIndex === 0}
              aria-label={t("이전 차이로 이동", "前の差分へ移動")}
              className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200"
            >
              <ChevronLeft className="mr-1 h-3.5 w-3.5" />
              {t("이전 차이", "前の差分")}
            </button>
            <button
              type="button"
              onClick={() => selectAdjacent(1)}
              disabled={targets.length === 0 || selectedIndex === targets.length - 1}
              aria-label={t("다음 차이로 이동", "次の差分へ移動")}
              className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-40 dark:border-slate-700 dark:text-slate-200"
            >
              {t("다음 차이", "次の差分")}
              <ChevronRight className="ml-1 h-3.5 w-3.5" />
            </button>
          </div>
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400" aria-live="polite">
            {selectedIndex >= 0 ? `${selectedIndex + 1} / ${targets.length}` : t("차이를 선택해 주세요", "差分を選択してください")}
          </span>
        </div>
      </div>

      <div className="max-h-[36rem] overflow-auto" tabIndex={0} aria-label={t("사람 정답지 차이 표", "人の正解ファイル差分表")}>
        <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr className="h-8">
              <th className="sticky left-0 top-0 z-40 min-w-16 border-b border-r border-slate-300 bg-slate-200 px-2 text-center font-mono text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300" rowSpan={2}>
                {t("행", "行")}
              </th>
              {review.columns.map((column) => (
                <th key={column.field} className="sticky top-0 z-30 min-w-36 border-b border-r border-slate-300 bg-slate-200 px-3 py-1 text-center font-mono text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {column.letter}
                </th>
              ))}
            </tr>
            <tr className="h-11">
              {review.columns.map((column) => (
                <th key={column.field} className="sticky top-8 z-30 min-w-36 border-b border-r border-slate-300 bg-slate-100 px-3 py-2 text-left font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
                  {fieldLabel(column.field, t)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {review.rows.map((row, rowIndex) => {
              if (!includeContext && !workbookRowHasDifference(row)) return null;
              const rowOverlay = row.row_overlays[0] ?? null;
              const rowSelected = row.row_overlays.some((overlay) => overlay.diff_id === selectedDiffId);
              const rowTone = row.kind === "system-only"
                ? "bg-sky-50 dark:bg-sky-950/40"
                : rowOverlay
                  ? "bg-red-50 dark:bg-red-950/35"
                  : "bg-white dark:bg-slate-900";
              return (
                <tr key={`${row.kind}:${row.sheet}:${row.row}`} className={rowTone}>
                  <th className={`sticky left-0 z-20 border-b border-r border-slate-200 p-0 text-center font-mono dark:border-slate-800 ${rowTone} ${rowSelected ? "ring-2 ring-inset ring-emerald-500" : ""}`}>
                    {rowOverlay ? (
                      <button
                        id={targetElementId(runId, { rowIndex, cellIndex: null })}
                        type="button"
                        onClick={() => selectTarget({ overlay: rowOverlay, rowIndex, cellIndex: null })}
                        aria-label={t(`${row.row}행 차이 선택`, `${row.row}行の差分を選択`)}
                        className="h-full min-h-10 w-full px-2 py-2 font-mono font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
                      >
                        {row.kind === "system-only" ? "+" : ""}{row.row}
                      </button>
                    ) : (
                      <span className="block min-h-10 px-2 py-2 font-medium text-slate-500 dark:text-slate-400">{row.row}</span>
                    )}
                  </th>
                  {row.cells.map((cell, cellIndex) => {
                    const cellOverlay = cell.overlays[0] ?? null;
                    const selectableOverlay = cellOverlay ?? rowOverlay;
                    const cellSelected = cell.overlays.some((overlay) => overlay.diff_id === selectedDiffId) || rowSelected;
                    const cellTone = cellOverlay
                      ? "bg-amber-100 dark:bg-amber-950/50"
                      : rowTone;
                    return (
                      <td
                        key={cell.field}
                        id={cellOverlay ? targetElementId(runId, { rowIndex, cellIndex }) : undefined}
                        className={`max-w-64 border-b border-r border-slate-200 p-0 align-top dark:border-slate-800 ${cellTone} ${cellSelected ? "ring-2 ring-inset ring-emerald-500" : ""}`}
                      >
                        {selectableOverlay ? (
                          <button
                            type="button"
                            onClick={() => selectTarget({
                              overlay: selectableOverlay,
                              rowIndex,
                              cellIndex: cellOverlay ? cellIndex : null,
                            })}
                            aria-label={t(`${cell.address ?? `${row.row}행`} 차이 선택`, `${cell.address ?? `${row.row}行`}の差分を選択`)}
                            className="min-h-10 w-full px-3 py-2 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500"
                          >
                            <span className="block break-words text-slate-900 dark:text-slate-100">{scalarText(cell.value)}</span>
                            {cell.formula ? <span className="mt-0.5 block break-all font-mono text-[10px] text-violet-700 dark:text-violet-300">={cell.formula}</span> : null}
                            {(cellOverlay ? cell.overlays.length : row.row_overlays.length) > 1 ? (
                              <span className="mt-1 inline-flex rounded bg-slate-900/10 px-1 text-[10px] font-semibold dark:bg-white/10">
                                +{(cellOverlay ? cell.overlays.length : row.row_overlays.length) - 1}
                              </span>
                            ) : null}
                          </button>
                        ) : (
                          <div className="min-h-10 px-3 py-2">
                            <span className="block break-words text-slate-800 dark:text-slate-200">{scalarText(cell.value)}</span>
                            {cell.formula ? <span className="mt-0.5 block break-all font-mono text-[10px] text-violet-700 dark:text-violet-300">={cell.formula}</span> : null}
                          </div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {review.rows_truncated ? (
        <p className="border-t border-amber-200 bg-amber-50 px-5 py-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {t(
            `표시 한도 때문에 관련 행 ${review.total_relevant_rows}개 중 ${review.rows.length}개를 표시하고 ${review.total_relevant_rows - review.rows.length}개를 생략했습니다.`,
            `表示上限により、関連行${review.total_relevant_rows}件のうち${review.rows.length}件を表示し、${review.total_relevant_rows - review.rows.length}件を省略しました。`,
          )}
        </p>
      ) : null}

      {selectedTarget ? (
        <div className="border-t border-emerald-200 bg-slate-50 p-5 dark:border-emerald-900 dark:bg-slate-950/60">
          <h3 className="text-sm font-bold text-slate-950 dark:text-white">
            {t("선택한 차이", "選択した差分")}
          </h3>
          <p className="mt-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
            {differenceExplanation(selectedTarget.overlay, t)}
          </p>
          <dl className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
            <div className="rounded-lg border border-emerald-200 bg-white p-3 dark:border-emerald-900 dark:bg-slate-900">
              <dt className="font-semibold text-emerald-800 dark:text-emerald-300">{t("사람 정답지 위치", "人の正解ファイル位置")}</dt>
              <dd className="mt-1 break-all font-mono text-slate-700 dark:text-slate-200">{locationText(selectedTarget.overlay.golden_location, t)}</dd>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
              <dt className="font-semibold text-slate-700 dark:text-slate-300">{t("시스템 위치", "システム位置")}</dt>
              <dd className="mt-1 break-all font-mono text-slate-700 dark:text-slate-200">{locationText(selectedTarget.overlay.candidate_location, t)}</dd>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-white p-3 dark:border-emerald-900 dark:bg-slate-900">
              <dt className="mb-2 font-semibold text-emerald-800 dark:text-emerald-300">{t("사람 값", "人の値")}</dt>
              <dd><BoundedValue value={selectedTarget.overlay.answer_value} absent={selectedTarget.overlay.category === "extra"} t={t} /></dd>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
              <dt className="mb-2 font-semibold text-slate-700 dark:text-slate-300">{t("시스템 값", "システム値")}</dt>
              <dd><BoundedValue value={selectedTarget.overlay.system_value} absent={selectedTarget.overlay.category === "missing"} t={t} /></dd>
            </div>
          </dl>
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-xs dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-700 dark:text-slate-200">
              <span><strong>{t("검토 상태", "レビュー状態")}:</strong> {reviewStatusLabel(selectedTarget.overlay.review_status, t)}</span>
              <span><strong>{t("조사 상태", "調査状態")}:</strong> {investigationStatusLabel(selectedTarget.overlay.investigation_status, t)}</span>
              {selectedTarget.overlay.root_cause_stage ? (
                <span><strong>{t("원인 단계", "原因段階")}:</strong> {rootCauseStageLabel(selectedTarget.overlay.root_cause_stage, t)}</span>
              ) : null}
            </div>
            {selectedTarget.overlay.review_note ? <p className="mt-2 whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300"><strong>{t("검토 메모", "レビューメモ")}:</strong> {selectedTarget.overlay.review_note}</p> : null}
            {selectedTarget.overlay.root_cause_summary ? <p className="mt-2 whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300"><strong>{t("원인 요약", "原因要約")}:</strong> {selectedTarget.overlay.root_cause_summary}</p> : null}
          </div>
          <InvestigationThread
            key={selectedTarget.overlay.diff_id}
            diffId={selectedTarget.overlay.diff_id}
            category={selectedTarget.overlay.category}
            field={selectedTarget.overlay.field}
            investigationStatus={selectedTarget.overlay.investigation_status}
            rootCauseStage={selectedTarget.overlay.root_cause_stage}
            rootCauseSummary={selectedTarget.overlay.root_cause_summary}
            onQuestionPosted={markQuestionPending}
          />
        </div>
      ) : null}
    </section>
  );
}
