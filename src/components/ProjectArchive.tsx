import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useProject } from '../lib/project-context';
import {
  projectSummary,
  readWorkspaceProject,
  readProjectLibrary,
  maxProjectCount,
  type VoiceProject,
} from '../../shared/project';
import { type ProjectArchive as Archive } from '../../shared/project-archive';

export function ProjectArchive({
  disabled,
  getProject,
  onLockChange,
}: {
  disabled: boolean;
  getProject: () => VoiceProject;
  onLockChange: (locked: boolean) => void;
}) {
  const { ensureIdle, transition } = useProject();
  const [pending, setPending] = useState<Archive | null>(null);
  const [busy, setBusy] = useState(false);
  const [choose, setChoose] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const getter = useRef(getProject);
  useLayoutEffect(() => {
    getter.current = getProject;
  });
  const signature = () => {
    const project = getter.current();
    return JSON.stringify([project.name, project.documents]);
  };
  const baseline = useRef<string | null>(null);
  useEffect(() => {
    try {
      baseline.current = signature();
    } catch {
      /* A busy workspace is checked again on action. */
    }
    return () => controller.current?.abort();
  }, []);
  useEffect(() => {
    onLockChange(busy || pending !== null);
  }, [busy, pending, onLockChange]);
  function message(cause: unknown, request: AbortController) {
    setError(
      request.signal.aborted
        ? 'アーカイブの処理を中止しました。現在の作品は保持しています。'
        : cause instanceof Error &&
            !['QuotaExceededError', 'ZodError', 'SyntaxError'].includes(cause.name) &&
            cause.message.length < 250
          ? cause.message
          : 'アーカイブを処理できませんでした。形式・版・ブラウザの保存容量を確認してください。現在の作品は保持しています。',
    );
  }
  async function perform(action: (request: AbortController) => Promise<void>) {
    if (disabled || controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      ensureIdle();
      await action(request);
    } catch (cause) {
      message(cause, request);
    } finally {
      if (controller.current === request) controller.current = null;
      setBusy(false);
    }
  }
  async function exportArchive() {
    await perform(async (request) => {
      const project = getter.current();
      const [{ createProjectArchive, projectArchiveLines }, { loadScriptAudio }] =
        await Promise.all([
          import('../../shared/project-archive'),
          import('../lib/script-audio-store'),
        ]);
      request.signal.throwIfAborted();
      const audio = await loadScriptAudio(project.id, projectArchiveLines(project));
      const blob = await createProjectArchive(project, audio, request.signal);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `voice-atlas-project-${project.id}.vaarchive`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(
        `作品設定と保存音声${audio.length}行を書き出しました。ブラウザ未保存・条件不一致の音声は含みません。`,
      );
    });
  }
  async function inspect(file?: File) {
    if (!file || busy || pending || disabled) return;
    await perform(async (request) => {
      const { parseProjectArchive, maxArchiveBytes } = await import('../../shared/project-archive');
      if (file.size > maxArchiveBytes)
        throw new Error('作品アーカイブは100MiB以下にしてください。');
      const archive = await parseProjectArchive(file, request.signal);
      ensureIdle();
      setPending(archive);
      setChoose(false);
    });
    if (fileRef.current) fileRef.current.value = '';
  }
  async function restore(saveCurrent: boolean) {
    if (!pending) return;
    await perform(async (request) => {
      if (readProjectLibrary(localStorage).projects.length >= maxProjectCount)
        throw new Error('作品一覧は20作品までです。不要な作品を整理してから復元してください。');
      const before = signature();
      const current = saveCurrent ? getter.current() : undefined;
      const { restoreProjectArchive } = await import('../lib/project-archive');
      await restoreProjectArchive(
        pending,
        (project) => {
          // Editing/another generation during staging must never be lost on publication.
          ensureIdle();
          if (signature() !== before)
            throw new Error(
              '復元の処理中に現在の編集が変わりました。編集を保持したまま復元を中止しました。再確認してください。',
            );
          transition({ type: 'open', project }, current);
        },
        request.signal,
      );
    });
  }
  function confirm() {
    try {
      ensureIdle();
      const current = getter.current(),
        stored = readWorkspaceProject(localStorage);
      const changed = stored
        ? current.name !== stored.name ||
          JSON.stringify(current.documents) !== JSON.stringify(stored.documents)
        : baseline.current === null || signature() !== baseline.current;
      if (changed) setChoose(true);
      else void restore(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '現在の作品を確認してください。');
    }
  }
  function cancel() {
    setPending(null);
    setChoose(false);
    setError('');
  }
  return (
    <section aria-label="音声付き作品アーカイブ" className="project-archive">
      <h3>音声も一緒に持ち運ぶ</h3>
      <p>
        作品設定と、この作品の台本・保存台本に条件が一致するブラウザ保存済みの音声を、一つのファイルにまとめます。音声を含めるには、先に作品と台本音声をブラウザに保存してください。画像・APIキー・未保存の試聴音声・結合WAVは含みません。
      </p>
      <p>
        読み込み時は内容を確認し、新しい作品として追加します。音声は1行20MiB・合計64MiB、アーカイブ全体は100MiBまでです。このブラウザの全作品で保存音声128MiB・1000行の上限も適用します。
      </p>
      <div className="casting-actions">
        <button
          className="secondary-button"
          disabled={disabled || busy || !!pending}
          onClick={() => void exportArchive()}
        >
          音声付き作品アーカイブを書き出す
        </button>
        <button
          className="secondary-button"
          disabled={disabled || busy || !!pending}
          onClick={() => fileRef.current?.click()}
        >
          音声付き作品アーカイブを読み込む
        </button>
        {busy && (
          <button className="secondary-button" onClick={() => controller.current?.abort()}>
            アーカイブの処理を中止
          </button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        hidden
        accept=".vaarchive,application/octet-stream"
        aria-label="作品アーカイブファイル"
        disabled={disabled || busy || !!pending}
        onChange={(e) => void inspect(e.target.files?.[0])}
      />
      {busy && <p role="status">作品アーカイブを処理しています。</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {pending && (
        <div role="group" aria-label="音声付き作品の復元確認" className="project-confirmation">
          <p>
            「{pending.project.name}」を新しい作品として追加します。
            {projectSummary(pending.project)}
          </p>
          <p>
            保存音声{pending.audio.length}行・
            {(pending.audio.reduce((n, item) => n + item.blob.size, 0) / 1024 ** 2).toFixed(2)}
            MiB。音声のない行は、復元後に生成してください。
          </p>
          <button className="secondary-button" disabled={disabled || busy} onClick={confirm}>
            確認した音声付き作品を復元
          </button>
          {choose && (
            <div role="group" aria-label="アーカイブ復元前の未保存変更">
              <p>現在の作品に未保存の変更があります。</p>
              <button
                className="secondary-button"
                disabled={disabled || busy}
                onClick={() => void restore(true)}
              >
                保存して音声付き作品へ切り替える
              </button>
              <button
                className="secondary-button"
                disabled={disabled || busy}
                onClick={() => void restore(false)}
              >
                未保存の変更を破棄して音声付き作品へ切り替える
              </button>
            </div>
          )}
          <button className="secondary-button" disabled={busy} onClick={cancel}>
            音声付き作品の復元をキャンセル
          </button>
        </div>
      )}
    </section>
  );
}
