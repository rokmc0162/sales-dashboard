"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Loader2,
  PanelRightClose,
  RefreshCcw,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";

import { useApp } from "@/context/AppContext";
import {
  BoundedValue,
  differenceExplanation,
  flattenWorkbookOverlays,
  locationText,
  reviewStatusLabel,
  visibleWorkbookRows,
  withQuestionPending,
  workbookRowHasDifference,
  type WorkbookOverlayTarget,
} from "@/features/settlement/components/AnswerWorkbookReview";
import InvestigationThread from "@/features/settlement/components/InvestigationThread";
import { fieldLabel, scalarText } from "@/features/settlement/lib/comparison/display";
import {
  investigationStatusLabel,
  rootCauseStageLabel,
} from "@/features/settlement/lib/comparison/investigation-ui";
import type {
  WorkbookReview,
  WorkbookReviewOverlay,
} from "@/features/settlement/lib/comparison/workbook-review";

type GridPosition = {
  rowIndex: number;
  cellIndex: number | null;
};

function gridElementId(runId: string, position: GridPosition) {
  return `settlement-sheet-${runId}-${position.rowIndex}-${position.cellIndex ?? "row"}`;
}

function categoryCounts(targets: WorkbookOverlayTarget[]) {
  return targets.reduce(
    (counts, { overlay }) => {
      if (overlay.category === "missing") counts.missing += 1;
      else if (overlay.category === "extra") counts.extra += 1;
      else counts.mismatch += 1;
      return counts;
    },
    { mismatch: 0, missing: 0, extra: 0 },
  );
}

function selectedCellText(
  review: WorkbookReview,
  position: GridPosition | null,
  overlay: WorkbookReviewOverlay | null,
) {
  if (!position) return { address: "—", value: "" };
  const row = review.rows[position.rowIndex];
  const cell = position.cellIndex === null ? null : row?.cells[position.cellIndex];
  const location = row?.kind === "answer" ? overlay?.golden_location : overlay?.candidate_location;
  return {
    address: cell?.address ?? location?.address ?? row?.address ?? "—",
    value: cell
      ? cell.formula
        ? `=${cell.formula}`
        : scalarText(cell.value)
      : scalarText(row?.row ?? ""),
  };
}

