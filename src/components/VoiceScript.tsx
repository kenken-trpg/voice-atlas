import {
  readWorkspaceDocument,
  writeWorkspaceDocument,
  readWorkspaceProject,
} from '../../shared/project';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useProjectPart } from '../lib/project-context';
import { type CastingAssignment } from '../../shared/casting-board';
import {
  emptyScript,
  makeScriptLine,
  maxScriptBytes,
  parseScript,
  scriptAudioKey,
  scriptSpokenText,
  scriptCandidate,
  scriptStorageKey,
  serializeScript,
  scriptSchema,
  type ScriptLine,
} from '../../shared/script';
import {
  castingCandidateSchema,
  castingKey,
  generationSchema,
  castingRecipeFields,
  type CastingCandidate,
  type CastingInventory,
} from '../../shared/casting';
import { type AivisModelInfo } from '../../shared/aivis-model-info';
import { type LibraryAudition } from '../../shared/library-comparison';
import { download } from '../lib/http';
import { pauseOtherAudio } from './ComparisonPanel';
import { AivisModelDetails } from './AivisModelDetails';
import { ScriptAudioExport } from './ScriptAudioExport';
import { ScriptLibrary, type ScriptLibraryHandle } from './ScriptLibrary';
import { ScriptImport } from './ScriptImport';
import { PronunciationDictionary } from './PronunciationDictionary';
import { ScriptRecast } from './ScriptRecast';
import { makeRecastSnapshot, undoScriptRecast } from '../../shared/script-recast-history';
import { ScriptRecastHistory, type RecastMemory, type ScriptPreview } from './ScriptRecastHistory';

