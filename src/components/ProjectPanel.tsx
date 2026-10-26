import { useEffect, useRef, useState } from 'react';
import {
  maxProjectBytes,
  parseProject,
  projectSummary,
  readWorkspaceProject,
  projectChangedElsewhere,
  validateProject,
  serializeProject,
  legacyDocuments,
  readProjectLibrary,
  projectLibraryStorageKey,
  type ProjectLibraryAction,
  type VoiceProject,
} from '../../shared/project';
import { useProject } from '../lib/project-context';
import { download } from '../lib/http';
import { ProjectLibrary } from './ProjectLibrary';
import { ProjectArchive } from './ProjectArchive';

export type ProductionStep = 'discovery' | 'casting' | 'script';

export function ProjectPanel({ onNavigate }: { onNavigate: (step: ProductionStep) => void }) {
  const { initial, loadError, capture, ensureIdle, commit, transition } = useProject();
  const [name, setName] = useState(initial?.name ?? '新しい作品');
  const [saved, setSaved] = useState(initial);
  const [pending, setPending] = useState<VoiceProject | null>(null);
  const [operation, setOperation] = useState<ProjectLibraryAction | null>(null);
  const [choose, setChoose] = useState(false);
  const [recoverSingle, setRecoverSingle] = useState(false);
  const baseline = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [archiveLocked, setArchiveLocked] = useState(false);
  const [libraryLocked, setLibraryLocked] = useState(false);
  const locked = loading || archiveLocked || libraryLocked;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Update both live edits and document-level saves made by nested workspaces.
  useEffect(() => {
    function check() {
      try {
        const stored = readWorkspaceProject(localStorage);
        setConflict(projectChangedElsewhere(localStorage));
        setSaved(stored);
        if (!stored) {
          const snapshot = JSON.stringify(capture());
          baseline.current ??= snapshot;
          setDirty(name !== '新しい作品' || snapshot !== baseline.current);
          return;
        }
        setDirty(
          stored.name !== name.trim() ||
            JSON.stringify(stored.documents) !== JSON.stringify(capture()),
        );
      } catch {
        /* Busy/invalid data must not be silently persisted by status checks. */
      }
    }
    check();
    const timer = setInterval(check, 1000);
    return () => clearInterval(timer);
  }, [capture, name]);
  useEffect(() => {
    if (!dirty || !saved) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', prevent);
    return () => window.removeEventListener('beforeunload', prevent);
  }, [dirty, saved]);
  function act(action: () => void) {
    if (archiveLocked) return;
    setError('');
    setNotice('');
    try {
      action();
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name !== 'QuotaExceededError' && cause.message.length < 200
          ? cause.message
          : '作品を保存・復元できませんでした。形式やブラウザの保存容量を確認してください。現在の作業は保持しています。',
      );
    }
  }
  function save(exportFile: boolean) {
    act(() => {
      const now = new Date().toISOString();
      const project = validateProject({
        format: 'voice-atlas-project',
        version: 1,
        id: saved?.id ?? crypto.randomUUID(),
        name,
        createdAt: saved?.createdAt ?? now,
        updatedAt: now,
        documents: capture(),
      });
      // File backup remains possible when browser storage is full.
      if (exportFile) {
        download(`voice-atlas-project-${project.id}.json`, serializeProject(project));
        setNotice('作品JSONを書き出しました。ブラウザ内の作品保存とは別のバックアップです。');
      } else {
        commit(project, false);
        setSaved(project);
        setDirty(false);
        setNotice('編集中の台本と比較条件を含め、作品をブラウザに保存しました。');
      }
    });
  }
  function currentSnapshot() {
    const now = new Date().toISOString();
    return validateProject({
      format: 'voice-atlas-project',
      version: 1,
      id: saved?.id ?? crypto.randomUUID(),
      name,
      createdAt: saved?.createdAt ?? now,
      updatedAt: now,
      documents: capture(),
    });
  }
  function request(action: ProjectLibraryAction, project: VoiceProject) {
    act(() => {
      ensureIdle();
      setOperation(action);
      setPending(project);
      setChoose(false);
      setRecoverSingle(false);
    });
  }
  function execute(saveCurrent = false) {
    if (!pending) return;
    act(() => {
      if (recoverSingle) commit(pending, true);
      else
        transition(
          operation ?? { type: 'open', project: pending },
          saveCurrent ? currentSnapshot() : undefined,
        );
      setPending(null);
      setChoose(false);
    });
  }
  function confirm() {
    act(() => {
      ensureIdle();
      if (recoverSingle) {
        execute();
        return;
      }
      const stored = readWorkspaceProject(localStorage);
      const changed = stored
        ? stored.name !== name.trim() ||
          JSON.stringify(stored.documents) !== JSON.stringify(capture())
        : dirty;
      if (changed && (operation?.type !== 'delete' || operation.id === stored?.id)) setChoose(true);
      else execute();
    });
  }
  async function inspect(file?: File) {
    if (!file || locked) return;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      if (file.size > maxProjectBytes) throw new Error('作品JSONは32MiB以下にしてください。');
      const project = parseProject(await file.text());
      ensureIdle();
      let existing: VoiceProject | undefined;
      setRecoverSingle(false);
      try {
        existing = readProjectLibrary(localStorage).projects.find((p) => p.id === project.id);
      } catch {
        if (localStorage.getItem(projectLibraryStorageKey) !== null)
          throw new Error('作品一覧を復旧してください。');
        setRecoverSingle(true);
      }
      if (existing && JSON.stringify(existing) !== JSON.stringify(project))
        project.id = crypto.randomUUID();
      setOperation({ type: 'open', project });
      setChoose(false);
      setPending(project);
    } catch {
      setError(
        '作品JSONを確認できませんでした。形式・容量、または進行中の処理を確認してください。現在の作業は保持しています。',
      );
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  return (
    <>
      <section className="production-guide" aria-label="制作の入口">
        <div className="production-current">
          <div>
            <span className="eyebrow">YOUR PROJECT</span>
            <h2>現在の作品：{saved?.name ?? 'まだ作品として保存していません'}</h2>
            <p role="status">
              {conflict
                ? '別のタブで変更されています。作品の保存・復元欄を確認してください。'
                : saved
                  ? dirty
                    ? '未保存の変更があります'
                    : 'ブラウザに保存済みです'
                  : '声や台本を作ったら、作品として保存して再開できます。'}
            </p>
          </div>
          <button
            className="secondary-button"
            onClick={() => {
              const panel = document.getElementById(
                'project-management',
              ) as HTMLDetailsElement | null;
              if (panel) {
                panel.open = true;
                panel.scrollIntoView({ block: 'start' });
                panel.querySelector('summary')?.focus();
              }
            }}
          >
            作品を管理・保存する
          </button>
        </div>
        <nav aria-label="制作の流れ">
          <ol className="production-steps">
            <li>
              <span className="eyebrow">STEP 01</span>
              <h3>声を探す</h3>
              <p>画像や設定から候補を探し、試聴して似合う声を選びます。</p>
              <button className="secondary-button" onClick={() => onNavigate('discovery')}>
                声探しへ進む
              </button>
            </li>
            <li>
              <span className="eyebrow">STEP 02</span>
              <h3>配役を決める</h3>
              <p>
                比較で採用した声をライブラリへ保存し、設定比較の記録からキャラクター・場面ごとの配役を確定します。
              </p>
              <button className="secondary-button" onClick={() => onNavigate('casting')}>
                配役へ進む
              </button>
            </li>
            <li>
              <span className="eyebrow">STEP 03</span>
              <h3>台本を作る</h3>
              <p>配役をセリフに割り当て、必要な行を生成・試聴してWAVにまとめます。</p>
              <button className="secondary-button" onClick={() => onNavigate('script')}>
                台本へ進む
              </button>
            </li>
          </ol>
        </nav>
        <p className="footnote">
          どの工程からでも再開できます。移動しても編集中の内容は保持されます。
        </p>
      </section>
      <details className="project-panel" id="project-management">
        <summary>
          <span>作品を保存・復元する</span>
          {saved && <small className="project-active-label">現在の作品：{saved.name}</small>}
        </summary>
        <section aria-label="作品の保存と復元">
          <h2>声・配役・台本をまとめて保存</h2>
          <ProjectLibrary
            disabled={locked || !!pending}
            onRequest={request}
            onLockChange={setLibraryLocked}
            onRename={(id, value) =>
              act(() => {
                transition({ type: 'rename', id, name: value });
                if (saved?.id === id) setName(value);
              })
            }
          />
          <p>
            現在の声探し、製品比較、採用声、設定比較、キャスティング表、編集中の台本、台本ライブラリ、読み方辞書を一つの作品にまとめます。
          </p>
          <p className="footnote">
            画像・音声・APIキー、履歴集計欄と未登録の名前・メモなどの入力欄はJSONに含みません。同じブラウザで保存した台本音声は条件が一致すれば再利用できます。作品内の保存は、従来のブラウザ保存とは別に保持します。
          </p>
          {loadError && <p role="alert">{loadError}</p>}
          {conflict && (
            <p role="alert">
              別のタブで作品が変更されています。現在の編集を作品JSONに書き出してから、作品を開き直してください。
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <label>
            作品名
            <input
              aria-label="保存する作品名"
              value={name}
              maxLength={100}
              disabled={locked || !!pending}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <p role="status">
            {saved
              ? dirty
                ? '作品に未保存の変更があります'
                : '作品はブラウザに保存済みです'
              : '作品としてのブラウザ保存はまだありません'}
          </p>
          {saved && (
            <p>
              最終保存：
              <time dateTime={saved.updatedAt}>
                {new Date(saved.updatedAt).toLocaleString('ja-JP')}
              </time>
            </p>
          )}
          <div className="casting-actions">
            <button
              className="secondary-button"
              disabled={locked || !!pending}
              onClick={() => save(false)}
            >
              作品をブラウザに保存
            </button>
            <button
              className="secondary-button"
              disabled={locked || !!pending}
              onClick={() => save(true)}
            >
              作品JSONを書き出す
            </button>
            <button
              className="secondary-button"
              disabled={locked || !!pending}
              onClick={() => fileRef.current?.click()}
            >
              作品JSONを読み込む
            </button>
            <button
              className="secondary-button"
              disabled={locked || !!pending}
              onClick={() =>
                act(() => {
                  ensureIdle();
                  const now = new Date().toISOString();
                  setPending(
                    validateProject({
                      format: 'voice-atlas-project',
                      version: 1,
                      id: crypto.randomUUID(),
                      name: '以前のブラウザ保存',
                      createdAt: now,
                      updatedAt: now,
                      documents: legacyDocuments(localStorage),
                    }),
                  );
                  setOperation(null);
                  setChoose(false);
                })
              }
            >
              以前のブラウザ保存を開く
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".json,application/json"
            aria-label="作品JSONファイル"
            onChange={(e) => void inspect(e.target.files?.[0])}
          />
          <ProjectArchive
            disabled={loading || !!pending}
            getProject={currentSnapshot}
            onLockChange={setArchiveLocked}
          />
          {pending && (
            <div role="group" aria-label="作品の復元確認" className="project-confirmation">
              <p>
                「{pending.name}」を{operation?.type === 'delete' ? '削除' : '開き'}ます。
                {projectSummary(pending)}
              </p>
              <p>
                現在の作品と編集中の内容を切り替えます。残す場合は、先にキャンセルして作品JSONを書き出してください。
              </p>
              <button
                className="secondary-button"
                onClick={() =>
                  act(() => {
                    confirm();
                  })
                }
              >
                {operation?.type === 'delete' ? '確認した作品を削除' : '確認した作品を復元'}
              </button>
              {choose && (
                <div role="group" aria-label="作品の未保存変更の確認">
                  <p>現在の作品に未保存の変更があります。</p>
                  {operation?.type !== 'delete' && (
                    <button className="secondary-button" onClick={() => execute(true)}>
                      保存して作品を切り替える
                    </button>
                  )}
                  <button className="secondary-button" onClick={() => execute(false)}>
                    {operation?.type === 'delete'
                      ? '未保存の変更を破棄して削除'
                      : '未保存の変更を破棄して切り替える'}
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setPending(null);
                      setChoose(false);
                    }}
                  >
                    作品の切り替えをキャンセル
                  </button>
                </div>
              )}
              <button
                className="secondary-button"
                onClick={() => {
                  setPending(null);
                  setChoose(false);
                }}
              >
                作品の復元をキャンセル
              </button>
            </div>
          )}
        </section>
      </details>
    </>
  );
}
