'use client';

import { useCallback, useEffect, useState } from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import InputPreviewTable, { type PreviewData } from './InputPreviewTable';
import { reviewPreviewSheets } from './input-preview-selection';

// Error state carries a kind instead of a translated string so that switching
// the UI language never has to re-run the (expensive) preview fetch.
type LoadError = { kind: 'missing' } | { kind: 'failed'; message: string };

function normalizeMonth(value: string): string {
  const trimmed = String(value ?? '').trim();
  const iso = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(trimmed);
  if (iso) return `${iso[1]}${iso[2]}`;
  return trimmed;
}

export default function InputPreviewWindow({
  month,
  published = false,
  revision = null,
}: { month: string; published?: boolean; revision?: number | null }) {
  const { t } = useApp();
  const normalizedMonth = normalizeMonth(month);
  const validMonth = /^\d{6}$/.test(normalizedMonth);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(validMonth);
  const [error, setError] = useState<LoadError | null>(null);
  const [activeSheet, setActiveSheet] = useState<string | null>(null);

  const load = useCallback(async () => {
    // The revision is an immutable publication generation. Reading it here
    // intentionally binds this fetch to a current-pointer change.
    void revision;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(published
        ? `/api/settlement/publications/${normalizedMonth}/preview`
        : `/api/settlement/preview-v2/${normalizedMonth}`);
      const json = await res.json().catch(() => ({}));
      if (res.status === 404) {
        setPreview(null);
        setActiveSheet(null);
        setError({ kind: 'missing' });
        return;
      }
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const data = json as PreviewData;
      if (published) {
        setPreview(data);
        const firstInput = data.sheets.find((s) => s.name.startsWith('input_'));
        setActiveSheet(firstInput?.name ?? data.sheets[0]?.name ?? null);
      } else {
        const sheets = reviewPreviewSheets(data.sheets);
        setPreview({ ...data, sheets });
        setActiveSheet(sheets[0]?.name ?? null);
      }
    } catch (err) {
      setPreview(null);
      setActiveSheet(null);
      setError({ kind: 'failed', message: (err as Error).message });
    } finally {
      setLoading(false);
    }
  }, [normalizedMonth, published, revision]);

  useEffect(() => {
    if (validMonth) void load();
  }, [validMonth, load]);

  if (!validMonth) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {t(`잘못된 정산월입니다: ${month} (YYYYMM 형식이어야 합니다)`, `無効な精算月です: ${month}（YYYYMM形式である必要があります）`)}
        </div>
      </div>
    );
  }

  const monthLabel = t(
    `${Number(normalizedMonth.slice(0, 4))}년 ${Number(normalizedMonth.slice(4, 6))}월`,
    `${Number(normalizedMonth.slice(0, 4))}年${Number(normalizedMonth.slice(4, 6))}月`,
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-600">Settlement</p>
          <h1 className="mt-1 text-xl font-bold text-slate-950 dark:text-white">
            {published
              ? t(`${monthLabel} 검증된 최종 정산 데이터`, `${monthLabel} 検証済み最終精算データ`)
              : t(`${monthLabel} 나카타니 확인용 Excel`, `${monthLabel} 中谷さん確認用Excel`)}
          </h1>
          {preview && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {t(`정산 행 ${preview.rowsWritten}개 · 시트 ${preview.sheets.length}개`, `精算行 ${preview.rowsWritten}件・シート ${preview.sheets.length}件`)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-100"
          >
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            {t('새로고침', '更新')}
          </button>
          <a
            href={published
              ? `/api/settlement/publications/${normalizedMonth}/download`
              : `/api/settlement/export-current/${normalizedMonth}.xlsx`}
            download={published ? `JP_INPUT_${normalizedMonth}.xlsx` : `JP_INPUT_REVIEW_DRAFT_${normalizedMonth}.xlsx`}
            className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700"
          >
            <Download className="mr-2 h-4 w-4" />
            {published
              ? t('검증된 최종 Excel 다운로드', '検証済み最終Excelをダウンロード')
              : t('중간 확인용 Excel 다운로드', '確認用Excel（未確定）をダウンロード')}
          </a>
          {!published && <a
            href={`/api/settlement/export-v2/${normalizedMonth}.xlsx`}
            download={`JP_INPUT_V2_${normalizedMonth}.xlsx`}
            className="inline-flex items-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 dark:border-slate-700 dark:text-slate-100"
          >
            <Download className="mr-2 h-4 w-4" />
            {t('완전성 검사 후 최종 Excel', '完全性検査後の最終Excel')}
          </a>}
        </div>
      </header>

      {!published && (
        <div className="shrink-0 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm font-semibold leading-relaxed text-blue-900 shadow-sm dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
          {t(
            '나카타니 확인용 중간본입니다. 전자·출판 시트를 모두 확인할 수 있지만, 아직 최종 정산서가 아닙니다.',
            '中谷さん確認用の未確定版です。電子・出版の両シートを確認できますが、最終精算書ではありません。',
          )}
        </div>
      )}

      {loading && !preview && (
        <div className="flex items-center justify-center rounded-2xl border border-slate-200 bg-white p-16 text-sm text-slate-500 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          <Loader2 className="mr-2 h-5 w-5 animate-spin text-blue-600" />
          {t('미리보기를 생성하는 중입니다…', 'プレビューを生成しています…')}
        </div>
      )}

      {error?.kind === 'missing' && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 shadow-sm dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          {t(
            `${monthLabel} 데이터가 없습니다. 정산 화면에서 파일을 업로드한 뒤 다시 열어 주세요.`,
            `${monthLabel}のデータがありません。精算画面でファイルをアップロードしてから、もう一度開いてください。`,
          )}
        </div>
      )}
      {error?.kind === 'failed' && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 shadow-sm dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {t('미리보기 실패', 'プレビュー失敗')}: {error.message}
        </div>
      )}

      {preview && (preview.sourceWarnings?.length ?? 0) > 0 && (
        <div className="shrink-0 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-relaxed text-amber-900 shadow-sm dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          {t(
            `필수 소스 ${preview.sourceWarnings?.length ?? 0}개가 누락되었거나 처리되지 않았습니다. 현재 파싱본은 검토용이며 최종 정산서가 아닙니다.`,
            `必須ソース${preview.sourceWarnings?.length ?? 0}件が不足しているか、処理されていません。現在の解析版は確認用であり、最終精算書ではありません。`,
          )}
          <span className="ml-1 font-semibold">({preview.sourceWarnings?.join(', ')})</span>
        </div>
      )}

      {preview && activeSheet && (
        <InputPreviewTable preview={preview} activeSheet={activeSheet} onSheetChange={setActiveSheet} />
      )}
    </div>
  );
}
