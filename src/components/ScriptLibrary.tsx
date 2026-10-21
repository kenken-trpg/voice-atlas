import { useImperativeHandle, useRef, useState, type Ref } from 'react';
import { emptyScript, scriptSchema, type VoiceScript } from '../../shared/script';
import {
  duplicateScriptEntry,
  makeScriptLibraryEntry,
  maxScriptLibraryBytes,
  mergeScriptLibrary,
  parseScriptLibrary,
  scriptLibraryStorageKey,
  serializeScriptLibrary,
  type ScriptLibraryEntry,
} from '../../shared/script-library';
import { download } from '../lib/http';

type Action =
  | { type: 'open'; entry: ScriptLibraryEntry }
  | { type: 'duplicate'; entry: ScriptLibraryEntry }
  | { type: 'new' }
  | { type: 'import'; script: VoiceScript; beforeOpen: () => void };
export type ScriptLibraryHandle = {
  replace: (script: VoiceScript, beforeOpen: () => void) => void;
};
export function ScriptLibrary({
  script,
  disabled,
  onOpen,
  onPendingChange,
  ref,
}: {
  script: VoiceScript;
  disabled: boolean;
  onOpen: (script: VoiceScript) => void;
  onPendingChange: (pending: boolean) => void;
  ref: Ref<ScriptLibraryHandle>;
}) {
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(scriptLibraryStorageKey);
      return { entries: raw ? parseScriptLibrary(raw) : [], error: '' };
    } catch {
      return {
        entries: [] as ScriptLibraryEntry[],
        error:
          '保存済みの台本ライブラリを読み込めませんでした。保存データは上書きしていません。ライブラリJSONから復元してください。',
      };
    }
  });
  const [entries, setEntries] = useState(initial.entries);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [project, setProject] = useState('');
  const [scene, setScene] = useState('');
  const [baseline, setBaseline] = useState(() => JSON.stringify([script, '', '']));
  const [pending, setPending] = useState<Action | null>(null);
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const importing = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  const dirty = JSON.stringify([script, project, scene]) !== baseline;
  const locked = disabled || loading || !!pending;
  const canSave =
    !!script.title.trim() &&
    !!project.trim() &&
    !!scene.trim() &&
    (!!activeId || entries.length < 30);
  function act(action: () => void) {
    setError('');
    setNotice('');
    try {
      action();
    } catch (e) {
      setError(
        e instanceof Error &&
          e.name !== 'QuotaExceededError' &&
          e.message.length < 250 &&
          !e.message.startsWith('[')
          ? e.message
          : '台本ライブラリを保存・読み込みできませんでした。入力・形式・件数・保存容量を確認してください。現在の台本と登録は保持しています。',
      );
    }
  }
  function persist(next: ScriptLibraryEntry[]) {
    const text = serializeScriptLibrary(next);
    localStorage.setItem(scriptLibraryStorageKey, text);
    setEntries(parseScriptLibrary(text));
  }
  function currentEntry() {
    return makeScriptLibraryEntry(
      script,
      project,
      scene,
      entries.find((entry) => entry.id === activeId),
    );
  }
  function include(next: ScriptLibraryEntry[], entry: ScriptLibraryEntry) {
    return next.some((item) => item.id === entry.id)
      ? next.map((item) => (item.id === entry.id ? entry : item))
      : [...next, entry];
  }
  function opened(entry: ScriptLibraryEntry | null, value = entry?.script ?? emptyScript()) {
    const copy = scriptSchema.parse(value);
    onOpen(copy);
    setActiveId(entry?.id ?? null);
    setProject(entry?.project ?? '');
    setScene(entry?.scene ?? '');
    setBaseline(JSON.stringify([copy, entry?.project ?? '', entry?.scene ?? '']));
    setPending(null);
    onPendingChange(false);
    setDeleting(null);
    setNotice('台本を開きました。音声は再生成してください。');
  }
  function perform(action: Action, saveFirst = false) {
    let next = entries;
    if (saveFirst) next = include(next, currentEntry());
    if (action.type === 'duplicate') {
      const source = next.find((entry) => entry.id === action.entry.id) ?? action.entry;
      const copy = duplicateScriptEntry(source);
      persist([...next, copy]);
      opened(copy);
    } else if (action.type === 'open') {
      const target = next.find((entry) => entry.id === action.entry.id) ?? action.entry;
      if (saveFirst) persist(next);
      opened(target);
    } else if (action.type === 'new') {
      if (saveFirst) persist(next);
      opened(null);
    } else {
      // Save-first persists the current registration before touching the independent draft store.
      // If writing that draft fails, current edits and audio stay in the editor.
      if (saveFirst) persist(next);
      action.beforeOpen();
      opened(null, action.script);
    }
  }
  function request(action: Action, fromDraftImport = false) {
    if ((disabled && !fromDraftImport) || importing.current || pending)
      throw new Error('処理または確認が完了してから切り替えてください。');
    setError('');
    setNotice('');
    if (dirty) {
      setPending(action);
      onPendingChange(true);
    } else perform(action);
  }
  useImperativeHandle(ref, () => ({
    replace(value, beforeOpen) {
      act(() => request({ type: 'import', script: scriptSchema.parse(value), beforeOpen }, true));
    },
  }));
  async function restore(file?: File) {
    if (!file || disabled || importing.current || pending) return;
    importing.current = true;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      if (file.size > maxScriptLibraryBytes)
        throw new Error('台本ライブラリJSONは16MiB以下にしてください。');
      const next = mergeScriptLibrary(entries, parseScriptLibrary(await file.text()));
      persist(next);
      setNotice(
        `${next.length - entries.length}件の台本を追加しました。編集中の台本は変更しません。`,
      );
    } catch {
      setError(
        'ライブラリJSONの形式・16MiB/30台本の上限・登録IDの競合・保存容量を確認してください。現在の台本と登録は保持しています。',
      );
    } finally {
      importing.current = false;
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  const visible = entries.filter((entry) =>
    [entry.project, entry.scene, entry.script.title]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  return (
    <section aria-label="台本ライブラリ" className="script-library">
      <h5>作品・場面ごとの台本ライブラリ</h5>
      <p>
        30台本まで保存できます。各台本のセリフ・割り当てた声・行間を保存し、音声は含みません。保存した台本は一覧から開いてください。「台本をブラウザに保存」は、従来の作業台本の保存です。ライブラリの登録は別に保存します。
      </p>
      <p role="status">
        {activeId ? '登録済み台本を編集中' : '作業台本を編集中'} ·{' '}
        {dirty ? 'ライブラリ未保存の変更があります' : '変更なし'}
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <label>
        作品名
        <input
          aria-label="台本ライブラリの作品名"
          maxLength={100}
          value={project}
          disabled={locked}
          onChange={(e) => setProject(e.target.value)}
        />
      </label>
      <label>
        場面名
        <input
          aria-label="台本ライブラリの場面名"
          maxLength={200}
          value={scene}
          disabled={locked}
          onChange={(e) => setScene(e.target.value)}
        />
      </label>
      <div className="casting-actions">
        <button
          className="secondary-button"
          disabled={locked || !canSave}
          onClick={() =>
            act(() => {
              const entry = currentEntry();
              persist(include(entries, entry));
              setActiveId(entry.id);
              setBaseline(JSON.stringify([script, project, scene]));
              setNotice('台本をライブラリに保存しました。');
            })
          }
        >
          {activeId ? '台本ライブラリの変更を保存' : '台本ライブラリに保存'}
        </button>
        <button
          className="secondary-button"
          disabled={locked}
          onClick={() => act(() => request({ type: 'new' }))}
        >
          新しい台本を作る
        </button>
        <button
          className="secondary-button"
          disabled={locked}
          onClick={() =>
            act(() => download('voice-atlas-script-library.json', serializeScriptLibrary(entries)))
          }
        >
          台本ライブラリJSONを保存
        </button>
        <button
          className="secondary-button"
          disabled={locked}
          onClick={() => fileRef.current?.click()}
        >
          台本ライブラリJSONを読み込む
        </button>
        <input
          hidden
          type="file"
          accept=".json,application/json"
          ref={fileRef}
          aria-label="台本ライブラリJSONファイル"
          onChange={(e) => void restore(e.target.files?.[0])}
        />
      </div>
      {pending && (
        <div role="group" aria-label="台本の未保存変更の確認">
          <p>
            編集中の台本にライブラリ未保存の変更があります。保存して切り替えますか？作品名・場面名・台本名が未入力の場合は、キャンセルして入力してください。
          </p>
          <button
            disabled={disabled || loading || !canSave}
            onClick={() => act(() => perform(pending, true))}
          >
            台本を保存して切り替える
          </button>
          <button disabled={disabled || loading} onClick={() => act(() => perform(pending))}>
            台本を保存せず切り替える
          </button>
          <button
            disabled={disabled || loading}
            onClick={() => {
              setPending(null);
              onPendingChange(false);
              setError('');
            }}
          >
            台本の切り替えをキャンセル
          </button>
        </div>
      )}
      <label>
        作品・場面・台本名で検索
        <input
          aria-label="台本ライブラリを検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <p role="status">
        台本ライブラリ：{visible.length}件 / 登録{entries.length}件
      </p>
      <ol className="evaluation-history">
        {visible.map((entry) => (
          <li key={entry.id}>
            <strong>
              {entry.project} / {entry.scene} / {entry.script.title}
            </strong>
            <p>
              {entry.script.lines.length}行 · 行間{entry.script.gapMs}ms · 更新：
              {new Date(entry.updatedAt).toLocaleString('ja-JP')}
            </p>
            <div className="casting-actions">
              <button
                className="secondary-button"
                disabled={locked}
                onClick={() => act(() => request({ type: 'open', entry }))}
              >
                この台本を開く
              </button>
              <button
                className="secondary-button"
                disabled={locked || entries.length >= 30}
                onClick={() => act(() => request({ type: 'duplicate', entry }))}
              >
                この保存台本を複製
              </button>
              <button
                className="text-button"
                disabled={locked}
                onClick={() => setDeleting(entry.id)}
              >
                保存台本を削除
              </button>
            </div>
            {deleting === entry.id && (
              <div>
                <p>「{entry.script.title}」を削除しますか？編集中の台本は残します。</p>
                <button
                  disabled={locked}
                  onClick={() =>
                    act(() => {
                      persist(entries.filter((item) => item.id !== entry.id));
                      if (activeId === entry.id) {
                        setActiveId(null);
                        setBaseline(JSON.stringify([emptyScript(), '', '']));
                      }
                      setDeleting(null);
                      setNotice('保存台本を削除しました。編集中の台本は保持しています。');
                    })
                  }
                >
                  この保存台本を削除する
                </button>
                <button onClick={() => setDeleting(null)}>台本の削除を取り消す</button>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
