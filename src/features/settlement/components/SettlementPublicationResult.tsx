'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Download, Loader2, RefreshCw } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import InputPreviewWindow from './InputPreviewWindow';

type Status = {
  month: string;
  status: 'not_submitted' | 'queued' | 'processing' | 'failed' | 'published';
  versionNo: number | null;
  currentAvailable: boolean;
  currentVersionNo: number | null;
  sheetCount: number | null;
  rowCount: number | null;
  publishedAt: string | null;
};

export default function SettlementPublicationResult({
  month,
  latestVersionNo,
}: { month: string; latestVersionNo: number | null }) {
  const { t } = useApp();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(false);
  const requestGeneration = useRef(0);
  const load = useCallback(async () => {
    if (!/^\d{6}$/.test(month)) return;
    const generation = ++requestGeneration.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/settlement/publications/${month}/status`, { cache: 'no-store' });
      if (!response.ok) throw new Error('status');
      const next = await response.json() as Status;
      if (generation === requestGeneration.current) {
        // Capture latestVersionNo in this request generation. A mismatched
        // response remains visible, but polling below continues until it catches up.
        void latestVersionNo;
        setStatus(next);
      }
    } catch {
      if (generation === requestGeneration.current) setStatus(null);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [month, latestVersionNo]);

  useEffect(() => {
    void load();
    return () => { requestGeneration.current += 1; };
  }, [load]);
  useEffect(() => {
    const latestSettled = status?.versionNo === latestVersionNo
      && (status?.status === 'published' || status?.status === 'failed');
    if (latestVersionNo === null || latestSettled) return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [latestVersionNo, load, status?.status, status?.versionNo]);

  if (latestVersionNo === null && !status?.currentAvailable) return null;
  const labels = {
    not_submitted: t('제출 대기', '提出待ち'), queued: t('처리 대기', '処理待ち'),
    processing: t('Mac mini 처리 중', 'Mac mini 処理中'), failed: t('확인 필요', '確認が必要'),
    published: t('최종 결과 준비 완료', '最終結果の準備完了'),
  };
  const current = status?.status ?? 'processing';

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{t('정산 처리 결과', '精算処理結果')}</p>
          <p className="mt-1 flex items-center text-sm font-semibold text-slate-900 dark:text-white">
            {current === 'published' ? <CheckCircle2 className="mr-2 h-4 w-4 text-emerald-600" /> : <Loader2 className={`mr-2 h-4 w-4 text-blue-600 ${current === 'failed' ? '' : 'animate-spin'}`} />}
            {labels[current]}
            {status?.versionNo ? ` · v${status.versionNo}` : ''}
          </p>
          {status?.currentAvailable && (
            <p className="mt-1 text-xs text-slate-500">
              {current !== 'published' && t(
                `현재 공개본 v${status.currentVersionNo ?? '-'}은 계속 사용할 수 있습니다. `,
                `現在の公開版 v${status.currentVersionNo ?? '-'} は引き続き利用できます。 `,
              )}
              {t(`시트 ${status?.sheetCount ?? 0}개 · 행 ${status?.rowCount ?? 0}개`, `シート${status?.sheetCount ?? 0}件・行${status?.rowCount ?? 0}件`)}
              {status?.publishedAt ? ` · ${new Date(status.publishedAt).toLocaleString()}` : ''}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void load()} disabled={loading}
            className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold dark:border-slate-700">
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{t('상태 새로고침', '状態更新')}
          </button>
          {status?.currentAvailable && <>
            <button type="button" onClick={() => setPreview((value) => !value)}
              className="inline-flex items-center rounded-lg border border-blue-300 px-3 py-2 text-xs font-semibold text-blue-700 dark:border-blue-800 dark:text-blue-300">
              {preview ? <ChevronDown className="mr-1.5 h-3.5 w-3.5" /> : <ChevronRight className="mr-1.5 h-3.5 w-3.5" />}
              {t('정산서 미리보기', '精算書プレビュー')}
            </button>
            <a href={`/api/settlement/publications/${month}/download`} download
              className="inline-flex items-center rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700">
              <Download className="mr-1.5 h-3.5 w-3.5" />{t('최종 Excel 다운로드', '最終Excelダウンロード')}
            </a>
          </>}
        </div>
      </div>
      {preview && status?.currentAvailable && <div className="mt-5 h-[70vh] min-h-[520px]"><InputPreviewWindow key={`${month}-${status.currentVersionNo ?? 0}`} month={month} published revision={status.currentVersionNo} /></div>}
    </section>
  );
}
