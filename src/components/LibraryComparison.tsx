import { readWorkspaceDocument, writeWorkspaceDocument } from '../../shared/project';
import { useEffect, useRef, useState } from 'react';
import { useProjectPart } from '../lib/project-context';
import { libraryCandidate, libraryText, type VoiceLibraryEntry } from '../../shared/voice-library';
import {
  castingCandidateSchema,
  castingKey,
  castingRecipeFields,
  generationSchema,
  type CastingCandidate,
  type CastingInventory,
} from '../../shared/casting';
import {
  libraryComparisonPairSchema,
  libraryComparisonStorageKey,
  libraryRecipeDifferences,
  formatLibraryComparisonValue,
  makeLibraryComparisonRecord,
  maxLibraryComparisonBytes,
  parseLibraryComparison,
  serializeLibraryComparison,
  type LibraryAudition,
  type LibraryComparisonSession,
} from '../../shared/library-comparison';
import { type AivisModelInfo } from '../../shared/aivis-model-info';
import { download } from '../lib/http';
import { pauseOtherAudio } from './ComparisonPanel';
import { AivisModelDetails } from './AivisModelDetails';
import { CastingBoard } from './CastingBoard';

type Preview = { key: string; url: string; audition: LibraryAudition };
const emptySession = (): LibraryComparisonSession => ({
  format: 'voice-atlas-library-comparison',
  version: 1,
  createdAt: new Date().toISOString(),
  entries: null,
  text: '',
  scene: '',
  reason: '',
  selectedId: null,
  records: [],
});
const entryLabel = (entry: VoiceLibraryEntry) =>
  `${entry.characterName} / ${entry.settingName}（${libraryCandidate(entry).voice.engine}）`;

