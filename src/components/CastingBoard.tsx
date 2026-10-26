import { readWorkspaceDocument, writeWorkspaceDocument } from '../../shared/project';
import { useProjectPart } from '../lib/project-context';
import { useRef, useState } from 'react';
import {
  assignmentEntry,
  castingBoardStorageKey,
  makeCastingAssignment,
  maxCastingBoardBytes,
  parseCastingBoard,
  serializeCastingBoard,
  type CastingAssignment,
} from '../../shared/casting-board';
import { type LibraryComparisonRecord } from '../../shared/library-comparison';
import { libraryCandidate, type VoiceLibraryEntry } from '../../shared/voice-library';
import {
  castingRecipeFields,
  type CastingCandidate,
  type CastingInventory,
} from '../../shared/casting';
import { type AivisModelInfo } from '../../shared/aivis-model-info';
import { VoiceScript } from './VoiceScript';
import { download } from '../lib/http';
import { AivisModelDetails } from './AivisModelDetails';

export function CastingBoard({
  records,
  disabled,
  onLoad,
  active,
  inventory,
  checking,
  currentModel,
  onBusyChange,
}: {
  records: LibraryComparisonRecord[];
  disabled: boolean;
  onLoad: (entry: VoiceLibraryEntry, slot: 0 | 1) => void;
  active: boolean;
  inventory: CastingInventory | null;
  checking: boolean;
  currentModel: (candidate: CastingCandidate) => AivisModelInfo | undefined;
  onBusyChange: (busy: boolean) => void;
}) {
  const [initial] = useState(() => {
    try {
      return {
        items: parseCastingBoard(
          readWorkspaceDocument(castingBoardStorageKey) ??
            '{"format":"voice-atlas-casting-board","version":1,"assignments":[]}',
        ),
        error: '',
      };
    } catch {
      return {
        items: [] as CastingAssignment[],
        error:
          '保存済みのキャスティング表を読み込めませんでした。保存データは上書きしていません。JSONから復元してください。',
      };
    }
  });
  const [items, setItems] = useState(initial.items);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  const [recordId, setRecordId] = useState('');
  const [project, setProject] = useState('');
  const [character, setCharacter] = useState('');
  const [scene, setScene] = useState('');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<CastingAssignment | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const importing = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const locked = disabled || loading;
  useProjectPart(
    'castingBoard',
    () => ({ format: 'voice-atlas-casting-board', version: 1, assignments: items }),
    locked,
  );
  function act(action: () => void) {
    setError('');
    setNotice('');
    try {
      action();
    } catch (e) {
      setError(
        e instanceof Error && e.name !== 'QuotaExceededError' && e.message.length < 250
          ? e.message
          : '保存・読み込みができませんでした。形式・件数・保存容量を確認してください。現在の表は保持しています。',
      );
    }
  }
  function persist(next: CastingAssignment[]) {
    const text = serializeCastingBoard(next);
    writeWorkspaceDocument(castingBoardStorageKey, text);
    setItems(parseCastingBoard(text));
  }
  function save(item: CastingAssignment) {
    persist([
      ...items.filter(
        (e) =>
          e.project !== item.project || e.character !== item.character || e.scene !== item.scene,
      ),
      item,
    ]);
    setPending(null);
    setNotice('確定した声をキャスティング表に保存しました。');
  }
  async function restore(file?: File) {
    if (!file || importing.current || disabled) return;
    importing.current = true;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      if (file.size > maxCastingBoardBytes) throw new Error('size');
      const incoming = parseCastingBoard(await file.text());
      const next = [...items];
      for (const item of incoming) {
        const existing = next.find(
          (e) =>
            e.id === item.id ||
            (e.project === item.project &&
              e.character === item.character &&
              e.scene === item.scene),
        );
        if (existing && JSON.stringify(existing) !== JSON.stringify(item))
          throw new Error('conflict');
        if (!existing) next.push(item);
      }
      persist(next);
      setPending(null);
      setNotice('キャスティング表を読み込みました。既存の登録は保持しています。');
    } catch {
      setError(
        'JSONの形式・8MiBの容量上限・100件の件数上限・登録の競合・保存容量を確認してください。現在の表は保持しています。',
      );
    } finally {
      importing.current = false;
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  const visible = items.filter((item) =>
    [
      item.project,
      item.character,
      item.scene,
      item.comparison.entries.find((entry) => entry.id === item.comparison.selectedId)!.settingName,
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  return (
    <section
      className="library-comparison"
      aria-label="キャスティング表"
      id="production-casting"
      tabIndex={-1}
    >
      <h3>作品・場面ごとのキャスティング表</h3>
      <p>
        設定比較の記録から、作品・キャラクター・場面ごとに使う声を100件まで確定できます。設定と比較理由をコピーして保存します。ライブラリの編集・削除後も呼び出せます。音声は保存しません。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <VoiceScript
        assignments={items}
        disabled={locked}
        active={active}
        inventory={inventory}
        checking={checking}
        currentModel={currentModel}
        onBusyChange={onBusyChange}
      />
      <fieldset disabled={locked}>
        <legend>比較で選んだ声を確定</legend>
        <label>
          元にする比較記録
          <select
            aria-label="キャスティングの比較記録"
            value={recordId}
            onChange={(e) => {
              setRecordId(e.target.value);
              setPending(null);
              const record = records.find((r) => r.id === e.target.value);
              if (record) {
                setCharacter(
                  record.entries.find((entry) => entry.id === record.selectedId)!.characterName,
                );
                setScene(record.scene);
              }
            }}
          >
            <option value="">比較記録を選択</option>
            {[...records].reverse().map((r) => {
              const entry = r.entries.find((e) => e.id === r.selectedId)!;
              return (
                <option key={r.id} value={r.id}>
                  {entry.characterName} / {entry.settingName} · {r.scene || '場面未指定'} ·{' '}
                  {new Date(r.recordedAt).toLocaleString('ja-JP')} · {r.reason.slice(0, 40)}
                </option>
              );
            })}
          </select>
        </label>
        <label>
          作品名
          <input
            aria-label="キャスティングの作品名"
            maxLength={100}
            value={project}
            onChange={(e) => {
              setProject(e.target.value);
              setPending(null);
            }}
          />
        </label>
        <label>
          キャラクター名
          <input
            aria-label="キャスティングのキャラクター名"
            maxLength={100}
            value={character}
            onChange={(e) => {
              setCharacter(e.target.value);
              setPending(null);
            }}
          />
        </label>
        <label>
          使用場面
          <input
            aria-label="キャスティングの使用場面"
            maxLength={200}
            value={scene}
            onChange={(e) => {
              setScene(e.target.value);
              setPending(null);
            }}
          />
        </label>
        <button
          className="secondary-button"
          disabled={
            !records.some((r) => r.id === recordId) ||
            !project.trim() ||
            !character.trim() ||
            !scene.trim()
          }
          onClick={() =>
            act(() => {
              const record = records.find((r) => r.id === recordId)!;
              const item = makeCastingAssignment(record, project, character, scene);
              if (
                items.some(
                  (e) =>
                    e.project === item.project &&
                    e.character === item.character &&
                    e.scene === item.scene,
                )
              )
                setPending(item);
              else save(item);
            })
          }
        >
          キャスティングを確定して保存
        </button>
        {pending && (
          <div>
            <p>
              「{pending.project} / {pending.character} / {pending.scene}
              」の確定設定を変更しますか？元の比較記録は保持します。
            </p>
            <button onClick={() => act(() => save(pending))}>この場面の確定設定を置き換える</button>
            <button onClick={() => setPending(null)}>置き換えを取り消す</button>
          </div>
        )}
      </fieldset>
      <div className="casting-actions">
        <button
          className="secondary-button"
          disabled={locked}
          onClick={() =>
            act(() => download('voice-atlas-casting-board.json', serializeCastingBoard(items)))
          }
        >
          キャスティング表JSONを保存
        </button>
        <button
          className="secondary-button"
          disabled={locked}
          onClick={() => fileRef.current?.click()}
        >
          キャスティング表JSONを読み込む
        </button>
        <input
          hidden
          type="file"
          accept=".json,application/json"
          ref={fileRef}
          aria-label="キャスティング表JSONファイル"
          onChange={(e) => void restore(e.target.files?.[0])}
        />
      </div>
      <label>
        作品・キャラクター・場面で検索
        <input
          aria-label="キャスティング表を検索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <p role="status">
        キャスティング：{visible.length}件 / 登録{items.length}件
      </p>
      <ol className="evaluation-history">
        {visible.map((item) => {
          const entry = assignmentEntry(item),
            candidate = libraryCandidate(entry);
          const index = item.comparison.entries.findIndex(
            (e) => e.id === item.comparison.selectedId,
          );
          return (
            <li key={item.id}>
              <strong>
                {item.project} / {item.character} / {item.scene}
              </strong>
              <p>
                確定設定：{entry.settingName} · {candidate.voice.engine} · {candidate.voice.name} /{' '}
                {candidate.voice.style}
              </p>
              <p>選択理由：{item.comparison.reason}</p>
              <p>セリフ：{item.comparison.text}</p>
              <details>
                <summary>確定時の設定・生成情報</summary>
                <p>
                  {castingRecipeFields(candidate)
                    .map(
                      (field) =>
                        `${field.label}：${(candidate.recipe as unknown as Record<string, number>)[field.key]}${field.unit}`,
                    )
                    .join(' ／ ')}
                </p>
                <p>
                  生成エンジン版：
                  {item.comparison.auditions[index].generation?.engineVersion ?? '未取得'}
                </p>
                <p>確定：{new Date(item.assignedAt).toLocaleString('ja-JP')}</p>
                {candidate.voice.engine === 'AivisSpeech' && (
                  <AivisModelDetails historical saved={candidate.modelInfo} />
                )}
              </details>
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
                          `確定した設定を候補${slot === 0 ? 'A' : 'B'}に読み込みました。音声は再生成してください。`,
                        );
                      })
                    }
                  >
                    確定設定を候補{slot === 0 ? 'A' : 'B'}に読み込む
                  </button>
                ))}
                <button
                  className="text-button"
                  disabled={locked}
                  onClick={() => setDeleting(item.id)}
                >
                  確定設定を削除
                </button>
              </div>
              {deleting === item.id && (
                <div>
                  <p>
                    「{item.project} / {item.character} / {item.scene}」を削除しますか？
                  </p>
                  <button
                    disabled={locked}
                    onClick={() =>
                      act(() => {
                        persist(items.filter((e) => e.id !== item.id));
                        setDeleting(null);
                        setNotice('確定設定を削除しました。');
                      })
                    }
                  >
                    この確定設定を削除する
                  </button>
                  <button onClick={() => setDeleting(null)}>削除を取り消す</button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
