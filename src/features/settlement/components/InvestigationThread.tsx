"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import { useApp } from "@/context/AppContext";
import { COMMENT_BODY_MAX_LENGTH } from "@/features/settlement/lib/comparison/investigation";
import {
  hasConfirmedRootCause,
  investigationStatusLabel,
  rootCauseStageLabel,
  suggestRootCauseCandidates,
} from "@/features/settlement/lib/comparison/investigation-ui";
import type {
  ComparisonCommentAuthorType,
  ComparisonDiffCategory,
  ComparisonInvestigationStatus,
  ComparisonRootCauseStage,
} from "@/features/settlement/lib/supabase/types";

type ThreadComment = {
  id: string;
  author_type: ComparisonCommentAuthorType;
  body: string;
  created_at: string;
};

const STATUS_BADGE: Record<ComparisonInvestigationStatus, string> = {
  uninvestigated: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  question_pending: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
  investigating: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-200",
  cause_confirmed: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-200",
  fix_in_progress: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-200",
  verification_pending: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
  resolved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200",
};

function authorLabel(author: ComparisonCommentAuthorType, t: (ko: string, ja: string) => string) {
  if (author === "operator") return t("작업자", "作業者");
  if (author === "hermes") return "Hermes";
  return t("시스템", "システム");
}

function mergeComments(current: ThreadComment[], incoming: ThreadComment[]): ThreadComment[] {
  const byId = new Map(incoming.map((comment) => [comment.id, comment]));
  for (const comment of current) byId.set(comment.id, comment);
  return [...byId.values()].sort((a, b) =>
    a.created_at === b.created_at
      ? a.id.localeCompare(b.id)
      : a.created_at.localeCompare(b.created_at),
  );
}