export default function SettlementSpreadsheetReview({ runId }: { runId: string }) {
  const { t } = useApp();
  const router = useRouter();
  const requestSeqRef = useRef(0);
  const [review, setReview] = useState<WorkbookReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [includeContext, setIncludeContext] = useState(true);
  const [selectedDiffId, setSelectedDiffId] = useState<string | null>(null);
  const [selectedPosition, setSelectedPosition] = useState<GridPosition | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    setReview(null);
    setSelectedDiffId(null);
    setSelectedPosition(null);

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
        const nextReview = json.review as WorkbookReview;
        const firstTarget = flattenWorkbookOverlays(nextReview, true)[0] ?? null;
        setReview(nextReview);
        setSelectedDiffId(firstTarget?.overlay.diff_id ?? null);
        setSelectedPosition(firstTarget
          ? { rowIndex: firstTarget.rowIndex, cellIndex: firstTarget.cellIndex }
          : null);
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
  const allTargets = useMemo(
    () => (review ? flattenWorkbookOverlays(review, true) : []),
    [review],
  );
  const counts = useMemo(() => categoryCounts(allTargets), [allTargets]);
  const selectedTarget = targets.find(({ overlay }) => overlay.diff_id === selectedDiffId) ?? null;
  const selectedIndex = selectedTarget
    ? targets.findIndex(({ overlay }) => overlay.diff_id === selectedTarget.overlay.diff_id)
    : -1;
  const formulaSelection = review
    ? selectedCellText(review, selectedPosition, selectedTarget?.overlay ?? null)
    : { address: "—", value: "" };

  function selectTarget(target: WorkbookOverlayTarget, cellIndex = target.cellIndex) {
    const position = { rowIndex: target.rowIndex, cellIndex };
    setSelectedDiffId(target.overlay.diff_id);
    setSelectedPosition(position);
    window.requestAnimationFrame(() => {
      document.getElementById(gridElementId(runId, position))?.scrollIntoView({
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

  function closeWorkspace() {
    window.close();
    window.setTimeout(() => {
      if (window.closed) return;
      if (window.history.length > 1) router.back();
      else router.push("/settlement");
    }, 100);
  }

  function markQuestionPending(diffId: string) {
    setReview((current) => current ? withQuestionPending(current, diffId) : current);
  }

  if (loading) {
    return (
      <main className="fixed inset-0 flex h-dvh w-screen items-center justify-center bg-slate-50 text-slate-700">
        <p className="flex items-center text-sm font-medium" role="status">
          <Loader2 className="mr-2 h-4 w-4 animate-spin text-emerald-700" />
          {t("정답지 스프레드시트를 불러오는 중입니다.", "正解ファイルのスプレッドシートを読み込んでいます。")}
        </p>
      </main>
    );
  }

  if (error || !review) {
    return (
      <main className="fixed inset-0 flex h-dvh w-screen items-center justify-center bg-slate-50 p-6 text-slate-900">
        <section className="w-full max-w-md border border-red-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold text-red-800" role="alert">
            <AlertCircle className="mr-2 inline h-4 w-4 align-[-3px]" />
            {error ?? t("정답지 스프레드시트를 표시할 수 없습니다.", "正解ファイルのスプレッドシートを表示できません。")}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setRetryKey((value) => value + 1)}
              className="inline-flex items-center border border-red-300 bg-white px-3 py-2 text-xs font-bold text-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
            >
              <RefreshCcw className="mr-1.5 h-3.5 w-3.5" />
              {t("다시 시도", "再試行")}
            </button>
            <button
              type="button"
              onClick={closeWorkspace}
              className="border border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
            >
              {t("닫기", "閉じる")}
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="fixed inset-0 z-50 flex h-dvh w-screen flex-col overflow-hidden bg-[#f8f9fa] text-slate-900">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-slate-300 bg-white px-3">
        <button
          type="button"
          onClick={closeWorkspace}
          aria-label={t("스프레드시트 검수 닫기 또는 뒤로 가기", "スプレッドシートレビューを閉じる、または戻る")}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-slate-900">
            {t("정산 정답지 검수", "精算正解ファイルレビュー")}
          </h1>
          <p className="truncate text-[10px] text-slate-500">{review.sheet_name}</p>
        </div>
        <span className="ml-auto hidden font-mono text-[10px] text-slate-400 sm:inline">
          {runId}
        </span>
      </header>

      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-300 bg-white px-3 py-1.5 text-xs">
        <div className="flex items-center" role="group" aria-label={t("차이 이동", "差分移動") }>
          <button
            type="button"
            onClick={() => selectAdjacent(-1)}
            disabled={targets.length === 0 || selectedIndex === 0}
            aria-label={t("이전 차이로 이동", "前の差分へ移動")}
            className="inline-flex h-7 items-center border border-slate-300 bg-white px-2 font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-35"
          >
            <ChevronLeft className="mr-1 h-3.5 w-3.5" />
            {t("이전", "前へ")}
          </button>
          <button
            type="button"
            onClick={() => selectAdjacent(1)}
            disabled={targets.length === 0 || selectedIndex === targets.length - 1}
            aria-label={t("다음 차이로 이동", "次の差分へ移動")}
            className="-ml-px inline-flex h-7 items-center border border-slate-300 bg-white px-2 font-semibold text-slate-700 hover:bg-slate-50 focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-emerald-600 disabled:opacity-35"
          >
            {t("다음", "次へ")}
            <ChevronRight className="ml-1 h-3.5 w-3.5" />
          </button>
        </div>
        <span className="min-w-14 text-center font-mono text-[11px] text-slate-500" aria-live="polite">
          {selectedIndex >= 0 ? `${selectedIndex + 1} / ${targets.length}` : `— / ${targets.length}`}
        </span>
        <button
          type="button"
          aria-pressed={includeContext}
          onClick={() => setIncludeContext((value) => !value)}
          className={`h-7 border px-2 font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 ${
            includeContext
              ? "border-emerald-600 bg-emerald-50 text-emerald-800"
              : "border-slate-300 bg-white text-slate-600"
          }`}
        >
          {t("문맥 행", "文脈行")} {includeContext ? t("표시", "表示") : t("숨김", "非表示")}
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600" aria-label={t("차이 색상 범례와 개수", "差分色の凡例と件数")}>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 border border-amber-300 bg-amber-100" />{t("값·수식", "値・数式")} {counts.mismatch}</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 border border-red-300 bg-red-100" />{t("정답만", "正解のみ")} {counts.missing}</span>
          <span className="inline-flex items-center gap-1"><span className="h-3 w-3 border border-sky-300 bg-sky-100" />{t("시스템만", "システムのみ")} {counts.extra}</span>
        </div>
      </div>

      <div className="flex h-8 shrink-0 items-center border-b border-slate-300 bg-white text-xs">
        <div className="flex h-full w-24 shrink-0 items-center border-r border-slate-300 px-2 font-mono font-semibold text-slate-700" aria-label={t("선택한 셀 주소", "選択セルのアドレス")}>
          <span className="truncate">{formulaSelection.address}</span>
        </div>
        <span className="w-9 shrink-0 text-center font-serif text-sm italic text-slate-500" aria-hidden="true">fx</span>
        <div className="min-w-0 flex-1 truncate border-l border-slate-200 px-2 font-mono text-[11px] text-slate-700" aria-label={t("선택한 셀 값 또는 수식", "選択セルの値または数式")} title={formulaSelection.value}>
          {formulaSelection.value}
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 bg-white">
        <div
          className="min-w-0 flex-1 overflow-auto bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600"
          tabIndex={0}
          aria-label={t("정답지 스프레드시트 차이 표", "正解ファイルのスプレッドシート差分表")}
        >
          <table className="w-max min-w-full table-fixed border-separate border-spacing-0 text-[11px]">
            <thead>
              <tr className="h-7">
                <th className="sticky left-0 top-0 z-50 h-7 w-14 min-w-14 max-w-14 border-b border-r border-slate-300 bg-slate-200" aria-label={t("행 번호", "行番号")} />
                {review.columns.map((column) => (
                  <th
                    key={column.field}
                    className="sticky top-0 z-40 h-7 w-44 min-w-44 max-w-44 border-b border-r border-slate-300 bg-slate-200 px-2 text-center font-mono font-semibold text-slate-600"
                  >
                    {column.letter}
                  </th>
                ))}
              </tr>
              <tr className="h-8">
                <th className="sticky left-0 top-7 z-50 h-8 w-14 min-w-14 max-w-14 border-b border-r border-slate-300 bg-slate-100 text-center text-[10px] font-semibold text-slate-500">
                  {t("행", "行")}
                </th>
                {review.columns.map((column) => (
                  <th
                    key={column.field}
                    className="sticky top-7 z-40 h-8 w-44 min-w-44 max-w-44 overflow-hidden text-ellipsis whitespace-nowrap border-b border-r border-slate-300 bg-slate-100 px-2 text-left font-semibold text-slate-700"
                    title={fieldLabel(column.field, t)}
                  >
                    {fieldLabel(column.field, t)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {review.rows.map((row, rowIndex) => {
                if (!includeContext && !workbookRowHasDifference(row)) return null;
                const rowOverlay = row.row_overlays[0] ?? null;
                const rowTone = row.kind === "system-only"
                  ? "bg-sky-100"
                  : rowOverlay
                    ? "bg-red-100"
                    : "bg-white";
                const rowMarkerSelected = selectedPosition?.rowIndex === rowIndex
                  && selectedPosition.cellIndex === null;

                return (
                  <tr key={`${row.kind}:${row.sheet}:${row.row}`} className="h-8">
                    <th className={`sticky left-0 z-30 h-8 w-14 min-w-14 max-w-14 border-b border-r border-slate-300 p-0 text-center font-mono ${rowTone} ${rowMarkerSelected ? "ring-2 ring-inset ring-emerald-600" : ""}`}>
                      {rowOverlay ? (
                        <button
                          id={gridElementId(runId, { rowIndex, cellIndex: null })}
                          type="button"
                          onClick={() => selectTarget({ overlay: rowOverlay, rowIndex, cellIndex: null })}
                          aria-label={t(`${row.row}행 차이 선택`, `${row.row}行の差分を選択`)}
                          className="h-8 w-full overflow-hidden text-ellipsis whitespace-nowrap px-1 font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600"
                          title={`${row.sheet}!${row.address}`}
                        >
                          {row.kind === "system-only" ? "+" : ""}{row.row}
                        </button>
                      ) : (
                        <span className="block h-8 overflow-hidden text-ellipsis whitespace-nowrap px-1 py-2 font-medium text-slate-500" title={`${row.sheet}!${row.address}`}>
                          {row.row}
                        </span>
                      )}
                    </th>
                    {row.cells.map((cell, cellIndex) => {
                      const cellOverlay = cell.overlays[0] ?? null;
                      const selectableOverlay = cellOverlay ?? rowOverlay;
                      const cellTone = cellOverlay ? "bg-amber-100" : rowTone;
                      const cellSelected = selectedPosition?.rowIndex === rowIndex
                        && selectedPosition.cellIndex === cellIndex;
                      const shownValue = cell.formula ? `=${cell.formula}` : scalarText(cell.value);

                      return (
                        <td
                          key={cell.field}
                          id={gridElementId(runId, { rowIndex, cellIndex })}
                          className={`h-8 w-44 min-w-44 max-w-44 overflow-hidden border-b border-r border-slate-200 p-0 align-middle ${cellTone} ${cellSelected ? "ring-2 ring-inset ring-emerald-600" : ""}`}
                        >
                          {selectableOverlay ? (
                            <button
                              type="button"
                              onClick={() => selectTarget({
                                overlay: selectableOverlay,
                                rowIndex,
                                cellIndex: cellOverlay ? cellIndex : null,
                              }, cellIndex)}
                              aria-label={t(`${cell.address ?? row.address} 차이 선택`, `${cell.address ?? row.address}の差分を選択`)}
                              className="block h-8 w-full overflow-hidden text-ellipsis whitespace-nowrap px-2 text-left text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600"
                              title={shownValue}
                            >
                              {shownValue}
                            </button>
                          ) : (
                            <div className="h-8 overflow-hidden text-ellipsis whitespace-nowrap px-2 py-2 text-slate-800" title={shownValue}>
                              {shownValue}
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

        {selectedTarget ? (
          <aside className="absolute inset-y-0 right-0 z-[60] flex w-full flex-col border-l border-slate-300 bg-white shadow-xl sm:w-[380px] md:relative md:z-auto md:shadow-none" aria-label={t("선택한 차이 조사 패널", "選択した差分の調査パネル")}>
            <div className="flex h-10 shrink-0 items-center border-b border-slate-300 px-3">
              <h2 className="text-xs font-bold text-slate-900">{t("선택한 차이", "選択した差分")}</h2>
              <button
                type="button"
                onClick={() => {
                  setSelectedDiffId(null);
                  setSelectedPosition(null);
                }}
                aria-label={t("조사 패널 닫기", "調査パネルを閉じる")}
                className="ml-auto inline-flex h-7 w-7 items-center justify-center text-slate-500 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
              >
                <PanelRightClose className="hidden h-4 w-4 sm:block" />
                <X className="h-4 w-4 sm:hidden" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <p className="border-l-2 border-emerald-600 pl-2 text-xs font-semibold leading-5 text-slate-800">
                {differenceExplanation(selectedTarget.overlay, t)}
              </p>
              <dl className="mt-3 grid gap-2 text-[11px]">
                <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] border border-slate-200 bg-slate-50">
                  <dt className="border-r border-slate-200 px-2 py-1.5 font-semibold text-slate-600">{t("사람 위치", "人の位置")}</dt>
                  <dd className="truncate px-2 py-1.5 font-mono text-slate-800" title={locationText(selectedTarget.overlay.golden_location, t)}>{locationText(selectedTarget.overlay.golden_location, t)}</dd>
                </div>
                <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] border border-slate-200 bg-slate-50">
                  <dt className="border-r border-slate-200 px-2 py-1.5 font-semibold text-slate-600">{t("시스템 위치", "システム位置")}</dt>
                  <dd className="truncate px-2 py-1.5 font-mono text-slate-800" title={locationText(selectedTarget.overlay.candidate_location, t)}>{locationText(selectedTarget.overlay.candidate_location, t)}</dd>
                </div>
              </dl>
              <div className="mt-3 grid gap-2">
                <section className="border border-emerald-200 bg-emerald-50/40 p-2.5">
                  <h3 className="mb-1.5 text-[11px] font-bold text-emerald-800">{t("사람 정답 값", "人の正解値")}</h3>
                  <BoundedValue value={selectedTarget.overlay.answer_value} absent={selectedTarget.overlay.category === "extra"} t={t} />
                </section>
                <section className="border border-slate-200 bg-slate-50 p-2.5">
                  <h3 className="mb-1.5 text-[11px] font-bold text-slate-700">{t("시스템 값", "システム値")}</h3>
                  <BoundedValue value={selectedTarget.overlay.system_value} absent={selectedTarget.overlay.category === "missing"} t={t} />
                </section>
              </div>
              <div className="mt-3 border border-slate-200 bg-white p-2.5 text-[11px] text-slate-700">
                <p><strong>{t("검토 상태", "レビュー状態")}:</strong> {reviewStatusLabel(selectedTarget.overlay.review_status, t)}</p>
                <p className="mt-1"><strong>{t("조사 상태", "調査状態")}:</strong> {investigationStatusLabel(selectedTarget.overlay.investigation_status, t)}</p>
                {selectedTarget.overlay.root_cause_stage ? (
                  <p className="mt-1"><strong>{t("원인 단계", "原因段階")}:</strong> {rootCauseStageLabel(selectedTarget.overlay.root_cause_stage, t)}</p>
                ) : null}
                {selectedTarget.overlay.review_note ? (
                  <p className="mt-2 whitespace-pre-wrap break-words"><strong>{t("검토 메모", "レビューメモ")}:</strong> {selectedTarget.overlay.review_note}</p>
                ) : null}
                {selectedTarget.overlay.root_cause_summary ? (
                  <p className="mt-2 whitespace-pre-wrap break-words"><strong>{t("원인 요약", "原因要約")}:</strong> {selectedTarget.overlay.root_cause_summary}</p>
                ) : null}
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
          </aside>
        ) : null}
      </div>

      <footer className="flex h-9 shrink-0 items-end border-t border-slate-300 bg-slate-100 px-3">
        <button
          type="button"
          aria-current="page"
          className="h-8 max-w-64 border-x border-t border-slate-300 bg-white px-5 text-xs font-semibold text-emerald-800 shadow-[inset_0_2px_0_#188038] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-600"
          title={review.sheet_name}
        >
          <span className="block overflow-hidden text-ellipsis whitespace-nowrap">{review.sheet_name}</span>
        </button>
        <span className="ml-auto self-center text-[10px] text-slate-500">
          {t(`표시 행 ${visibleRows.length}개 · 차이 ${review.shown_diff_count}건`, `表示行${visibleRows.length}件 · 差分${review.shown_diff_count}件`)}
          {review.rows_truncated ? ` · ${t("일부 행 생략", "一部行を省略")}` : ""}
        </span>
      </footer>
    </main>
  );
}
