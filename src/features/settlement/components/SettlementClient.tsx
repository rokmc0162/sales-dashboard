'use client';

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type InputHTMLAttributes } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FolderOpen, Loader2, UploadCloud, Trash2 } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import SettlementCompareClient from '@/features/settlement/components/SettlementCompareClient';
import SettlementIntakeWorkspace from '@/features/settlement/components/SettlementIntakeWorkspace';
import {
  enqueueSettlementJob,
  exceedsSettlementJobFileLimit,
  fetchLatestSettlementJob,
  MAX_SETTLEMENT_JOB_FILES,
  parentFolderHint,
  pollSettlementJob,
  uploadSettlementFileToStorage,
  type SettlementJobStatus,
} from '@/features/settlement/lib/storage/direct-upload-client';

type UploadResult = {
  file?: string;
  platform?: string;
  parsed_rows?: number;
  sales_records_written?: number;
  sales_records_skipped_duplicates?: number;
  skipped?: boolean;
  skip_reason?: string;
  settlement_month?: string | null;
  sales_month?: string | null;
  error?: string;
  errors?: string[];
};

// "2026-05-01" → "202605" (server months are ISO first-of-month dates).
function isoToYyyymm(iso: string) {
  return iso.slice(0, 7).replace('-', '');
}

type ResetResult = Record<string, unknown> & { ok?: boolean; error?: string };

// One platform that already has settlement rows in a month — names only, no amounts/counts.
type MonthPlatform = { code: string | null; name: string | null };

function toIsoMonth(yyyymm: string) {
  return `${yyyymm.slice(0, 4)}-${yyyymm.slice(4, 6)}-01`;
}

type SelectedFile = { file: File; relativePath: string };

function fileKey(sf: SelectedFile) {
  return `${sf.relativePath}|${sf.file.size}|${sf.file.lastModified}`;
}

// Same file picked twice in one selection (or the same entry reached via two
// directory branches) should upload once.
function dedupeSelection(incoming: SelectedFile[]): SelectedFile[] {
  const map = new Map<string, SelectedFile>();
  for (const sf of incoming) map.set(fileKey(sf), sf);
  return Array.from(map.values());
}

// React/TS don't type the non-standard directory-picker attributes; the cast keeps them on the DOM input.
const folderInputProps = { webkitdirectory: '', directory: '' } as unknown as InputHTMLAttributes<HTMLInputElement>;

function jobResults(job: SettlementJobStatus, transferFailures: UploadResult[] = []): UploadResult[] {
  return [
    ...transferFailures,
    ...job.files.map((file) => ({
      file: file.filename,
      parsed_rows: file.parsed_rows ?? undefined,
      sales_records_written: file.sales_records_written ?? undefined,
      sales_records_skipped_duplicates: file.sales_records_skipped_duplicates ?? undefined,
      skipped: file.status === 'skipped',
      skip_reason: file.status === 'skipped' ? (file.result_summary ?? 'skipped') : undefined,
      error: file.status === 'failed' ? (file.error_summary ?? 'file processing failed') : undefined,
      settlement_month: job.month,
    })),
  ];
}

// Chrome returns at most 100 entries per readEntries() call; keep reading until it comes back empty.
// A read error still resolves with the entries gathered so far, flagged so the caller can count it.
function readAllDirectoryEntries(
  reader: FileSystemDirectoryReader,
): Promise<{ entries: FileSystemEntry[]; errored: boolean }> {
  return new Promise((resolve) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries(
        (entries) => {
          if (entries.length === 0) return resolve({ entries: all, errored: false });
          all.push(...entries);
          readBatch();
        },
        () => resolve({ entries: all, errored: true }),
      );
    };
    readBatch();
  });
}

