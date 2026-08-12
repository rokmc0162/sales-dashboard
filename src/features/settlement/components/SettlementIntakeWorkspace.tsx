'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent, type InputHTMLAttributes } from 'react';
import { AlertCircle, ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronRight, FolderOpen, History, Loader2, RefreshCw, Send, Trash2, UploadCloud } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import SettlementPublicationResult from './SettlementPublicationResult';
import {
  IntakeApiError,
  ensureIntakeWorkspace,
  fetchIntakeWorkspace,
  removeIntakeFile,
  reorderIntakeDraft,
  submitIntakeVersion,
  uploadIntakeFile,
} from '@/features/settlement/lib/intake/intake-client';
import {
  INTAKE_ERROR,
  MAX_INTAKE_FILES,
  canonicalizeIntakePath,
  intakeFileName,
  type IntakeDraftFile,
  type IntakeWorkspace,
} from '@/features/settlement/lib/intake/contract';

type SelectedFile = { file: File; relativePath: string };

type UploadRowState = 'waiting' | 'hashing_uploading' | 'done' | 'duplicate' | 'error';

type UploadRow = {
  relativePath: string;
  state: UploadRowState;
  errorCode?: string;
  file?: File;
};

// React/TS don't type the non-standard directory-picker attributes; the cast keeps them on the DOM input.
const folderInputProps = { webkitdirectory: '', directory: '' } as unknown as InputHTMLAttributes<HTMLInputElement>;

// Chrome returns at most 100 entries per readEntries() call; keep reading until empty.
function readAllDirectoryEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    const all: FileSystemEntry[] = [];
    const readBatch = () => {
      reader.readEntries(
        (entries) => {
          if (entries.length === 0) return resolve(all);
          all.push(...entries);
          readBatch();
        },
        () => resolve(all),
      );
    };
    readBatch();
  });
}

