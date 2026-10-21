import { useEffect, useRef, useState, useImperativeHandle, type Ref } from 'react';
import {
  libraryStorageKey,
  libraryCandidate,
  libraryText,
  libraryGeneration,
  makeLibraryEntry,
  maxLibraryBytes,
  parseLibrary,
  serializeLibrary,
  voiceLibraryEntrySchema,
  type VoiceLibraryEntry,
} from '../../shared/voice-library';
import {
  castingKey,
  castingRecipeFields,
  type CastingEvaluation,
  type CastingInventory,
  type CastingCandidate,
} from '../../shared/casting';
import { download } from '../lib/http';
import { AivisModelDetails } from './AivisModelDetails';
import { LibraryComparison } from './LibraryComparison';
import { type AivisModelInfo } from '../../shared/aivis-model-info';
export type VoiceLibraryHandle = { add: (entry: VoiceLibraryEntry) => void };

export function VoiceLibrary({
  draft,
  disabled,
  inventory,
  checking,
  onLoad,
  ref: handleRef,
  active,
  currentModel,
  onComparingChange,
}: {
  draft: CastingEvaluation | null;
  disabled: boolean;
  inventory: CastingInventory | null;
  checking: boolean;
  onLoad: (entry: VoiceLibraryEntry, slot: 0 | 1) => void;
  ref?: Ref<VoiceLibraryHandle>;
  active: boolean;
  currentModel: (candidate: CastingCandidate) => AivisModelInfo | undefined;
  onComparingChange: (busy: boolean) => void;
}) {
  const [initial] = useState(() => {
    try {
      return {
        entries: parseLibrary(
          localStorage.getItem(libraryStorageKey) ??
            '{"format":"voice-atlas-voice-library","version":1,"entries":[]}',
        ),
        error: '',
      };
    } catch {
      return {
        entries: [] as VoiceLibraryEntry[],
        error:
          'ブラウザ内のライブラリを読み込めませんでした。保存データは上書きしていません。JSONを読み込んで復元してください。',
      };
    }
  });
  const [entries, setEntries] = useState(initial.entries);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<VoiceLibraryEntry | null>(null);
  const [name, setName] = useState('');
  const [setting, setSetting] = useState('通常');
  const [memo, setMemo] = useState('');
  const [query, setQuery] = useState('');
  const [engine, setEngine] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const importing = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  useEffect(() => {
    if (draft) {
      setEditing(null);
      setName('');
      setSetting('通常');
      setMemo('');
      if (details.current) {
        details.current.open = true;
        details.current.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [draft]);
  function persist(next: VoiceLibraryEntry[]) {
    const text = serializeLibrary(next);
    localStorage.setItem(libraryStorageKey, text);
    setEntries(parseLibrary(text));
    setError('');
  }
  useImperativeHandle(handleRef, () => ({
    add(entry) {
      if (importing.current) throw new Error('ライブラリJSONの読み込み完了後に保存してください。');
      persist([...entries, voiceLibraryEntrySchema.parse(entry)]);
      setNotice('調整した声を別設定として保存しました。元の登録は保持しています。');
    },
  }));
  function act(action: () => void) {
    setNotice('');
    setError('');
    try {
      action();
    } catch (e) {
      setError(
        e instanceof Error && e.message.length < 250
          ? e.message
          : '保存できませんでした。入力・JSONの形式や保存容量を確認してください。現在の登録は保持しています。',
      );
    }
  }
  function save() {
    act(() => {
      if (!editing && !draft) return;
      const entry = editing
        ? voiceLibraryEntrySchema.parse({
            ...editing,
            characterName: name,
            settingName: setting,
            memo,
            updatedAt: new Date().toISOString(),
          })
        : makeLibraryEntry(draft!, name, setting, memo);
      persist(
        editing ? entries.map((e) => (e.id === editing.id ? entry : e)) : [...entries, entry],
      );
      setEditing(entry);
      setNotice('採用声をブラウザ内に保存しました。JSONを書き出してバックアップできます。');
    });
  }
  async function restore(file?: File) {
    if (!file || importing.current) return;
    importing.current = true;
    setLoading(true);
    try {
      if (file.size > maxLibraryBytes) throw new Error('ライブラリJSONは4MiB以下にしてください。');
      const incoming = parseLibrary(await file.text());
      // Import is atomic and never silently replaces an existing registration.
      const next = [...entries];
      for (const entry of incoming) {
        const existing = next.find((e) => e.id === entry.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(entry))
          throw new Error('同じIDの異なる登録があります。現在の登録は変更していません。');
        if (!existing) next.push(entry);
      }
      persist(next);
      setNotice(`${next.length - entries.length}件を追加しました。既存の登録は保持しています。`);
    } catch {
      setError(
        'ライブラリJSONの形式・容量・登録IDの競合を確認してください。現在の登録は保持しています。',
      );
    } finally {
      importing.current = false;
      setLoading(false);
      if (ref.current) ref.current.value = '';
    }
  }
  const locked = disabled || loading;
  const registration = editing?.evaluation ?? draft;
  const registeringVoice = registration?.candidates[registration.outcome === 'a' ? 0 : 1].voice;
  const visible = entries.filter(
    (e) =>
      (!engine || libraryCandidate(e).voice.engine === engine) &&
      [e.characterName, e.settingName, e.memo, libraryCandidate(e).voice.name]
        .join(' ')
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  return (
    <details
      ref={details}
      className="voice-library"
      onToggle={(event) => {
        if (event.target === event.currentTarget) setLibraryOpen(event.currentTarget.open);
      }}
    >
      <summary>キャラクターの採用声ライブラリ</summary>
      <section aria-label="採用声ライブラリ">
        <p>
          キャラクター名と設定名を付けて、合計100件まで採用声を保存できます。名前・メモ・採用理由・キャラクター設定はこのブラウザに保存されます。登録の編集・削除は比較履歴に影響せず、音声は含みません。
        </p>
        <p>
          候補への読み込みは、その候補の調整と共通のセリフ・次の評価用の設定を置き換えます。もう一方の候補と過去の評価は保持します。
        </p>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {draft || editing ? (
          <fieldset disabled={locked}>
            <legend>{editing ? '登録した採用声を編集' : '採用声を登録'}</legend>
            {registeringVoice && (
              <p>
                登録する声：{registeringVoice.engine} · {registeringVoice.name} /{' '}
                {registeringVoice.style}
              </p>
            )}
            <label>
              キャラクター名
              <input
                aria-label="ライブラリのキャラクター名"
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              設定名
              <input
                aria-label="ライブラリの設定名"
                maxLength={100}
                value={setting}
                onChange={(e) => setSetting(e.target.value)}
              />
            </label>
            <label>
              メモ
              <textarea
                aria-label="ライブラリのメモ"
                maxLength={1000}
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
              />
            </label>
            <button
              className="secondary-button"
              disabled={!name.trim() || !setting.trim() || (!editing && entries.length >= 100)}
              onClick={save}
            >
              {editing ? '採用声の編集を保存' : '採用声をライブラリに保存'}
            </button>
          </fieldset>
        ) : (
          <p>
            比較履歴の「採用声を登録」から登録できます。同程度・判断できない評価は登録対象に含みません。
          </p>
        )}
        <div className="casting-actions">
          <button
            className="secondary-button"
            disabled={locked}
            onClick={() =>
              act(() => download('voice-atlas-voice-library.json', serializeLibrary(entries)))
            }
          >
            採用声ライブラリJSONを保存
          </button>
          <button
            className="secondary-button"
            disabled={locked}
            onClick={() => ref.current?.click()}
          >
            採用声ライブラリJSONを読み込む
          </button>
          <input
            ref={ref}
            type="file"
            hidden
            accept=".json,application/json"
            aria-label="採用声ライブラリJSONファイル"
            onChange={(e) => void restore(e.target.files?.[0])}
          />
        </div>
        <label>
          名前・メモで検索
          <input
            aria-label="採用声を検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label>
          製品
          <select
            aria-label="採用声の製品"
            value={engine}
            onChange={(e) => setEngine(e.target.value)}
          >
            <option value="">すべて</option>
            <option>VOICEVOX</option>
            <option>AivisSpeech</option>
          </select>
        </label>
        <p role="status">
          採用声：{visible.length}件 / 登録{entries.length}件
        </p>
        <LibraryComparison
          entries={entries}
          disabled={locked}
          active={active && libraryOpen}
          inventory={inventory}
          checking={checking}
          currentModel={currentModel}
          onBusyChange={onComparingChange}
        />
        <ol className="evaluation-history">
          {visible.map((entry) => {
            const candidate = libraryCandidate(entry);
            const status = checking
              ? '確認中'
              : inventory?.voices.some((v) => castingKey(v) === castingKey(candidate.voice))
                ? '試聴可能'
                : inventory?.engines.find((e) => e.engine === candidate.voice.engine)?.ready
                  ? '未導入'
                  : '未接続';
            return (
              <li key={entry.id}>
                <strong>
                  {entry.characterName} / {entry.settingName}
                </strong>
                <p>
                  {candidate.voice.engine} · {candidate.voice.name} / {candidate.voice.style} ·{' '}
                  {status}
                </p>
                <p>メモ：{entry.memo || '記入なし'}</p>
                <p>
                  {entry.variation ? '元の採用理由' : '選択理由'}：
                  {entry.evaluation.reason || '記入なし'}
                </p>
                {entry.variation && (
                  <>
                    <p>
                      派生元：{entry.variation.parent.characterName} /{' '}
                      {entry.variation.parent.settingName}
                    </p>
                    <p>変更理由：{entry.variation.reason}</p>
                    <details>
                      <summary>派生元の調声値を見る</summary>
                      <p>
                        {castingRecipeFields(entry.variation.parent.candidate)
                          .map(
                            (field) =>
                              `${field.label}：${Number((entry.variation!.parent.candidate.recipe as unknown as Record<string, unknown>)[field.key]).toFixed(2)}${field.unit}`,
                          )
                          .join(' ／ ')}
                      </p>
                    </details>
                  </>
                )}
                <p>セリフ：{libraryText(entry)}</p>
                <details>
                  <summary>
                    {entry.variation ? '保存時の調声値・生成情報' : '採用時の調声値・生成情報'}
                  </summary>
                  <p>
                    {castingRecipeFields(candidate)
                      .map(
                        (field) =>
                          `${field.label}：${Number((candidate.recipe as unknown as Record<string, unknown>)[field.key]).toFixed(2)}${field.unit}`,
                      )
                      .join(' ／ ')}
                  </p>
                  <p>
                    生成エンジン版：
                    {libraryGeneration(entry)?.engineVersion ?? '未取得'}
                  </p>
                  <p>
                    登録：{new Date(entry.createdAt).toLocaleString('ja-JP')} ／ 更新：
                    {new Date(entry.updatedAt).toLocaleString('ja-JP')}
                  </p>
                </details>
                {candidate.voice.engine === 'AivisSpeech' && (
                  <details>
                    <summary>
                      {entry.variation
                        ? '保存時のモデル情報・利用条件'
                        : '採用時のモデル情報・利用条件'}
                    </summary>
                    <AivisModelDetails historical saved={candidate.modelInfo} />
                  </details>
                )}
                <div className="casting-actions">
                  {([0, 1] as const).map((slot) => (
                    <button
                      key={slot}
                      className="secondary-button"
                      disabled={locked}
                      onClick={() =>
                        act(() => {
                          onLoad(entry, slot);
                          setNotice(
                            `候補${slot === 0 ? 'A' : 'B'}に読み込みました。音声は再生成してください。`,
                          );
                        })
                      }
                    >
                      候補{slot === 0 ? 'A' : 'B'}に読み込む
                    </button>
                  ))}
                  <button
                    className="secondary-button"
                    disabled={locked}
                    onClick={() => {
                      setEditing(entry);
                      setName(entry.characterName);
                      setSetting(entry.settingName);
                      setMemo(entry.memo);
                    }}
                  >
                    登録を編集
                  </button>
                  <button
                    className="text-button"
                    disabled={locked}
                    onClick={() => setDeleting(entry.id)}
                  >
                    登録を削除
                  </button>
                </div>
                {deleting === entry.id && (
                  <div>
                    <p>
                      「{entry.characterName} / {entry.settingName}」を削除しますか？
                    </p>
                    <button
                      disabled={locked}
                      onClick={() =>
                        act(() => {
                          persist(entries.filter((e) => e.id !== entry.id));
                          setDeleting(null);
                          if (editing?.id === entry.id) setEditing(null);
                          setNotice('登録を削除しました。');
                        })
                      }
                    >
                      この登録を削除する
                    </button>
                    <button onClick={() => setDeleting(null)}>削除を取り消す</button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </details>
  );
}