export default function InvestigationThread({
  diffId,
  category,
  field,
  investigationStatus,
  rootCauseStage,
  rootCauseSummary,
  onQuestionPosted,
}: {
  diffId: string;
  category: ComparisonDiffCategory;
  field: string | null;
  investigationStatus: ComparisonInvestigationStatus;
  rootCauseStage: ComparisonRootCauseStage | null;
  rootCauseSummary: string | null;
  onQuestionPosted: (diffId: string) => void;
}) {
  const { t } = useApp();
  const [comments, setComments] = useState<ThreadComment[]>([]);
  const [commentsTruncated, setCommentsTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const postAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      postAbortRef.current?.abort();
    };
  }, []);

  // The component only mounts while its diff group is expanded. A late GET is
  // merged by comment id so it cannot overwrite a comment posted meanwhile.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setLoadError(null);
    setComments([]);
    setCommentsTruncated(false);

    void (async () => {
      try {
        const res = await fetch(`/api/settlement/comparisons/diffs/${diffId}/comments`, {
          signal: controller.signal,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        if (controller.signal.aborted || !mountedRef.current) return;
        setComments((prev) => mergeComments(prev, (json.comments ?? []) as ThreadComment[]));
        setCommentsTruncated(Boolean(json.truncated));
      } catch (e) {
        if (!controller.signal.aborted && mountedRef.current) {
          setLoadError((e as Error).message);
        }
      } finally {
        if (!controller.signal.aborted && mountedRef.current) setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [diffId]);

  async function submit() {
    const body = draft.trim();
    if (body.length === 0 || posting || loading) return;

    const controller = new AbortController();
    postAbortRef.current?.abort();
    postAbortRef.current = controller;
    setPosting(true);
    setPostError(null);

    try {
      const res = await fetch(`/api/settlement/comparisons/diffs/${diffId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      if (controller.signal.aborted || !mountedRef.current) return;
      setComments((prev) => mergeComments(prev, [json.comment as ThreadComment]));
      setDraft("");
      onQuestionPosted(diffId);
    } catch (e) {
      if (!controller.signal.aborted && mountedRef.current) {
        setPostError((e as Error).message);
      }
    } finally {
      if (!controller.signal.aborted && mountedRef.current) setPosting(false);
      if (postAbortRef.current === controller) postAbortRef.current = null;
    }
  }

  const confirmed = hasConfirmedRootCause(
    investigationStatus,
    rootCauseStage,
    rootCauseSummary,
  );
  const hasRecordedCause = rootCauseStage !== null || (rootCauseSummary ?? "").trim().length > 0;
  const candidates = suggestRootCauseCandidates(category, field);
  const canSubmit = draft.trim().length > 0 && !posting && !loading;

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-slate-900 dark:text-white">
          {t("원인 조사", "原因調査")}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[investigationStatus]}`}
        >
          {investigationStatusLabel(investigationStatus, t)}
        </span>
      </div>

      {hasRecordedCause && (
        <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50 p-2.5 text-xs text-violet-900 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-100">
          <p className="font-semibold">
            {confirmed
              ? t("확정 원인", "確定原因")
              : t("기록된 조사 내용 (아직 확정 아님)", "記録済みの調査内容（未確定）")}
            {rootCauseStage
              ? ` · ${rootCauseStageLabel(rootCauseStage, t)}`
              : ""}
          </p>
          {rootCauseSummary && (
            <p className="mt-1 whitespace-pre-wrap break-words">{rootCauseSummary}</p>
          )}
        </div>
      )}

      <div className="mt-2 rounded-lg border border-slate-200 bg-white p-2.5 text-xs dark:border-slate-800 dark:bg-slate-900">
        <p className="font-semibold text-slate-700 dark:text-slate-200">
          {t("원인 후보 (자동 추정 · 확정 아님)", "原因候補（自動推定・確定ではありません）")}
        </p>
        <ul className="mt-1 space-y-0.5 text-slate-600 dark:text-slate-300">
          {candidates.map((candidate) => (
            <li key={`${candidate.stage}:${candidate.ko}`}>
              <span className="font-semibold">{rootCauseStageLabel(candidate.stage, t)}</span>
              {" · "}
              {t(candidate.ko, candidate.ja)}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-2">
        {loading && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
            {t("코멘트 불러오는 중", "コメント読み込み中")}
          </p>
        )}
        {!loading && loadError && (
          <p className="text-xs text-red-700 dark:text-red-300">
            <AlertCircle className="mr-1 inline h-3 w-3 align-[-2px]" />
            {loadError}
          </p>
        )}
        {!loading && !loadError && commentsTruncated && (
          <p className="mb-1 text-xs text-amber-700 dark:text-amber-300">
            {t("이전 코멘트 일부가 생략되었습니다.", "以前のコメントの一部を省略しています。")}
          </p>
        )}
        {!loading && !loadError && comments.length === 0 && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t("아직 코멘트가 없습니다.", "まだコメントはありません。")}
          </p>
        )}
        {!loading && !loadError && comments.length > 0 && (
          <ul className="max-h-64 space-y-1.5 overflow-y-auto">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className="rounded-lg border border-slate-200 bg-white p-2 text-xs dark:border-slate-800 dark:bg-slate-900"
              >
                <p className="font-semibold text-slate-700 dark:text-slate-200">
                  {authorLabel(comment.author_type, t)}
                  <span className="ml-2 font-normal text-slate-400 dark:text-slate-500">
                    {new Date(comment.created_at).toLocaleString()}
                  </span>
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-slate-900 dark:text-slate-100">
                  {comment.body}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, COMMENT_BODY_MAX_LENGTH))}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={t(
            "왜 다른 건가요? 확인해 주세요.",
            "なぜ違うのですか？ご確認ください。",
          )}
          rows={2}
          disabled={posting || loading}
          aria-label={t("질문/코멘트 입력", "質問/コメント入力")}
          className="flex-1 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="inline-flex items-center justify-center rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {posting && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
          {t("질문/코멘트 저장", "質問/コメント保存")}
        </button>
      </div>
      {postError && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{postError}</p>}
    </div>
  );
}