export function LibraryComparison({
  entries,
  disabled,
  active,
  inventory,
  checking,
  currentModel,
  onBusyChange,
  onLoad,
}: {
  entries: VoiceLibraryEntry[];
  disabled: boolean;
  active: boolean;
  inventory: CastingInventory | null;
  checking: boolean;
  currentModel: (candidate: CastingCandidate) => AivisModelInfo | undefined;
  onBusyChange: (busy: boolean) => void;
  onLoad: (entry: VoiceLibraryEntry, slot: 0 | 1) => void;
}) {
  const [initial] = useState(() => {
    try {
      const raw = readWorkspaceDocument(libraryComparisonStorageKey);
      return { session: raw ? parseLibraryComparison(raw) : emptySession(), error: '' };
    } catch {
      return {
        session: emptySession(),
        error:
          '保存済みの設定比較を読み込めませんでした。保存データは上書きしていません。設定比較JSONから復元できます。',
      };
    }
  });
  const [pair, setPair] = useState(initial.session.entries);
  const sessionTimestamp = useRef(initial.session.createdAt);
  const [ids, setIds] = useState<[string, string]>(
    (initial.session.entries?.map((e) => e.id) as [string, string]) ?? ['', ''],
  );
  const [text, setText] = useState(initial.session.text);
  const [scene, setScene] = useState(initial.session.scene);
  const [reason, setReason] = useState(initial.session.reason);
  const [selected, setSelected] = useState(initial.session.selectedId);
  const [records, setRecords] = useState(initial.session.records);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const previewRef = useRef(previews);
  const controllerRef = useRef<AbortController | null>(null);
  const generating = useRef(false);
  const importing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!active) {
      controllerRef.current?.abort();
      sectionRef.current?.querySelectorAll('audio').forEach((audio) => audio.pause());
    }
  }, [active]);
  useEffect(
    () => () => {
      controllerRef.current?.abort();
      Object.values(previewRef.current).forEach((p) => URL.revokeObjectURL(p.url));
    },
    [],
  );
  function clearAudio() {
    Object.values(previewRef.current).forEach((p) => URL.revokeObjectURL(p.url));
    previewRef.current = {};
    setPreviews({});
  }
  const locked = disabled || busy || loading;
  const options = [
    ...entries,
    ...(pair ?? []).filter((snapshot) => !entries.some((entry) => entry.id === snapshot.id)),
  ];
  function key(entry: VoiceLibraryEntry) {
    const candidate = libraryCandidate(entry);
    return JSON.stringify([entry.id, text, candidate.voice, candidate.recipe]);
  }
  function audio(entry: VoiceLibraryEntry) {
    const value = previews[entry.id];
    return value?.key === key(entry) ? value : null;
  }
  function availability(entry: VoiceLibraryEntry) {
    const candidate = libraryCandidate(entry);
    if (!castingCandidateSchema.safeParse(candidate).success) return '現行カタログ対象外';
    if (checking) return '確認中';
    if (inventory?.voices.some((voice) => castingKey(voice) === castingKey(candidate.voice)))
      return '試聴可能';
    return inventory?.engines.find((engine) => engine.engine === candidate.voice.engine)?.ready
      ? '未導入'
      : '未接続';
  }
  function act(action: () => void) {
    setError('');
    setNotice('');
    try {
      action();
    } catch {
      setError(
        '設定比較を保存・復元できませんでした。形式・登録内容・件数・ブラウザの保存容量を確認してください。現在の記録は保持しています。',
      );
    }
  }
  function session(nextRecords = records): LibraryComparisonSession {
    return {
      format: 'voice-atlas-library-comparison',
      version: 1,
      createdAt: sessionTimestamp.current,
      entries: pair,
      text,
      scene,
      reason,
      selectedId: selected,
      records: nextRecords,
    };
  }
  useProjectPart('libraryComparison', () => session(), locked);
  function start() {
    act(() => {
      const chosen = ids.map((id) => options.find((entry) => entry.id === id));
      const snapshots = libraryComparisonPairSchema.parse(chosen);
      clearAudio();
      setPair(snapshots);
      setSelected(null);
      setReason('');
      if (!text.trim()) setText(libraryText(snapshots[0]));
      setNotice('2件の保存済み設定を比較欄に読み込みました。元の登録は変更しません。');
    });
  }
  async function generate(forceId?: string) {
    if (
      !active ||
      !pair ||
      generating.current ||
      importing.current ||
      disabled ||
      checking ||
      !text.trim()
    )
      return;
    const targets = forceId ? pair.filter((e) => e.id === forceId) : pair;
    if (!targets.length || targets.some((e) => availability(e) !== '試聴可能')) return;
    generating.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      for (const entry of targets) {
        if (controller.signal.aborted) break;
        const cacheKey = key(entry);
        if (!forceId && previewRef.current[entry.id]?.key === cacheKey) continue;
        const candidate = castingCandidateSchema.parse(libraryCandidate(entry));
        const model = currentModel(candidate);
        const response = await fetch('/api/casting/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidate: { voice: candidate.voice, recipe: candidate.recipe },
            text,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.json();
          throw new Error(body.error || '音声を生成できませんでした。');
        }
        const blob = await response.blob();
        if (controller.signal.aborted) break;
        let generation: LibraryAudition['generation'] = null;
        try {
          const parsed = generationSchema.safeParse(
            JSON.parse(
              decodeURIComponent(response.headers.get('X-Voice-Atlas-Generation') || 'null'),
            ),
          );
          if (parsed.success && parsed.data.engine === candidate.voice.engine)
            generation = parsed.data;
        } catch {
          /* Optional provenance. */
        }
        const old = previewRef.current[entry.id];
        if (old) URL.revokeObjectURL(old.url);
        const next = {
          ...previewRef.current,
          [entry.id]: {
            key: cacheKey,
            url: URL.createObjectURL(blob),
            audition: { generation, ...(model ? { modelInfo: structuredClone(model) } : {}) },
          },
        };
        previewRef.current = next;
        setPreviews(next);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : '音声を生成できませんでした。');
    } finally {
      generating.current = false;
      setBusy(false);
      onBusyChange(false);
      controllerRef.current = null;
    }
  }
  function record() {
    if (
      !pair ||
      !pair.every((entry) => audio(entry)) ||
      !selected ||
      !reason.trim() ||
      records.length >= 100 ||
      locked
    )
      return;
    act(() => {
      const item = makeLibraryComparisonRecord({
        entries: pair,
        text,
        scene,
        reason,
        selectedId: selected,
        auditions: [audio(pair[0])!.audition, audio(pair[1])!.audition],
      });
      const next = [...records, item];
      writeWorkspaceDocument(
        libraryComparisonStorageKey,
        serializeLibraryComparison(session(next)),
      );
      setRecords(next);
      setPage(0);
      setReason('');
      setNotice(
        '使用する設定と理由を記録し、ブラウザ内に保存しました。設定比較JSONでバックアップできます。',
      );
    });
  }
  function restoreSession(saved: LibraryComparisonSession) {
    sessionTimestamp.current = saved.createdAt;
    clearAudio();
    setPair(saved.entries);
    setIds((saved.entries?.map((e) => e.id) as [string, string]) ?? ['', '']);
    setText(saved.text);
    setScene(saved.scene);
    setReason(saved.reason);
    setSelected(saved.selectedId);
    setRecords(saved.records);
    setPage(0);
  }
  async function restore(file?: File) {
    if (!file || generating.current || importing.current || disabled) return;
    importing.current = true;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      if (file.size > maxLibraryComparisonBytes) throw new Error('size');
      const saved = parseLibraryComparison(await file.text());
      writeWorkspaceDocument(libraryComparisonStorageKey, serializeLibraryComparison(saved));
      restoreSession(saved);
      setNotice(
        '設定比較を復元しました。音声は再生成してください。ライブラリの登録は変更しません。',
      );
    } catch {
      setError(
        '設定比較JSONの形式・容量・保存容量を確認してください。現在の比較と記録は保持しています。',
      );
    } finally {
      importing.current = false;
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  const differences = pair ? libraryRecipeDifferences(pair) : [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(records.length / 25) - 1));
  return (
    <section ref={sectionRef} className="library-comparison" aria-label="保存した設定の比較">
      <h3>保存した設定を聴き比べる</h3>
      <CastingBoard
        records={records}
        disabled={locked}
        onLoad={onLoad}
        active={active}
        inventory={inventory}
        checking={checking}
        currentModel={currentModel}
        onBusyChange={onBusyChange}
      />
      <p>
        異なる2件の登録を選びます。同じ話者・スタイルの調声違いも比較できます。読み込んだ設定はコピーとして保持し、その後の登録の編集・削除は比較に反映しません。
      </p>
      <p>選択した登録を比較欄に反映するときは「選んだ2設定で比較を開始」を押してください。</p>
      <div className="comparison-candidates">
        {([0, 1] as const).map((slot) => (
          <label key={slot}>
            比較する保存済み設定{slot === 0 ? 'A' : 'B'}
            <select
              aria-label={`設定比較の登録${slot === 0 ? 'A' : 'B'}`}
              value={ids[slot]}
              disabled={locked}
              onChange={(e) =>
                setIds(slot === 0 ? [e.target.value, ids[1]] : [ids[0], e.target.value])
              }
            >
              <option value="">登録を選択</option>
              {options.map((entry) => (
                <option key={entry.id} value={entry.id} disabled={entry.id === ids[1 - slot]}>
                  {entryLabel(entry)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <button
        className="secondary-button"
        disabled={locked || !ids[0] || !ids[1] || ids[0] === ids[1]}
        onClick={start}
      >
        選んだ2設定で比較を開始
      </button>
      <div className="casting-actions">
        <button
          className="secondary-button"
          disabled={locked}
          onClick={() =>
            act(() =>
              download(
                'voice-atlas-library-comparison.json',
                serializeLibraryComparison(session()),
              ),
            )
          }
        >
          設定比較JSONを保存
        </button>
        <button
          className="secondary-button"
          disabled={locked}
          onClick={() => fileRef.current?.click()}
        >
          設定比較JSONを読み込む
        </button>
        <input
          ref={fileRef}
          hidden
          type="file"
          accept=".json,application/json"
          aria-label="設定比較JSONファイル"
          onChange={(e) => void restore(e.target.files?.[0])}
        />
      </div>
      <p className="footnote">
        JSONの読み込みは、この設定比較と記録を置き換えます。音声は保存せず、記録は最大100件・JSONは8MiBまでです。比較の記録時にブラウザへ保存し、編集中の内容はJSONへ保存できます。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {pair && (
        <>
          <label>
            共通セリフ（300文字まで）
            <textarea
              aria-label="保存した設定の共通セリフ"
              maxLength={300}
              value={text}
              disabled={locked}
              onChange={(e) => {
                setText(e.target.value);
                setSelected(null);
                setReason('');
              }}
            />
          </label>
          <div className="comparison-candidates">
            {pair.map((entry, index) => {
              const letter = index === 0 ? 'A' : 'B',
                candidate = libraryCandidate(entry),
                preview = audio(entry);
              return (
                <section
                  key={entry.id}
                  className="comparison-candidate"
                  aria-label={`保存設定候補${letter}`}
                >
                  <h4>
                    {letter}：{entryLabel(entry)}
                  </h4>
                  <p>
                    {candidate.voice.name} / {candidate.voice.style}
                  </p>
                  <p className="availability-badge">{availability(entry)}</p>
                  <p>メモ：{entry.memo || '記入なし'}</p>
                  <details>
                    <summary>登録時の情報を見る</summary>
                    <p>採用理由：{entry.evaluation.reason || '記入なし'}</p>
                    {entry.variation && (
                      <>
                        <p>
                          派生元：{entry.variation.parent.characterName} /{' '}
                          {entry.variation.parent.settingName}
                        </p>
                        <p>変更理由：{entry.variation.reason}</p>
                      </>
                    )}
                    {candidate.voice.engine === 'AivisSpeech' && (
                      <AivisModelDetails historical saved={candidate.modelInfo} />
                    )}
                  </details>
                  <button
                    className="secondary-button"
                    disabled={locked || availability(entry) !== '試聴可能' || !text.trim()}
                    onClick={() => void generate(entry.id)}
                  >
                    保存設定{letter}の音声を{preview ? '再生成' : '生成'}
                  </button>
                  {preview && (
                    <div className="comparison-audio">
                      <audio
                        controls
                        src={preview.url}
                        aria-label={`保存設定${letter}の試聴`}
                        onPlay={pauseOtherAudio}
                      />
                      <a href={preview.url} download={`voice-atlas-library-${letter}.wav`}>
                        保存設定{letter}のWAVを保存
                      </a>
                      <p>
                        生成エンジン版：{preview.audition.generation?.engineVersion ?? '未取得'}
                      </p>
                      {candidate.voice.engine === 'AivisSpeech' && (
                        <details>
                          <summary>今回の試聴のモデル情報</summary>
                          <AivisModelDetails historical saved={preview.audition.modelInfo} />
                        </details>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          <details open>
            <summary>保存した調声値の違い</summary>
            {libraryCandidate(pair[0]).voice.engine !== libraryCandidate(pair[1]).voice.engine && (
              <p>製品によって項目の意味が異なるため、数値の差分・換算は行いません。</p>
            )}
            {differences.length ? (
              <div className="library-differences">
                {differences.map((row) => (
                  <div className="recipe-notice" key={row.key}>
                    <p>A：{row.a}</p>
                    <p>B：{row.b}</p>
                    {row.delta !== null && (
                      <p>
                        B − A：{row.delta > 0 ? '+' : ''}
                        {formatLibraryComparisonValue(row.delta)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p>調声値の違いはありません。</p>
            )}
          </details>
          <button
            className="secondary-button"
            disabled={locked || pair.some((e) => availability(e) !== '試聴可能') || !text.trim()}
            onClick={() => void generate()}
          >
            {busy ? '保存設定の音声を生成中…' : '保存設定のA・Bを生成'}
          </button>
          {busy && (
            <button className="secondary-button" onClick={() => controllerRef.current?.abort()}>
              保存設定の生成を中止
            </button>
          )}
          <fieldset disabled={locked || !pair.every((e) => audio(e)) || records.length >= 100}>
            <legend>使用する設定を決める</legend>
            {pair.map((entry, index) => (
              <label key={entry.id}>
                <input
                  type="radio"
                  name="library-comparison-choice"
                  checked={selected === entry.id}
                  onChange={() => setSelected(entry.id)}
                />
                保存設定{index === 0 ? 'A' : 'B'}を使用する：{entryLabel(entry)}
              </label>
            ))}
            <label>
              使用場面（任意・200文字まで）
              <input
                aria-label="設定比較の使用場面"
                maxLength={200}
                value={scene}
                onChange={(e) => setScene(e.target.value)}
              />
            </label>
            <label>
              選択理由（1000文字まで）
              <textarea
                aria-label="設定比較の選択理由"
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <button
              className="secondary-button"
              disabled={!selected || !reason.trim()}
              onClick={record}
            >
              使用する保存設定を記録
            </button>
          </fieldset>
        </>
      )}
      <p role="status">保存設定の比較記録：{records.length}件 / 100件</p>
      <ol className="evaluation-history">
        {[...records]
          .reverse()
          .slice(currentPage * 25, (currentPage + 1) * 25)
          .map((record) => (
            <li key={record.id}>
              <strong>
                使用する設定：{entryLabel(record.entries.find((e) => e.id === record.selectedId)!)}
              </strong>
              <p>使用場面：{record.scene || '記入なし'}</p>
              <p>理由：{record.reason}</p>
              <p>セリフ：{record.text}</p>
              <p>{new Date(record.recordedAt).toLocaleString('ja-JP')}</p>
              <details>
                <summary>記録時の2設定と生成情報</summary>
                {record.entries.map((entry, i) => (
                  <div key={entry.id}>
                    <strong>
                      {i === 0 ? 'A' : 'B'}：{entryLabel(entry)}
                    </strong>
                    <p>
                      {libraryCandidate(entry).voice.name} / {libraryCandidate(entry).voice.style}
                    </p>
                    <p>
                      調声値：
                      {castingRecipeFields(libraryCandidate(entry))
                        .map(
                          (field) =>
                            `${field.label}：${Number((libraryCandidate(entry).recipe as unknown as Record<string, number>)[field.key]).toFixed(2)}${field.unit}`,
                        )
                        .join(' ／ ')}
                    </p>
                    <p>
                      生成エンジン版：{record.auditions[i].generation?.engineVersion ?? '未取得'}
                    </p>
                    {libraryCandidate(entry).voice.engine === 'AivisSpeech' && (
                      <AivisModelDetails historical saved={record.auditions[i].modelInfo} />
                    )}
                  </div>
                ))}
              </details>
              <button
                className="secondary-button"
                disabled={locked}
                onClick={() => {
                  clearAudio();
                  setPair(structuredClone(record.entries));
                  setIds(record.entries.map((e) => e.id) as [string, string]);
                  setText(record.text);
                  setScene(record.scene);
                  setReason(record.reason);
                  setSelected(record.selectedId);
                  setError('');
                  setNotice('記録時の比較を読み込みました。音声は再生成してください。');
                }}
              >
                この記録で比較を再開
              </button>
            </li>
          ))}
      </ol>
      {records.length > 25 && (
        <div className="casting-actions">
          <button
            className="secondary-button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            保存設定の前の記録
          </button>
          <span>
            {currentPage + 1} / {Math.ceil(records.length / 25)}
          </span>
          <button
            className="secondary-button"
            disabled={(currentPage + 1) * 25 >= records.length}
            onClick={() => setPage(currentPage + 1)}
          >
            保存設定の次の記録
          </button>
        </div>
      )}
    </section>
  );
}