// Collects files under an entry into `collected`; returns how many entries could not be read.
async function collectFilesFromEntry(entry: FileSystemEntry, collected: SelectedFile[]): Promise<number> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
    );
    if (!file) return 1;
    collected.push({ file, relativePath: entry.fullPath.replace(/^\//, '') });
    return 0;
  }
  if (entry.isDirectory) {
    let reader: FileSystemDirectoryReader;
    try {
      reader = (entry as FileSystemDirectoryEntry).createReader();
    } catch {
      return 1;
    }
    const { entries: children, errored } = await readAllDirectoryEntries(reader);
    let skipped = errored ? 1 : 0;
    for (const child of children) skipped += await collectFilesFromEntry(child, collected);
    return skipped;
  }
  return 1;
}

const YEAR_RANGE = 3;

type SettlementTab = 'work' | 'compare';

export default function SettlementClient({
  initialMonth,
  initialTab = 'work',
}: {
  initialMonth?: string;
  initialTab?: SettlementTab;
}) {
  const { t } = useApp();
  const now = new Date();
  const currentYear = now.getFullYear();
  const defaultMonth = `${currentYear}${String(now.getMonth() + 1).padStart(2, '0')}`;
  // The single source of truth for "which settlement month is this upload":
  // whatever the operator picked here is sent as activeMonth with every
  // request and overrides any month found inside file contents or names.
  const [month, setMonth] = useState(initialMonth ?? defaultMonth);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Synchronous guard against overlapping runs: a second drop while a folder
  // traversal or upload is still running must be ignored, and `uploading`
  // state alone updates too late for that.
  const uploadingRef = useRef(false);
  const busyOwnerRef = useRef<symbol | null>(null);
  const activePollControllerRef = useRef<AbortController | null>(null);
  // Live upload gauge: files handed off so far (in-flight file included),
  // out of the run's total, plus the name currently being processed.
  const [progress, setProgress] = useState<{ current: number; total: number; currentFile: string } | null>(null);
  const [jobStatus, setJobStatus] = useState<SettlementJobStatus | null>(null);
  const [resetting, setResetting] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  // The detailed per-file table is tall; keep it collapsed so the summary
  // stays the main content after an upload.
  const [resultsExpanded, setResultsExpanded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Which platforms already hold settlement rows, per YYYYMM of the shown
  // year. null = fetch failed/unavailable; bumping the version refetches
  // after an upload or reset changed the data.
  const [monthPlatforms, setMonthPlatforms] = useState<Record<string, MonthPlatform[]> | null>(null);
  const [monthPlatformsLoading, setMonthPlatformsLoading] = useState(false);
  const [monthPlatformsVersion, setMonthPlatformsVersion] = useState(0);

  const validMonth = /^\d{6}$/.test(month);
  const selectedYear = Number(month.slice(0, 4));
  const selectedMonthNum = Number(month.slice(4, 6));
  const minYear = currentYear - YEAR_RANGE;
  const maxYear = currentYear + YEAR_RANGE;

  useEffect(() => {
    window.history.replaceState(null, '', `/settlement?month=${month}${window.location.hash}`);
  }, [month]);

  useEffect(() => {
    if (initialTab !== 'compare') return;
    document.getElementById('answer-comparison')?.scrollIntoView();
  }, [initialTab]);

  useEffect(() => {
    let cancelled = false;
    setMonthPlatformsLoading(true);
    fetch(`/api/settlement/month-platforms?year=${selectedYear}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((json) => {
        if (!cancelled) setMonthPlatforms((json.months ?? {}) as Record<string, MonthPlatform[]>);
      })
      .catch(() => {
        if (!cancelled) setMonthPlatforms(null);
      })
      .finally(() => {
        if (!cancelled) setMonthPlatformsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedYear, monthPlatformsVersion]);

  useEffect(() => {
    if (!validMonth) return;
    const controller = new AbortController();
    let disposed = false;
    let owner: symbol | null = null;

    const recover = async () => {
      try {
        const latest = await fetchLatestSettlementJob(toIsoMonth(month), controller.signal);
        // A new upload may have acquired the busy lock while this lookup was
        // in flight. Recovery must never replace that newer owner.
        if (disposed || !latest || busyOwnerRef.current !== null) return;
        setJobStatus(latest);
        setResults(latest.terminal ? jobResults(latest) : []);
        if (latest.terminal) {
          setMessage(latest.status === 'completed'
            ? t('최근 정산 작업이 완료되었습니다.', '直近の精算処理は完了しました。')
            : t('최근 정산 작업 결과를 검토해 주세요.', '直近の精算処理結果をご確認ください。'));
          return;
        }

        owner = Symbol("settlement-recovery");
        activePollControllerRef.current?.abort();
        activePollControllerRef.current = controller;
        busyOwnerRef.current = owner;
        uploadingRef.current = true;
        setUploading(true);
        setMessage(t('진행 중인 정산 작업을 복구했습니다.', '進行中の精算処理を復元しました。'));
        const terminal = await pollSettlementJob(latest.id, {
          signal: controller.signal,
          onUpdate: (next) => {
            if (disposed) return;
            setJobStatus(next);
            if (next.terminal) setResults(jobResults(next));
          },
        });
        if (disposed) return;
        if (terminal.status === 'completed' || terminal.status === 'completed_with_warnings') {
          setMonthPlatformsVersion((version) => version + 1);
        }
        setMessage(terminal.status === 'completed'
          ? t('정산 작업이 완료되었습니다.', '精算処理が完了しました。')
          : t('정산 작업 결과를 검토해 주세요.', '精算処理結果をご確認ください。'));
      } catch (error) {
        if (!disposed && (error as Error).name !== 'AbortError') {
          setMessage(t(
            '작업 상태 확인 시간이 끝났습니다. 새로고침하면 진행 상태를 다시 불러옵니다.',
            '処理状況の確認時間が終了しました。再読み込みすると進行状況を再取得します。',
          ));
        }
      } finally {
        if (!disposed && owner !== null
          && activePollControllerRef.current === controller
          && busyOwnerRef.current === owner) {
          activePollControllerRef.current = null;
          busyOwnerRef.current = null;
          uploadingRef.current = false;
          setUploading(false);
        }
      }
    };

    void recover();
    return () => {
      disposed = true;
      controller.abort();
      if (owner !== null
        && activePollControllerRef.current === controller
        && busyOwnerRef.current === owner) {
        activePollControllerRef.current = null;
        busyOwnerRef.current = null;
        uploadingRef.current = false;
        setUploading(false);
      }
    };
  }, [month, t, validMonth]);

  const monthLabel = (yyyymm: string) =>
    t(`${Number(yyyymm.slice(0, 4))}년 ${Number(yyyymm.slice(4, 6))}월`, `${Number(yyyymm.slice(0, 4))}年${Number(yyyymm.slice(4, 6))}月`);

  function changeMonth(next: string) {
    if (next === month) return;
    setMonth(next);
  }

  function changeYear(nextYear: number) {
    if (nextYear < minYear || nextYear > maxYear) return;
    changeMonth(`${nextYear}${month.slice(4, 6)}`);
  }

  // Selecting or dropping files IS the upload: no staging list, no upload
  // button. Everything lands in the operator-picked settlement month.
  async function startUpload(incoming: SelectedFile[], unreadable: number, existingOwner?: symbol) {
    let owner = existingOwner ?? null;
    if (owner === null) {
      if (uploadingRef.current) {
        setMessage(t('업로드가 진행 중입니다. 끝난 뒤 다시 시도해 주세요.', 'アップロードが進行中です。完了後にもう一度お試しください。'));
        return;
      }
      owner = Symbol("settlement-upload");
      busyOwnerRef.current = owner;
      uploadingRef.current = true;
    } else if (busyOwnerRef.current !== owner) {
      return;
    }
    setUploading(true);
    const releaseBusy = () => {
      if (busyOwnerRef.current !== owner) return;
      busyOwnerRef.current = null;
      setUploading(false);
      uploadingRef.current = false;
    };
    const selected = dedupeSelection(incoming);
    if (selected.length === 0) {
      if (unreadable > 0) {
        setMessage(t(`읽을 수 있는 파일이 없습니다. (읽지 못한 항목 ${unreadable}개)`, `読み込めるファイルがありません。（読み込めなかった項目${unreadable}件）`));
      }
      releaseBusy();
      return;
    }
    if (exceedsSettlementJobFileLimit(selected.length)) {
      setMessage(t(
        `한 번에 최대 ${MAX_SETTLEMENT_JOB_FILES}개 파일만 업로드할 수 있습니다. 파일을 나누어 다시 선택해 주세요.`,
        `一度にアップロードできるファイルは最大${MAX_SETTLEMENT_JOB_FILES}件です。分けて選択し直してください。`,
      ));
      releaseBusy();
      return;
    }
    if (!validMonth) {
      releaseBusy();
      return;
    }
    // Snapshot the target month now: the picker is disabled during the run,
    // but the snapshot keeps every request and the final preview consistent
    // even if that ever changes.
    const targetMonth = month;
    const targetIso = toIsoMonth(targetMonth);
    const targetLabel = monthLabel(targetMonth);
    activePollControllerRef.current?.abort();
    activePollControllerRef.current = null;
    setMessage(null);
    setResults([]);
    setResultsExpanded(false);
    setJobStatus(null);
    let ownedPollController: AbortController | null = null;
    try {
      const transferred: Array<{ upload_id: string; position: number; folder_hint?: string }> = [];
      const transferFailures: UploadResult[] = [];
      for (const sf of selected) {
        setProgress({ current: transferred.length + transferFailures.length + 1, total: selected.length, currentFile: sf.relativePath });
        try {
          const uploaded = await uploadSettlementFileToStorage(sf.file, targetIso);
          const folderHint = parentFolderHint(sf.relativePath);
          transferred.push({
            upload_id: uploaded.upload_id,
            position: transferred.length,
            ...(folderHint ? { folder_hint: folderHint } : {}),
          });
        } catch {
          transferFailures.push({
            file: sf.relativePath,
            error: t('Storage 전송 실패', 'Storage転送失敗'),
          });
        }
        setResults([...transferFailures]);
      }
      setProgress(null);

      if (transferred.length === 0) {
        setMessage(t(
          '업로드 실패: Storage 전송에 성공한 파일이 없습니다.',
          'アップロード失敗: Storage転送に成功したファイルがありません。',
        ));
        return;
      }

      const enqueued = await enqueueSettlementJob(targetIso, transferred);
      const controller = new AbortController();
      ownedPollController = controller;
      activePollControllerRef.current = controller;
      setMessage(t(
        `${targetLabel} 작업을 대기열에 등록했습니다.${transferFailures.length > 0 ? ` 전송 실패 ${transferFailures.length}개는 제외했습니다.` : ''}${unreadable > 0 ? ` 읽지 못한 항목 ${unreadable}개도 제외했습니다.` : ''}`,
        `${targetLabel}の処理をキューに登録しました。${transferFailures.length > 0 ? `転送失敗${transferFailures.length}件は除外しました。` : ''}${unreadable > 0 ? `読み込めなかった項目${unreadable}件も除外しました。` : ''}`,
      ));
      const terminal = await pollSettlementJob(enqueued.job_id, {
        signal: controller.signal,
        onUpdate: (next) => {
          setJobStatus(next);
          setResults(next.terminal ? jobResults(next, transferFailures) : [...transferFailures]);
        },
      });
      if (terminal.status === 'completed' || terminal.status === 'completed_with_warnings') {
        setMonthPlatformsVersion((version) => version + 1);
      }
      setMessage(terminal.status === 'completed'
        ? t(`${targetLabel} 정산 작업이 완료되었습니다.`, `${targetLabel}の精算処理が完了しました。`)
        : t(`${targetLabel} 정산 작업 결과를 검토해 주세요.`, `${targetLabel}の精算処理結果をご確認ください。`));
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        setMessage(t(
          '정산 작업을 계속 확인할 수 없습니다. 전송된 파일은 다시 올리지 말고, 새로고침하여 작업 상태를 확인해 주세요.',
          '精算処理の確認を継続できません。転送済みファイルは再アップロードせず、再読み込みして処理状況をご確認ください。',
        ));
      }
    } finally {
      if (ownedPollController !== null
        && activePollControllerRef.current === ownedPollController) {
        activePollControllerRef.current = null;
      }
      setProgress(null);
      releaseBusy();
    }
  }

  function onFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []).map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    }));
    // Reset so selecting the same files/folder again still fires onChange.
    e.target.value = '';
    void startUpload(picked, 0);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!dragActive) setDragActive(true);
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    // dragleave also fires when moving over children; only deactivate when actually leaving the zone.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragActive(false);
  }

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (uploadingRef.current) {
      setMessage(t('업로드가 진행 중입니다. 끝난 뒤 다시 시도해 주세요.', 'アップロードが進行中です。完了後にもう一度お試しください。'));
      return;
    }
    const owner = Symbol("settlement-drop");
    busyOwnerRef.current = owner;
    uploadingRef.current = true;
    setUploading(true);
    try {
      // Entries and files must be captured synchronously: the DataTransfer item list
      // is cleared as soon as the handler yields to an await.
      const captured = Array.from(e.dataTransfer?.items ?? [])
        .filter((item) => item.kind === 'file')
        .map((item) => ({
          entry: typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null,
          file: item.getAsFile(),
        }));
      const collected: SelectedFile[] = [];
      let unreadable = 0;
      if (captured.length > 0) {
        for (const { entry, file } of captured) {
          if (entry) unreadable += await collectFilesFromEntry(entry, collected);
          else if (file) collected.push({ file, relativePath: file.name });
          else unreadable += 1;
        }
      } else {
        for (const file of Array.from(e.dataTransfer?.files ?? [])) {
          collected.push({ file, relativePath: file.name });
        }
      }
      await startUpload(collected, unreadable, owner);
    } catch {
      setMessage(t(
        '업로드를 시작하지 못했습니다. 다시 시도해 주세요.',
        'アップロードを開始できませんでした。もう一度お試しください。',
      ));
      if (busyOwnerRef.current === owner) {
        busyOwnerRef.current = null;
        setUploading(false);
        uploadingRef.current = false;
      }
    }
  }

  async function resetMonth() {
    if (!validMonth || resetting) return;
    const confirmed = window.confirm(
      t(
        `${month} 정산 데이터를 비우시겠습니까? 업로드 테스트를 다시 할 때만 사용해 주세요.`,
        `${month} の精算データを削除しますか？アップロードテストをやり直す場合のみ使用してください。`,
      ),
    );
    if (!confirmed) return;
    setResetting(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/settlement/reset/${month}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      const json = (await res.json().catch(() => ({}))) as ResetResult;
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setMessage(`${t('초기화 완료', '初期化完了')}: sales_records ${String(json.sales_records_deleted ?? 0)}${t('건 삭제', '件を削除')}`);
      setResults([]);
      setMonthPlatformsVersion((v) => v + 1);
    } catch (err) {
      setMessage(`${t('초기화 실패', '初期化失敗')}: ${(err as Error).message}`);
    } finally {
      setResetting(false);
    }
  }

  const failedResults = results.filter((r) => r.error);
  const skippedResults = results.filter((r) => r.skipped);
  const successfulResults = results.filter((r) => !r.error && !r.skipped && ((r.sales_records_written ?? 0) > 0 || (r.sales_records_skipped_duplicates ?? 0) > 0));
  const parsedRowsTotal = results.reduce((sum, r) => sum + (r.parsed_rows ?? 0), 0);
  const salesRowsTotal = results.reduce((sum, r) => sum + (r.sales_records_written ?? 0), 0);
  const phaseIndex = progress
    ? 0
    : !jobStatus
      ? 0
      : jobStatus.terminal
        ? 4
        : jobStatus.stage === 'parsing'
          ? 2
          : jobStatus.stage === 'workbook_generation' || jobStatus.stage === 'workbook_validation'
            ? 3
            : 1;
  const phaseLabels = [
    t('업로드', 'アップロード'),
    t('대기', '待機'),
    t(`파싱 ${jobStatus?.progress.current ?? 0}/${jobStatus?.progress.total ?? 0}`, `解析 ${jobStatus?.progress.current ?? 0}/${jobStatus?.progress.total ?? 0}`),
    t('Excel 검증', 'Excel検証'),
    jobStatus?.terminal
      ? jobStatus.status === 'completed'
        ? t('완료', '完了')
        : t('검토 필요', '要確認')
      : t('완료/검토 필요', '完了/要確認'),
  ];
  const progressPercent = progress
    ? Math.min(100, Math.round((progress.current / Math.max(progress.total, 1)) * 100))
    : jobStatus
      ? phaseIndex === 4
        ? 100
        : phaseIndex === 3
          ? 90
          : phaseIndex === 2
            ? Math.min(85, 20 + Math.round((jobStatus.progress.current / Math.max(jobStatus.progress.total, 1)) * 60))
            : 15
      : 0;
  const pickerButtonBase = 'rounded-xl py-3 text-base font-bold transition disabled:cursor-not-allowed disabled:opacity-40';

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-600">Settlement</p>
        <h1 className="mt-2 text-2xl font-bold text-slate-950 dark:text-white">{t('정산 작업·정답지 검토', '精算作業・正解ファイル確認')}</h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {t('정산월 선택 → 원본 파일 올리기 → 정답지와 차이 검토 순서로 진행합니다.', '精算月の選択 → 元ファイルのアップロード → 正解ファイルとの差分確認の順に進みます。')}
        </p>
      </header>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-950 dark:text-white">{t('1. 정산월 선택', '1. 精算月を選択')}</h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {t('작업과 정답지 비교가 함께 사용할 정산월입니다.', '作業と正解ファイル比較で共通して使用する精算月です。')}
            </p>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between rounded-xl bg-slate-100 px-2 py-1.5 dark:bg-slate-950">
          <button
            type="button"
            onClick={() => changeYear(selectedYear - 1)}
            disabled={uploading || selectedYear <= minYear}
            aria-label={t('이전 연도', '前の年')}
            className="rounded-lg p-2 text-slate-600 transition hover:bg-white hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="text-xl font-bold text-slate-950 dark:text-white">{t(`${selectedYear}년`, `${selectedYear}年`)}</span>
          <button
            type="button"
            onClick={() => changeYear(selectedYear + 1)}
            disabled={uploading || selectedYear >= maxYear}
            aria-label={t('다음 연도', '次の年')}
            className="rounded-lg p-2 text-slate-600 transition hover:bg-white hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6 xl:grid-cols-12">
          {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
            const yyyymm = `${selectedYear}${String(m).padStart(2, '0')}`;
            const active = m === selectedMonthNum;
            const hasData = (monthPlatforms?.[yyyymm]?.length ?? 0) > 0;
            return (
              <button
                key={m}
                type="button"
                onClick={() => changeMonth(yyyymm)}
                disabled={uploading}
                className={`${pickerButtonBase} ${
                  active && hasData
                    ? 'bg-emerald-600 text-white shadow-sm ring-2 ring-emerald-300 dark:ring-emerald-500'
                    : active
                      ? 'bg-blue-600 text-white shadow-sm'
                      : hasData
                        ? 'bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-300 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-800 dark:hover:bg-emerald-950/70'
                        : 'bg-slate-100 text-slate-700 hover:bg-blue-100 hover:text-blue-800 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800'
                }`}
              >
                {t(`${m}월`, `${m}月`)}
                {hasData && <span aria-hidden className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle" />}
              </button>
            );
          })}
        </div>

        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
          <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
            {t(`${monthLabel(month)} 저장된 플랫폼`, `${monthLabel(month)} 保存済みプラットフォーム`)}
          </p>
          {monthPlatformsLoading ? (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              <Loader2 className="mr-1 inline h-3 w-3 animate-spin align-[-2px]" />
              {t('플랫폼 현황을 불러오는 중…', 'プラットフォーム状況を読み込み中…')}
            </p>
          ) : monthPlatforms === null ? (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {t('플랫폼 현황을 불러오지 못했습니다.', 'プラットフォーム状況を読み込めませんでした。')}
            </p>
          ) : (monthPlatforms[month]?.length ?? 0) === 0 ? (
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              {t('이 달에는 저장된 정산 데이터가 없습니다.', 'この月には保存された精算データはありません。')}
            </p>
          ) : (
            <>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {monthPlatforms[month].map((p, idx) => (
                  <span
                    key={`${p.code ?? 'unknown'}-${idx}`}
                    className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
                  >
                    {p.name ?? p.code ?? t('미분류', '未分類')}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                {t('초록색 월은 이미 정산 데이터가 저장된 달입니다.', '緑色の月はすでに精算データが保存されている月です。')}
              </p>
            </>
          )}
        </div>

        <p className="mt-4 rounded-lg bg-blue-50 p-3 text-xs leading-relaxed text-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
          {t(
            `선택한 ${monthLabel(month)}이(가) 이번 업로드와 정답지 비교의 정산월이 됩니다. 파일 내용이나 폴더 이름에 다른 월이 적혀 있어도 항상 이 선택이 우선합니다.`,
            `選択した${monthLabel(month)}が今回のアップロードと正解ファイル比較の精算月になります。ファイル内容やフォルダ名に別の月が書かれていても、常にこの選択が優先されます。`,
          )}
        </p>
      </section>

      <SettlementIntakeWorkspace month={month} />

      <section>
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <h2 className="text-sm font-bold text-slate-950 dark:text-white">{t('기존 방식 파일 올리기 (비상용)', '従来方式のファイルアップロード（緊急用）')}</h2>
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={`mt-3 flex min-h-52 flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition ${dragActive ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30' : 'border-slate-300 dark:border-slate-700'}`}
          >
            {uploading ? (
              <Loader2 className="mb-3 h-10 w-10 animate-spin text-blue-600" />
            ) : (
              <UploadCloud className="mb-3 h-10 w-10 text-blue-600" />
            )}
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {uploading
                ? t('정산 작업 진행 중입니다…', '精算処理が進行中です…')
                : t('파일이나 폴더를 여기에 놓으면 바로 업로드가 시작됩니다', 'ファイルやフォルダをここにドロップすると、すぐにアップロードが始まります')}
            </span>
            <span className="mt-1 text-xs text-slate-500">
              {t(
                `놓는 즉시 ${monthLabel(month)} 정산월로 전송되고 작업 대기열에 등록됩니다. 일부 파일의 전송이 실패해도 성공한 파일은 처리됩니다.`,
                `ドロップすると、すぐに${monthLabel(month)}の精算月として転送され、処理キューに登録されます。一部の転送に失敗しても、成功したファイルは処理されます。`,
              )}
            </span>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <label className={`inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition dark:border-slate-700 dark:text-slate-100 ${uploading ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-blue-500'}`}>
                <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
                {t('파일 선택', 'ファイルを選択')}
                <input type="file" multiple className="hidden" onChange={onFileInputChange} disabled={uploading} />
              </label>
              <label className={`inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition dark:border-slate-700 dark:text-slate-100 ${uploading ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-blue-500'}`}>
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                {t('폴더 선택', 'フォルダを選択')}
                <input type="file" multiple className="hidden" onChange={onFileInputChange} disabled={uploading} {...folderInputProps} />
              </label>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              onClick={resetMonth}
              disabled={!validMonth || resetting || uploading}
              className="inline-flex items-center rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-900 dark:text-red-300"
            >
              {resetting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
              {t('해당 월 비우기', '該当月を削除')}
            </button>
          </div>

        </div>
      </section>

      {(progress || jobStatus) && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 shadow-sm dark:border-blue-900 dark:bg-blue-950/40">
          <div className="flex items-center text-sm font-semibold text-blue-900 dark:text-blue-100">
            {phaseIndex < 4 ? (
              <Loader2 className="mr-2 h-4 w-4 shrink-0 animate-spin" />
            ) : jobStatus?.status === 'completed' ? (
              <CheckCircle2 className="mr-2 h-4 w-4 shrink-0 text-emerald-600" />
            ) : (
              <AlertCircle className="mr-2 h-4 w-4 shrink-0 text-amber-600" />
            )}
            {phaseLabels[phaseIndex]} · {progressPercent}%
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs font-semibold">
            {phaseLabels.map((label, index) => (
              <span key={index} className={index === phaseIndex ? 'text-blue-800 dark:text-blue-200' : index < phaseIndex ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-400'}>
                {index > 0 && <span className="mr-1.5 text-slate-300 dark:text-slate-600">→</span>}
                {label}
              </span>
            ))}
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100 dark:bg-blue-900/60">
            <div className="h-full rounded-full bg-blue-600 transition-[width] duration-300" style={{ width: `${progressPercent}%` }} />
          </div>
          {progress && <p className="mt-2 break-all text-xs text-blue-800 dark:text-blue-200">{progress.currentFile}</p>}
        </div>
      )}

      {message && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:text-slate-200">
          {message}
        </div>
      )}

      {results.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-slate-950 dark:text-white">{t('처리 결과 요약', '処理結果サマリー')}</h2>
            <button
              type="button"
              onClick={() => setResultsExpanded((v) => !v)}
              className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:border-blue-500 dark:border-slate-700 dark:text-slate-100"
            >
              {resultsExpanded ? <ChevronUp className="mr-1.5 h-3.5 w-3.5" /> : <ChevronDown className="mr-1.5 h-3.5 w-3.5" />}
              {resultsExpanded ? t('처리결과 상세 접기', '処理結果の詳細を閉じる') : t('처리결과 상세 펼치기', '処理結果の詳細を開く')}
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {t(`파일 ${results.length}개`, `ファイル ${results.length}件`)}
            </span>
            <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
              {t(`성공 ${successfulResults.length}`, `成功 ${successfulResults.length}`)}
            </span>
            <span className={`rounded-full px-2.5 py-1 ${failedResults.length > 0 ? 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}>
              {t(`실패 ${failedResults.length}`, `失敗 ${failedResults.length}`)}
            </span>
            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
              {t(`건너뜀 ${skippedResults.length}`, `スキップ ${skippedResults.length}`)}
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {t(`파싱 행 ${parsedRowsTotal}`, `解析行 ${parsedRowsTotal}`)}
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {t(`정산 행 ${salesRowsTotal}`, `精算行 ${salesRowsTotal}`)}
            </span>
          </div>
          {failedResults.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-red-700 dark:text-red-300">
              {failedResults.slice(0, 3).map((r, idx) => (
                <li key={`${r.file ?? 'fail'}-${idx}`} className="break-all">
                  <AlertCircle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
                  {r.file ?? '-'}: {r.error}
                </li>
              ))}
              {failedResults.length > 3 && (
                <li className="text-slate-500 dark:text-slate-400">
                  {t(`외 ${failedResults.length - 3}건은 '처리결과 상세 펼치기'에서 확인해 주세요.`, `他${failedResults.length - 3}件は「処理結果の詳細を開く」でご確認ください。`)}
                </li>
              )}
            </ul>
          )}
        </section>
      )}

      {resultsExpanded && results.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-slate-950 dark:text-white">{t('처리 결과 상세', '処理結果詳細')}</h2>
            <button
              type="button"
              onClick={() => setResultsExpanded(false)}
              className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:border-blue-500 dark:border-slate-700 dark:text-slate-100"
            >
              <ChevronUp className="mr-1.5 h-3.5 w-3.5" />
              {t('처리결과 상세 접기', '処理結果の詳細を閉じる')}
            </button>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-800">
                <tr>
                  <th className="py-2 pr-3">{t('상태', '状態')}</th>
                  <th className="py-2 pr-3">{t('파일', 'ファイル')}</th>
                  <th className="py-2 pr-3">{t('플랫폼', 'プラットフォーム')}</th>
                  <th className="py-2 pr-3">{t('파싱 행', '解析行')}</th>
                  <th className="py-2 pr-3">{t('정산 행', '精算行')}</th>
                  <th className="py-2 pr-3">{t('정산월', '精算月')}</th>
                  <th className="py-2 pr-3">{t('메시지', 'メッセージ')}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, idx) => {
                  const ok = !r.error && !r.skipped && ((r.sales_records_written ?? 0) > 0 || (r.sales_records_skipped_duplicates ?? 0) > 0);
                  const skipped = Boolean(r.skipped);
                  return (
                    <tr key={`${r.file ?? 'row'}-${idx}`} className="border-b border-slate-100 dark:border-slate-800">
                      <td className="py-2 pr-3">
                        {ok ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        ) : skipped ? (
                          <AlertCircle className="h-4 w-4 text-amber-500" />
                        ) : (
                          <AlertCircle className="h-4 w-4 text-red-600" />
                        )}
                      </td>
                      <td className="py-2 pr-3">{r.file ?? '-'}</td>
                      <td className="py-2 pr-3">{r.platform ?? '-'}</td>
                      <td className="py-2 pr-3">{r.parsed_rows ?? '-'}</td>
                      <td className="py-2 pr-3">{r.sales_records_written ?? '-'}</td>
                      <td className="py-2 pr-3">{typeof r.settlement_month === 'string' ? isoToYyyymm(r.settlement_month) : '-'}</td>
                      <td className="py-2 pr-3 text-xs text-slate-500">{r.error ?? r.skip_reason ?? r.errors?.join('; ') ?? '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div id="answer-comparison" className="scroll-mt-6">
        <SettlementCompareClient month={month} />
      </div>
    </div>
  );
}