async function collectFilesFromEntry(entry: FileSystemEntry, collected: SelectedFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) =>
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
    );
    if (file) collected.push({ file, relativePath: entry.fullPath.replace(/^\//, '') });
    return;
  }
  if (entry.isDirectory) {
    let reader: FileSystemDirectoryReader;
    try {
      reader = (entry as FileSystemDirectoryEntry).createReader();
    } catch {
      return;
    }
    const children = await readAllDirectoryEntries(reader);
    for (const child of children) await collectFilesFromEntry(child, collected);
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function SettlementIntakeWorkspace({ month }: { month: string }) {
  const { t } = useApp();
  const [workspace, setWorkspace] = useState<IntakeWorkspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [dragActive, setDragActive] = useState(false);
  const [uploadRows, setUploadRows] = useState<UploadRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expandedVersions, setExpandedVersions] = useState<Record<string, boolean>>({});
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const replaceTargetRef = useRef<IntakeDraftFile | null>(null);

  const validMonth = /^\d{4}(0[1-9]|1[0-2])$/.test(month);

  useEffect(() => {
    setWorkspace(null);
  }, [month]);

  useEffect(() => {
    if (!validMonth) {
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setLoadError(false);
    fetchIntakeWorkspace(month, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setWorkspace(next);
      })
      .catch((error) => {
        if (!controller.signal.aborted && (error as Error).name !== 'AbortError') {
          setLoadError(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [month, validMonth, reloadVersion]);

  const reload = useCallback(() => setReloadVersion((v) => v + 1), []);

  function describeError(error: unknown): string {
    if (error instanceof IntakeApiError) {
      switch (error.code) {
        case INTAKE_ERROR.staleDraftRevision:
          return t('다른 작업자가 초안을 변경했습니다. 목록을 새로 불러왔습니다.', '他の作業者が下書きを変更しました。一覧を再読み込みしました。');
        case INTAKE_ERROR.duplicatePath:
          return t('같은 경로의 파일이 이미 초안에 있습니다. 교체 버튼을 사용해 주세요.', '同じパスのファイルがすでに下書きにあります。差し替えボタンをご利用ください。');

        case INTAKE_ERROR.hashMismatch:
        case INTAKE_ERROR.sizeMismatch:
          return t('업로드 검증(크기/해시)에 실패했습니다. 파일을 다시 올려 주세요.', 'アップロード検証（サイズ/ハッシュ）に失敗しました。ファイルを再アップロードしてください。');
        case INTAKE_ERROR.draftNotReady:
          return t('업로드가 끝나지 않았거나 검증에 실패한 파일이 있어 제출할 수 없습니다.', 'アップロード未完了または検証失敗のファイルがあるため提出できません。');
        case INTAKE_ERROR.emptyDraft:
          return t('제출할 파일이 없습니다.', '提出するファイルがありません。');
        case INTAKE_ERROR.limitExceeded:
          return t(`파일 수 또는 용량 한도를 초과했습니다. (최대 ${MAX_INTAKE_FILES}개)`, `ファイル数または容量の上限を超えました。（最大${MAX_INTAKE_FILES}件）`);
        default:
          return t(`요청이 실패했습니다. (${error.code})`, `リクエストに失敗しました。（${error.code}）`);
      }
    }
    return t('요청이 실패했습니다. 잠시 후 다시 시도해 주세요.', 'リクエストに失敗しました。しばらくしてからもう一度お試しください。');
  }

  function handleMutationError(error: unknown) {
    setMessage(describeError(error));
    if (error instanceof IntakeApiError && error.code === INTAKE_ERROR.staleDraftRevision) {
      reload();
    }
  }

  async function withWorkspace(): Promise<IntakeWorkspace> {
    if (workspace?.intake && workspace.intake.month_key === month) return workspace;
    const ensured = await ensureIntakeWorkspace(month);
    if (ensured.intake?.month_key !== month) throw new Error('intake month changed');
    setWorkspace(ensured);
    return ensured;
  }

  async function startUploads(selected: SelectedFile[], replaceAll = false) {
    if (busyRef.current || selected.length === 0) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    const rows: UploadRow[] = selected.map((sf) => ({
      relativePath: sf.relativePath,
      state: 'waiting',
      file: sf.file,
    }));
    setUploadRows(rows);
    try {
      const ws = await withWorkspace();
      if (!ws.intake) throw new Error('intake missing');
      const intakeId = ws.intake.id;
      let revision = ws.draft.revision;
      let uploaded = 0;
      for (let i = 0; i < selected.length; i += 1) {
        const sf = selected[i];
        const canonical = canonicalizeIntakePath(sf.relativePath);
        if (!canonical.ok) {
          rows[i] = { ...rows[i], state: 'error', errorCode: canonical.error };
          setUploadRows([...rows]);
          continue;
        }
        rows[i] = { ...rows[i], state: 'hashing_uploading' };
        setUploadRows([...rows]);
        try {
          const result = await uploadIntakeFile({
            intakeId,
            file: sf.file,
            relativePath: sf.relativePath,
            expectedDraftRevision: revision,
            replace: replaceAll,
          });
          revision = result.draft_revision;
          uploaded += 1;
          rows[i] = { ...rows[i], state: 'done' };
        } catch (error) {
          if (error instanceof IntakeApiError && error.code === INTAKE_ERROR.duplicatePath) {
            rows[i] = { ...rows[i], state: 'duplicate', errorCode: error.code };
          } else if (error instanceof IntakeApiError && error.code === INTAKE_ERROR.staleDraftRevision) {
            rows[i] = { ...rows[i], state: 'error', errorCode: error.code };
          } else {
            rows[i] = {
              ...rows[i],
              state: 'error',
              errorCode: error instanceof IntakeApiError ? error.code : 'network',
            };
          }
        }
        setUploadRows([...rows]);
      }
      const duplicates = rows.filter((row) => row.state === 'duplicate').length;
      const failures = rows.filter((row) => row.state === 'error').length;
      setMessage(
        t(
          `업로드 완료: 성공 ${uploaded}개${duplicates > 0 ? `, 중복 ${duplicates}개` : ''}${failures > 0 ? `, 실패 ${failures}개` : ''}`,
          `アップロード完了: 成功${uploaded}件${duplicates > 0 ? `、重複${duplicates}件` : ''}${failures > 0 ? `、失敗${failures}件` : ''}`,
        ),
      );
    } catch (error) {
      handleMutationError(error);
    } finally {
      busyRef.current = false;
      setBusy(false);
      reload();
    }
  }

  async function retryDuplicateAsReplace(row: UploadRow) {
    if (!row.file || busyRef.current) return;
    await startUploads([{ file: row.file, relativePath: row.relativePath }], true);
  }

  function onFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []).map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name,
    }));
    e.target.value = '';
    void startUploads(picked);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!dragActive) setDragActive(true);
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragActive(false);
  }

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    if (busyRef.current) return;
    const captured = Array.from(e.dataTransfer?.items ?? [])
      .filter((item) => item.kind === 'file')
      .map((item) => ({
        entry: typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null,
        file: item.getAsFile(),
      }));
    const collected: SelectedFile[] = [];
    if (captured.length > 0) {
      for (const { entry, file } of captured) {
        if (entry) await collectFilesFromEntry(entry, collected);
        else if (file) collected.push({ file, relativePath: file.name });
      }
    } else {
      for (const file of Array.from(e.dataTransfer?.files ?? [])) {
        collected.push({ file, relativePath: file.name });
      }
    }
    void startUploads(collected);
  }

  async function onRemove(file: IntakeDraftFile) {
    if (!workspace?.intake || workspace.intake.month_key !== month || busyRef.current || loading) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await removeIntakeFile(workspace.intake.id, file.object_id, workspace.draft.revision);
    } catch (error) {
      handleMutationError(error);
    } finally {
      busyRef.current = false;
      setBusy(false);
      reload();
    }
  }

  async function onMove(file: IntakeDraftFile, direction: -1 | 1) {
    if (!workspace?.intake || workspace.intake.month_key !== month || busyRef.current || loading) return;
    const ordered = workspace.draft.files.slice().sort((a, b) => a.position - b.position);
    const index = ordered.findIndex((f) => f.object_id === file.object_id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    const ids = ordered.map((f) => f.object_id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    busyRef.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await reorderIntakeDraft(workspace.intake.id, ids, workspace.draft.revision);
    } catch (error) {
      handleMutationError(error);
    } finally {
      busyRef.current = false;
      setBusy(false);
      reload();
    }
  }

  function onReplaceClick(file: IntakeDraftFile) {
    if (!workspace?.intake || workspace.intake.month_key !== month || busyRef.current || loading) return;
    replaceTargetRef.current = file;
    replaceInputRef.current?.click();
  }

  async function onReplaceFilePicked(e: ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    e.target.value = '';
    const target = replaceTargetRef.current;
    replaceTargetRef.current = null;
    if (!picked || !target) return;
    // The replacement keeps the entry's relative path: only the bytes change.
    await startUploads([{ file: picked, relativePath: target.display_path }], true);
  }

  async function onSubmit() {
    if (!workspace?.intake || workspace.intake.month_key !== month || busyRef.current || submitting || loading) return;
    const fileCount = workspace.draft.files.length;
    const confirmed = window.confirm(
      t(
        `${month} 초안 ${fileCount}개 파일을 버전으로 제출하시겠습니까? 제출된 버전은 변경할 수 없습니다.`,
        `${month} の下書き${fileCount}件をバージョンとして提出しますか？提出後のバージョンは変更できません。`,
      ),
    );
    if (!confirmed) return;
    busyRef.current = true;
    setSubmitting(true);
    setBusy(true);
    setMessage(null);
    try {
      const result = await submitIntakeVersion(workspace.intake.id, workspace.draft.revision);
      setMessage(
        t(
          `버전 v${result.version.version_no}이(가) 제출되었습니다. (파일 ${result.version.file_count}개)`,
          `バージョン v${result.version.version_no} を提出しました。（ファイル${result.version.file_count}件）`,
        ),
      );
    } catch (error) {
      handleMutationError(error);
    } finally {
      busyRef.current = false;
      setSubmitting(false);
      setBusy(false);
      reload();
    }
  }

  const draftFiles = (workspace?.draft.files ?? []).slice().sort((a, b) => a.position - b.position);
  const versions = (workspace?.versions ?? []).slice().sort((a, b) => b.version_no - a.version_no);
  const totalBytes = draftFiles.reduce((sum, f) => sum + f.size_bytes, 0);
  const draftReady = draftFiles.length > 0 && draftFiles.every((f) => f.status === 'finalized');
  const activeUploads = uploadRows.filter((row) => row.state === 'hashing_uploading' || row.state === 'waiting');

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-950 dark:text-white">
            {t('정산 접수함 · 버전 관리', '精算受付ボックス・バージョン管理')}
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            {t(
              '파일을 올려 초안을 만들고, 검토 후 [버전 제출]로 확정합니다. 제출 전에는 처리가 시작되지 않습니다.',
              'ファイルをアップロードして下書きを作成し、確認後に「バージョン提出」で確定します。提出前は処理が開始されません。',
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={reload}
          disabled={loading || busy}
          className="inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition hover:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:text-slate-100"
        >
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          {t('새로고침', '再読み込み')}
        </button>
      </div>

      {versions.length > 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          {t(
            '초안을 변경한 뒤 다시 제출하면 새 버전으로 재처리됩니다. 기존 버전은 그대로 보존됩니다.',
            '下書きを変更して再提出すると、新しいバージョンとして再処理されます。既存のバージョンはそのまま保存されます。',
          )}
        </p>
      )}

      <div
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`mt-4 flex min-h-36 flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition ${dragActive ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30' : 'border-slate-300 dark:border-slate-700'}`}
      >
        {busy ? (
          <Loader2 className="mb-2 h-8 w-8 animate-spin text-blue-600" />
        ) : (
          <UploadCloud className="mb-2 h-8 w-8 text-blue-600" />
        )}
        <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {t('파일이나 폴더를 놓으면 초안에 추가됩니다', 'ファイルやフォルダをドロップすると下書きに追加されます')}
        </span>
        <span className="mt-1 text-xs text-slate-500">
          {t('추가만 될 뿐 처리는 시작되지 않습니다. [버전 제출]을 눌러야 확정됩니다.', '追加のみで処理は開始されません。「バージョン提出」で確定します。')}
        </span>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <label className={`inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition dark:border-slate-700 dark:text-slate-100 ${busy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-blue-500'}`}>
            <UploadCloud className="mr-1.5 h-3.5 w-3.5" />
            {t('파일 선택', 'ファイルを選択')}
            <input type="file" multiple className="hidden" onChange={onFileInputChange} disabled={busy} />
          </label>
          <label className={`inline-flex items-center rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-800 transition dark:border-slate-700 dark:text-slate-100 ${busy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-blue-500'}`}>
            <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
            {t('폴더 선택', 'フォルダを選択')}
            <input type="file" multiple className="hidden" onChange={onFileInputChange} disabled={busy} {...folderInputProps} />
          </label>
        </div>
      </div>

      <input type="file" className="hidden" ref={replaceInputRef} onChange={onReplaceFilePicked} />

      {uploadRows.length > 0 && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
          <p className="text-xs font-bold text-slate-700 dark:text-slate-200">
            {activeUploads.length > 0
              ? t(`업로드 진행 중 (${uploadRows.length - activeUploads.length}/${uploadRows.length})`, `アップロード進行中 (${uploadRows.length - activeUploads.length}/${uploadRows.length})`)
              : t('업로드 결과', 'アップロード結果')}
          </p>
          <ul className="mt-2 space-y-1 text-xs">
            {uploadRows.map((row, idx) => (
              <li key={`${row.relativePath}-${idx}`} className="flex items-center gap-2 break-all text-slate-600 dark:text-slate-300">
                {row.state === 'done' ? (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                ) : row.state === 'hashing_uploading' ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-600" />
                ) : row.state === 'waiting' ? (
                  <span className="inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-slate-300 dark:border-slate-600" />
                ) : (
                  <AlertCircle className={`h-3.5 w-3.5 shrink-0 ${row.state === 'duplicate' ? 'text-amber-500' : 'text-red-600'}`} />
                )}
                <span>{row.relativePath}</span>
                {row.state === 'duplicate' && (
                  <button
                    type="button"
                    onClick={() => void retryDuplicateAsReplace(row)}
                    disabled={busy}
                    className="rounded border border-amber-400 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50 dark:text-amber-300 dark:hover:bg-amber-950"
                  >
                    {t('교체', '差し替え')}
                  </button>
                )}
                {row.state === 'error' && row.errorCode && (
                  <span className="text-red-600 dark:text-red-400">({row.errorCode})</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {t(`초안 파일 ${draftFiles.length}개 · ${formatBytes(totalBytes)}`, `下書きファイル${draftFiles.length}件・${formatBytes(totalBytes)}`)}
          </h3>
          <button
            type="button"
            onClick={() => void onSubmit()}
            disabled={!draftReady || busy || loading}
            className="inline-flex items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            {t('버전 제출', 'バージョン提出')}
          </button>
        </div>

        {loading && !workspace ? (
          <p className="mt-3 flex items-center text-sm text-slate-500 dark:text-slate-400">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t('접수함을 불러오는 중…', '受付ボックスを読み込み中…')}
          </p>
        ) : loadError ? (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {t('접수함을 불러오지 못했습니다.', '受付ボックスを読み込めませんでした。')}
          </div>
        ) : draftFiles.length === 0 ? (
          <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
            {t('아직 초안에 파일이 없습니다. 위에서 파일이나 폴더를 추가해 주세요.', 'まだ下書きにファイルがありません。上からファイルやフォルダを追加してください。')}
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs text-slate-500 dark:border-slate-800">
                <tr>
                  <th className="py-2 pr-3">#</th>
                  <th className="py-2 pr-3">{t('경로', 'パス')}</th>
                  <th className="py-2 pr-3">{t('크기', 'サイズ')}</th>
                  <th className="py-2 pr-3">{t('상태', '状態')}</th>
                  <th className="py-2 pr-3">{t('올린 사람 · 시각', 'アップロード者・時刻')}</th>
                  <th className="py-2 pr-3">{t('관리', '管理')}</th>
                </tr>
              </thead>
              <tbody>
                {draftFiles.map((file, index) => (
                  <tr key={file.object_id} className="border-b border-slate-100 dark:border-slate-800">
                    <td className="py-2 pr-3 text-xs text-slate-500">{index + 1}</td>
                    <td className="py-2 pr-3">
                      <span className="break-all font-medium text-slate-800 dark:text-slate-100">{file.display_path}</span>
                      {file.locked_by_version && (
                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          {t('버전에 포함됨', 'バージョンに含まれる')}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs">{formatBytes(file.size_bytes)}</td>
                    <td className="py-2 pr-3">
                      {file.status === 'finalized' ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
                          {t('검증 완료', '検証済み')}
                        </span>
                      ) : file.status === 'uploading' ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                          {t('업로드 미완료', 'アップロード未完了')}
                        </span>
                      ) : (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-800 dark:bg-red-950/60 dark:text-red-300">
                          {t('재업로드 필요', '再アップロード必要')}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-500">
                      <span className="break-all">{file.uploaded_by}</span>
                      <br />
                      {new Date(file.uploaded_at).toLocaleString()}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => void onMove(file, -1)}
                          disabled={busy || index === 0}
                          aria-label={t('위로', '上へ')}
                          className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                        >
                          <ArrowUp className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void onMove(file, 1)}
                          disabled={busy || index === draftFiles.length - 1}
                          aria-label={t('아래로', '下へ')}
                          className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"
                        >
                          <ArrowDown className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onReplaceClick(file)}
                          disabled={busy}
                          className="rounded border border-slate-300 px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:border-blue-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:text-slate-200"
                        >
                          {t('교체', '差し替え')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void onRemove(file)}
                          disabled={busy}
                          aria-label={t('초안에서 제거', '下書きから削除')}
                          className="rounded p-1 text-red-600 hover:bg-red-50 disabled:opacity-30 dark:hover:bg-red-950/40"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {message && (
        <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
          {message}
        </p>
      )}

      <div className="mt-6">
        <h3 className="flex items-center text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          <History className="mr-1.5 h-3.5 w-3.5" />
          {t('제출된 버전', '提出済みバージョン')}
        </h3>
        {versions.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {t('아직 제출된 버전이 없습니다.', 'まだ提出されたバージョンはありません。')}
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {versions.map((version) => {
              const expanded = expandedVersions[version.id] === true;
              return (
                <li key={version.id} className="rounded-lg border border-slate-200 dark:border-slate-800">
                  <button
                    type="button"
                    onClick={() => setExpandedVersions((prev) => ({ ...prev, [version.id]: !expanded }))}
                    className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm"
                  >
                    {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" /> : <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />}
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-bold text-blue-800 dark:bg-blue-950/60 dark:text-blue-200">
                      v{version.version_no}
                    </span>
                    <span className="text-xs text-slate-600 dark:text-slate-300">
                      {t(`파일 ${version.file_count}개 · ${formatBytes(version.total_size_bytes)}`, `ファイル${version.file_count}件・${formatBytes(version.total_size_bytes)}`)}
                    </span>
                    <span className="break-all text-xs text-slate-500">
                      {version.submitted_by} · {new Date(version.created_at).toLocaleString()}
                    </span>
                  </button>
                  {expanded && (
                    <ul className="border-t border-slate-100 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">
                      {version.files.map((file) => (
                        <li key={file.id} className="flex flex-wrap items-center justify-between gap-2 py-0.5">
                          <span className="break-all">{file.position + 1}. {file.display_path}</span>
                          <span className="text-slate-400">{formatBytes(file.size_bytes)} · {intakeFileName(file.display_path)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <SettlementPublicationResult month={month} latestVersionNo={versions[0]?.version_no ?? null} />
    </section>
  );
}