type Preview = ScriptPreview;
export function VoiceScript({
  assignments,
  disabled,
  active,
  inventory,
  checking,
  currentModel,
  onBusyChange,
}: {
  assignments: CastingAssignment[];
  disabled: boolean;
  active: boolean;
  inventory: CastingInventory | null;
  checking: boolean;
  currentModel: (candidate: CastingCandidate) => AivisModelInfo | undefined;
  onBusyChange: (busy: boolean) => void;
}) {
  const [initial] = useState(() => {
    try {
      const raw = readWorkspaceDocument(scriptStorageKey);
      return { script: raw ? parseScript(raw) : emptyScript(), error: '' };
    } catch {
      return {
        script: emptyScript(),
        error:
          '保存済みの台本を読み込めませんでした。保存データは上書きしていません。台本JSONから復元してください。',
      };
    }
  });
  const [script, setScript] = useState(initial.script);
  const [error, setError] = useState(initial.error);
  const [notice, setNotice] = useState('');
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheReady, setCacheReady] = useState(false);
  const [deleteAudio, setDeleteAudio] = useState<'project' | 'all' | null>(null);
  const cacheGeneration = useRef(0);
  const cacheRunning = useRef(false);
  const scriptRef = useRef(script);
  useLayoutEffect(() => {
    scriptRef.current = script;
  });
  const [recastIds, setRecastIds] = useState<string[]>([]);
  const libraryRef = useRef<ScriptLibraryHandle>(null);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [recastMemory, setRecastMemory] = useState<RecastMemory | null>(null);
  const memoryRef = useRef<RecastMemory | null>(null);
  const ownedUrls = useRef(new Set<string>());
  const comparisonRef = useRef<HTMLElement>(null);
  const previewRef = useRef(previews);
  const controller = useRef<AbortController | null>(null);
  const running = useRef(false),
    importing = useRef(false);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const queue = useRef<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const baseLocked = disabled || busy || loading || exporting || cacheBusy;
  const locked = baseLocked || switching;
  useProjectPart('script', () => script, locked);
  function stop() {
    queue.current = [];
    setPlayingId(null);
    audioRefs.current.forEach((audio) => audio.pause());
    comparisonRef.current?.querySelectorAll('audio').forEach((audio) => audio.pause());
  }
  useEffect(() => {
    if (!active || !opened) {
      setCacheReady(false);
      cacheGeneration.current++;
      if (cacheRunning.current) {
        cacheRunning.current = false;
        setCacheBusy(false);
        onBusyChange(false);
      }
      controller.current?.abort();
      stop();
    }
  }, [active, opened]);
  useEffect(() => {
    if (active && opened && !cacheReady) void restoreAudio(true);
  }, [active, opened, disabled, busy, loading, exporting, switching, cacheReady]);
  useEffect(
    () => () => {
      cacheGeneration.current++;
      controller.current?.abort();
      audioRefs.current.forEach((audio) => audio.pause());
      ownedUrls.current.forEach((url) => URL.revokeObjectURL(url));
      ownedUrls.current.clear();
    },
    [],
  );
  function collectUrls() {
    const retained = new Set(
      [
        ...Object.values(previewRef.current),
        ...Object.values(memoryRef.current?.beforeAudio ?? {}),
      ].map((preview) => preview.url),
    );
    for (const url of ownedUrls.current)
      if (!retained.has(url)) {
        URL.revokeObjectURL(url);
        ownedUrls.current.delete(url);
      }
  }
  function discardRecastMemory() {
    stop();
    memoryRef.current = null;
    setRecastMemory(null);
    collectUrls();
  }
  function clear(ids = Object.keys(previewRef.current)) {
    stop();
    const next = { ...previewRef.current };
    for (const id of ids) {
      delete next[id];
    }
    previewRef.current = next;
    setPreviews(next);
    collectUrls();
  }
  function editLine(id: string, update: Partial<ScriptLine>) {
    const before = script.lines.find((line) => line.id === id);
    if (!before) return;
    const after = { ...before, ...update };
    if (update.text !== undefined && before.readingSource === 'dictionary') {
      delete after.spokenText;
      delete after.readingSource;
    }
    if (after.spokenText === undefined) delete after.readingSource;
    if (scriptAudioKey(before) !== scriptAudioKey(after)) clear([id]);
    else stop();
    setScript((value) => ({
      ...value,
      lines: value.lines.map((line) => (line.id === id ? after : line)),
    }));
    setNotice('');
  }
  function audio(line: ScriptLine) {
    const preview = previews[line.id];
    return preview?.key === scriptAudioKey(line) ? preview : null;
  }
  function availability(line: ScriptLine) {
    const candidate = scriptCandidate(line);
    if (!candidate) return '声を選択してください';
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
        '台本を保存・復元できませんでした。形式・件数・保存容量を確認してください。現在の台本は保持しています。',
      );
    }
  }
  async function storedAudio(
    operation: (projectId: string, token: number) => Promise<void>,
    automatic = false,
  ) {
    if (
      disabled ||
      busy ||
      loading ||
      exporting ||
      switching ||
      running.current ||
      importing.current ||
      cacheRunning.current
    )
      return;
    let projectId: string | undefined;
    try {
      projectId = readWorkspaceProject(localStorage)?.id;
    } catch {
      /* Report below without changing saved data. */
    }
    if (!projectId) {
      setCacheReady(true);
      if (!automatic) setError('先に作品をブラウザに保存してください。');
      return;
    }
    const token = ++cacheGeneration.current;
    cacheRunning.current = true;
    if (!automatic) {
      setCacheBusy(true);
      onBusyChange(true);
    }
    setError('');
    try {
      await operation(projectId, token);
    } catch (cause) {
      if (token === cacheGeneration.current)
        setError(
          cause instanceof Error &&
            cause.name !== 'QuotaExceededError' &&
            cause.message.length < 200
            ? cause.message
            : '音声を保存・読み込みできませんでした。保存容量を確認してください。現在の音声は保持しています。',
        );
    } finally {
      if (token === cacheGeneration.current) {
        setCacheReady(true);
        cacheRunning.current = false;
        if (!automatic) {
          setCacheBusy(false);
          onBusyChange(false);
        }
      }
    }
  }
  async function restoreAudio(automatic = false) {
    await storedAudio(async (projectId, token) => {
      const { loadScriptAudio } = await import('../lib/script-audio-store');
      const snapshot = scriptRef.current;
      const saved = await loadScriptAudio(projectId, snapshot.lines);
      if (token !== cacheGeneration.current || scriptRef.current !== snapshot) return;
      const next = { ...previewRef.current };
      let count = 0;
      for (const item of saved) {
        const line = snapshot.lines.find((l) => l.id === item.lineId)!;
        if (next[line.id]?.key === item.key) continue;
        const url = URL.createObjectURL(item.blob);
        ownedUrls.current.add(url);
        next[line.id] = { key: item.key, url, blob: item.blob, audition: item.audition };
        count++;
      }
      previewRef.current = next;
      setPreviews(next);
      collectUrls();
      if (count || !automatic)
        setNotice(`条件が一致する保存音声を${count}行読み込みました。音声生成は行っていません。`);
    }, automatic);
  }
  async function saveAudio() {
    await storedAudio(async (projectId, token) => {
      const saved = readWorkspaceProject(localStorage);
      if (
        JSON.stringify(saved?.documents.script) !==
        JSON.stringify(scriptSchema.parse(scriptRef.current))
      )
        throw new Error('現在の台本を含む作品を先にブラウザに保存してください。');
      const sources = scriptRef.current.lines.flatMap((line) => {
        const preview = audio(line);
        return preview ? [{ line, blob: preview.blob, audition: preview.audition }] : [];
      });
      const { saveScriptAudio } = await import('../lib/script-audio-store');
      await saveScriptAudio(projectId, sources);
      if (token === cacheGeneration.current)
        setNotice(
          `${sources.length}行の音声をこのブラウザに保存しました。再起動後に台本を開くと、条件が一致する音声を再利用します。`,
        );
    });
  }
  async function generate(forceId?: string, onlyIds?: string[]) {
    if (
      locked ||
      !cacheReady ||
      cacheRunning.current ||
      running.current ||
      importing.current ||
      !active ||
      !opened ||
      checking
    )
      return;
    const targets = script.lines.filter((line) =>
      forceId ? line.id === forceId : (!onlyIds || onlyIds.includes(line.id)) && !audio(line),
    );
    if (
      !targets.length ||
      targets.some(
        (line) =>
          !line.text.trim() || !scriptSpokenText(line).trim() || availability(line) !== '試聴可能',
      )
    )
      return;
    stop();
    running.current = true;
    setBusy(true);
    onBusyChange(true);
    setError('');
    setNotice('');
    const request = new AbortController();
    controller.current = request;
    let completed = 0;
    try {
      for (const line of targets) {
        if (request.signal.aborted) break;
        setGeneratingId(line.id);
        const candidate = castingCandidateSchema.parse(scriptCandidate(line));
        const model = currentModel(candidate);
        const response = await fetch('/api/casting/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            candidate: { voice: candidate.voice, recipe: candidate.recipe },
            text: scriptSpokenText(line),
          }),
          signal: request.signal,
        });
        if (!response.ok) {
          const body = await response.json();
          throw new Error(body.error || '音声を生成できませんでした。');
        }
        const blob = await response.blob();
        if (request.signal.aborted) break;
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
        const url = URL.createObjectURL(blob);
        ownedUrls.current.add(url);
        const next = {
          ...previewRef.current,
          [line.id]: {
            key: scriptAudioKey(line),
            url,
            blob,
            audition: { generation, ...(model ? { modelInfo: structuredClone(model) } : {}) },
          },
        };
        previewRef.current = next;
        setPreviews(next);
        collectUrls();
        completed++;
      }
      setNotice(
        request.signal.aborted
          ? '生成を中止しました。生成済みの行は保持しています。'
          : `${completed}行の音声を生成しました。`,
      );
    } catch (e) {
      if (request.signal.aborted) setNotice('生成を中止しました。生成済みの行は保持しています。');
      else
        setError(
          `第${script.lines.findIndex((line) => line.id === targets[completed]?.id) + 1}行：${e instanceof Error ? e.message : '音声を生成できませんでした。'} 生成済みの行は保持しています。`,
        );
    } finally {
      controller.current = null;
      running.current = false;
      setBusy(false);
      setGeneratingId(null);
      onBusyChange(false);
    }
  }
  async function playNext() {
    const id = queue.current[0];
    if (!id) {
      setPlayingId(null);
      return;
    }
    const element = audioRefs.current.get(id);
    if (!element) {
      stop();
      return;
    }
    setPlayingId(id);
    element.currentTime = 0;
    try {
      await element.play();
    } catch {
      if (queue.current[0] === id) {
        stop();
        setError('連続試聴を開始できませんでした。各行の再生ボタンで試聴してください。');
      }
    }
  }
  async function restore(file?: File) {
    if (!file || locked || importing.current || running.current) return;
    importing.current = true;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      if (file.size > maxScriptBytes) throw new Error('size');
      const saved = parseScript(await file.text());
      libraryRef.current?.replace(saved, () =>
        writeWorkspaceDocument(scriptStorageKey, serializeScript(saved)),
      );
    } catch {
      setError(
        '台本JSONの形式・20行/8MiBの上限・保存容量を確認してください。現在の台本と音声は保持しています。',
      );
    } finally {
      importing.current = false;
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  const allReady = script.lines.length > 0 && script.lines.every((line) => audio(line));
  const missing = script.lines.filter((line) => !audio(line));
  const recastMissing = missing.filter((line) => recastIds.includes(line.id));
  return (
    <details
      className="voice-script"
      onToggle={(event) => {
        if (event.target === event.currentTarget) setOpened(event.currentTarget.open);
      }}
    >
      <summary>台本を作成・試聴する</summary>
      <section aria-label="台本の試聴">
        <h4>確定した声を台本で聴く</h4>
        <p>
          20行まで、各行300文字。キャスティング表から声を選び、台本の順番で生成・試聴できます。声は割り当て時の設定をコピーします。後から表を変更・削除しても台本の声は変わりません。
        </p>
        <p>
          編集中の台本は「台本をブラウザに保存」またはJSONで保存してください。保存・復元する内容は台本と声の設定です。音声は行ごとにWAVで保存できます。
        </p>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <details>
          <summary>台本音声の保存と再利用</summary>
          <section aria-label="台本音声の保存と再利用">
            <p>
              先に現在の台本を含む作品をブラウザに保存してください。音声はこのブラウザ専用で、作品JSONには含めません。1行20MiB・1作品64MiB・全作品128MiBまで保存します。
            </p>
            <div className="casting-actions">
              <button
                className="secondary-button"
                disabled={locked || !cacheReady || !script.lines.some((line) => audio(line))}
                onClick={() => void saveAudio()}
              >
                台本音声をブラウザに保存
              </button>
              <button
                className="secondary-button"
                disabled={locked || !cacheReady}
                onClick={() => void restoreAudio()}
              >
                保存した台本音声を読み込む
              </button>
              <button
                className="text-button"
                disabled={locked || !cacheReady}
                onClick={() => setDeleteAudio('project')}
              >
                この作品の保存音声を削除
              </button>
              <button
                className="text-button"
                disabled={locked || !cacheReady}
                onClick={() => setDeleteAudio('all')}
              >
                全作品の保存音声を削除
              </button>
            </div>
            {cacheBusy && <p role="status">保存音声を処理しています。</p>}
            {deleteAudio && (
              <div role="group" aria-label="保存音声の削除確認">
                <p>
                  {deleteAudio === 'all' ? '全作品' : 'この作品'}
                  の保存音声を削除します。編集中の音声・台本・声の設定は保持します。
                </p>
                <button
                  className="secondary-button"
                  disabled={locked}
                  onClick={() =>
                    void storedAudio(async (id, token) => {
                      const { deleteProjectAudio } = await import('../lib/script-audio-store');
                      await deleteProjectAudio(deleteAudio === 'all' ? null : id);
                      if (token === cacheGeneration.current) {
                        setDeleteAudio(null);
                        setNotice('保存音声を削除しました。現在の試聴音声は保持しています。');
                      }
                    })
                  }
                >
                  確認した保存音声を削除
                </button>
                <button className="text-button" onClick={() => setDeleteAudio(null)}>
                  保存音声の削除をキャンセル
                </button>
              </div>
            )}
          </section>
        </details>
        <PronunciationDictionary
          script={script}
          disabled={locked}
          onApply={(plan) => {
            if (locked) return;
            clear(plan.audioChangedIds);
            setScript(plan.script);
            setNotice(
              `${plan.changedIds.length}行の読み上げ文を反映しました。音声が変わる行だけ再生成してください。`,
            );
          }}
        />
        <ScriptLibrary
          ref={libraryRef}
          script={script}
          disabled={baseLocked}
          onPendingChange={setSwitching}
          onOpen={(value) => {
            discardRecastMemory();
            clear();
            setScript(value);
            setRecastIds([]);
            setError('');
            setNotice('');
          }}
        />
        <ScriptImport
          assignments={assignments}
          disabled={locked}
          gapMs={script.gapMs}
          inventory={inventory}
          checking={checking}
          onImport={(value) =>
            libraryRef.current?.replace(value, () =>
              writeWorkspaceDocument(scriptStorageKey, serializeScript(value)),
            )
          }
        />
        <ScriptRecast
          script={script}
          assignments={assignments}
          disabled={locked}
          inventory={inventory}
          checking={checking}
          onApply={(plan) => {
            if (locked || running.current || importing.current) return;
            const snapshot = makeRecastSnapshot(script, plan);
            const beforeAudio: Record<string, Preview> = {};
            for (const row of snapshot.rows) {
              const preview = previewRef.current[row.before.id];
              if (preview?.key === scriptAudioKey(row.before)) beforeAudio[row.before.id] = preview;
            }
            const memory = { snapshot, beforeAudio };
            memoryRef.current = memory;
            setRecastMemory(memory);
            clear(plan.audioChangedIds);
            setScript(plan.script);
            setRecastIds(plan.audioChangedIds);
            setError('');
            setNotice(
              `${plan.changedIds.length}行の設定を差し替えました。音声が変わる${plan.audioChangedIds.length}行だけ再生成できます。ライブラリへの反映は保存してください。`,
            );
          }}
        />
        <ScriptRecastHistory
          ref={comparisonRef}
          script={script}
          memory={recastMemory}
          previews={previews}
          disabled={locked}
          onPlay={(event) => {
            queue.current = [];
            setPlayingId(null);
            pauseOtherAudio(event);
          }}
          onDiscard={discardRecastMemory}
          onUndo={() =>
            act(() => {
              if (locked || running.current || importing.current || !memoryRef.current) return;
              const memory = memoryRef.current;
              const restored = undoScriptRecast(script, memory.snapshot);
              stop();
              const next = { ...previewRef.current };
              for (const row of memory.snapshot.rows) {
                delete next[row.before.id];
                const preview = memory.beforeAudio[row.before.id];
                if (preview?.key === scriptAudioKey(row.before)) next[row.before.id] = preview;
              }
              previewRef.current = next;
              setPreviews(next);
              memoryRef.current = null;
              setRecastMemory(null);
              setScript(restored);
              setRecastIds([]);
              collectUrls();
              setNotice(
                '直前の差し替えを取り消しました。保持していた元の音声を戻し、対象外の編集は保持しています。ライブラリへの反映は保存してください。',
              );
            })
          }
        />
        <label>
          台本名
          <input
            aria-label="台本名"
            maxLength={100}
            value={script.title}
            disabled={locked}
            onChange={(e) => {
              stop();
              setScript({ ...script, title: e.target.value });
            }}
          />
        </label>
        <div className="casting-actions">
          <button
            className="secondary-button"
            disabled={locked || script.lines.length >= 20}
            onClick={() => {
              stop();
              setScript({ ...script, lines: [...script.lines, makeScriptLine()] });
            }}
          >
            台本に行を追加
          </button>
          <button
            className="secondary-button"
            disabled={locked}
            onClick={() =>
              act(() => {
                writeWorkspaceDocument(scriptStorageKey, serializeScript(script));
                setNotice(
                  '台本をブラウザ内に保存しました。音声は再読み込み後に再生成してください。',
                );
              })
            }
          >
            台本をブラウザに保存
          </button>
          <button
            className="secondary-button"
            disabled={locked}
            onClick={() => act(() => download('voice-atlas-script.json', serializeScript(script)))}
          >
            台本JSONを保存
          </button>
          <button
            className="secondary-button"
            disabled={locked}
            onClick={() => fileRef.current?.click()}
          >
            台本JSONを読み込む
          </button>
          <input
            hidden
            type="file"
            ref={fileRef}
            accept=".json,application/json"
            aria-label="台本JSONファイル"
            onChange={(e) => void restore(e.target.files?.[0])}
          />
        </div>
        <p role="status">
          台本：{script.lines.length}行 / 音声生成済み
          {script.lines.filter((line) => audio(line)).length}行
        </p>
        <div className="casting-actions">
          <button
            className="secondary-button"
            disabled={
              locked ||
              !cacheReady ||
              checking ||
              !missing.length ||
              missing.some(
                (line) =>
                  !line.text.trim() ||
                  !scriptSpokenText(line).trim() ||
                  availability(line) !== '試聴可能',
              )
            }
            onClick={() => void generate()}
          >
            未生成の行を台本順に生成
          </button>
          {busy && <button onClick={() => controller.current?.abort()}>台本の生成を中止</button>}
          {recastIds.length > 0 && (
            <button
              className="secondary-button"
              disabled={
                locked ||
                !cacheReady ||
                checking ||
                !recastMissing.length ||
                recastMissing.some(
                  (line) =>
                    !line.text.trim() ||
                    !scriptSpokenText(line).trim() ||
                    availability(line) !== '試聴可能',
                )
              }
              onClick={() => void generate(undefined, recastIds)}
            >
              差し替えた行の未生成音声を生成
            </button>
          )}
          <button
            className="secondary-button"
            disabled={locked || !allReady || playingId !== null}
            onClick={() => {
              setError('');
              queue.current = script.lines.map((line) => line.id);
              void playNext();
            }}
          >
            台本順に連続試聴
          </button>
          <button className="secondary-button" disabled={playingId === null} onClick={stop}>
            台本の連続試聴を停止
          </button>
        </div>
        <label>
          結合WAVの行間（ミリ秒）
          <input
            aria-label="結合WAVの行間"
            type="number"
            min={0}
            max={5000}
            step={1}
            disabled={locked}
            value={script.gapMs}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 0 && value <= 5000)
                setScript({ ...script, gapMs: value });
            }}
          />
        </label>
        <ScriptAudioExport
          script={script}
          sources={script.lines.map(audio)}
          disabled={locked}
          active={active && opened}
          onPreparingChange={(value) => {
            setExporting(value);
            onBusyChange(value);
          }}
        />
        <ol className="evaluation-history">
          {script.lines.map((line, index) => {
            const candidate = scriptCandidate(line),
              preview = audio(line);
            const chosen = line.assignment;
            return (
              <li key={line.id} aria-label={`台本の第${index + 1}行`}>
                <strong>
                  第{index + 1}行{generatingId === line.id ? ' · 生成中' : ''}
                  {playingId === line.id ? ' · 連続試聴中' : ''}
                </strong>
                {line.character && <p>発話者：{line.character}</p>}
                <label>
                  キャラクターと場面
                  <select
                    aria-label={`第${index + 1}行の声`}
                    value={chosen ? 'snapshot' : ''}
                    disabled={locked}
                    onChange={(e) => {
                      if (e.target.value === 'snapshot') return;
                      const assignment =
                        assignments.find((item) => item.id === e.target.value) ?? null;
                      editLine(line.id, {
                        assignment: assignment ? structuredClone(assignment) : null,
                      });
                    }}
                  >
                    <option value="">声を選択</option>
                    {chosen && (
                      <option value="snapshot">
                        割り当て済み：{chosen.project} / {chosen.character} / {chosen.scene}
                      </option>
                    )}
                    {assignments.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.project} / {item.character} / {item.scene}
                      </option>
                    ))}
                  </select>
                </label>
                {candidate && (
                  <>
                    <p>
                      {candidate.voice.engine} · {candidate.voice.name} / {candidate.voice.style} ·{' '}
                      {availability(line)}
                    </p>
                    <details>
                      <summary>割り当てた声の設定</summary>
                      <p>
                        {castingRecipeFields(candidate)
                          .map(
                            (field) =>
                              `${field.label}：${(candidate.recipe as unknown as Record<string, number>)[field.key]}${field.unit}`,
                          )
                          .join(' ／ ')}
                      </p>
                      <p>選択理由：{chosen!.comparison.reason}</p>
                    </details>
                  </>
                )}
                <label>
                  セリフ
                  <textarea
                    aria-label={`第${index + 1}行のセリフ`}
                    maxLength={300}
                    disabled={locked}
                    value={line.text}
                    onChange={(e) => editLine(line.id, { text: e.target.value })}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    aria-label={`第${index + 1}行の読み上げ文を別に指定`}
                    checked={line.spokenText !== undefined}
                    disabled={locked}
                    onChange={(e) =>
                      editLine(line.id, {
                        spokenText: e.target.checked ? line.text : undefined,
                        readingSource: e.target.checked ? 'manual' : undefined,
                      })
                    }
                  />
                  読み上げ文を別に指定
                </label>
                {line.spokenText !== undefined && (
                  <label>
                    読み上げ文{line.readingSource === 'dictionary' ? '（辞書から反映）' : ''}
                    <textarea
                      aria-label={`第${index + 1}行の読み上げ文`}
                      maxLength={300}
                      disabled={locked}
                      value={line.spokenText}
                      onChange={(e) =>
                        editLine(line.id, { spokenText: e.target.value, readingSource: 'manual' })
                      }
                    />
                  </label>
                )}
                <div className="casting-actions">
                  <button
                    className="secondary-button"
                    disabled={
                      locked ||
                      !cacheReady ||
                      checking ||
                      !line.text.trim() ||
                      !scriptSpokenText(line).trim() ||
                      availability(line) !== '試聴可能'
                    }
                    onClick={() => void generate(line.id)}
                  >
                    第{index + 1}行を{preview ? '再生成' : '生成'}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={locked || index === 0}
                    onClick={() => {
                      stop();
                      const lines = [...script.lines];
                      [lines[index - 1], lines[index]] = [lines[index], lines[index - 1]];
                      setScript({ ...script, lines });
                    }}
                  >
                    第{index + 1}行を上へ
                  </button>
                  <button
                    className="secondary-button"
                    disabled={locked || index === script.lines.length - 1}
                    onClick={() => {
                      stop();
                      const lines = [...script.lines];
                      [lines[index], lines[index + 1]] = [lines[index + 1], lines[index]];
                      setScript({ ...script, lines });
                    }}
                  >
                    第{index + 1}行を下へ
                  </button>
                  <button
                    className="text-button"
                    disabled={locked}
                    onClick={() => {
                      clear([line.id]);
                      setScript({
                        ...script,
                        lines: script.lines.filter((row) => row.id !== line.id),
                      });
                    }}
                  >
                    第{index + 1}行を削除
                  </button>
                </div>
                {preview && (
                  <>
                    <audio
                      controls
                      src={preview.url}
                      aria-label={`台本の第${index + 1}行の試聴`}
                      ref={(node) => {
                        if (node) audioRefs.current.set(line.id, node);
                        else audioRefs.current.delete(line.id);
                      }}
                      onPlay={(event) => {
                        if (queue.current[0] !== line.id) {
                          queue.current = [];
                          setPlayingId(null);
                        }
                        pauseOtherAudio(event);
                      }}
                      onEnded={() => {
                        if (queue.current[0] === line.id) {
                          queue.current.shift();
                          void playNext();
                        }
                      }}
                      onPause={(event) => {
                        if (queue.current[0] === line.id && !event.currentTarget.ended) stop();
                      }}
                      onError={() => {
                        stop();
                        setError('音声を再生できませんでした。この行の再生成をお試しください。');
                      }}
                    />
                    <a
                      className="secondary-button"
                      href={preview.url}
                      download={`voice-atlas-script-${String(index + 1).padStart(2, '0')}.wav`}
                    >
                      第{index + 1}行のWAVを保存
                    </a>
                    <p>
                      今回の生成エンジン版：{preview.audition.generation?.engineVersion ?? '未取得'}
                    </p>
                    {candidate?.voice.engine === 'AivisSpeech' && (
                      <AivisModelDetails historical saved={preview.audition.modelInfo} />
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      </section>
    </details>
  );
}
