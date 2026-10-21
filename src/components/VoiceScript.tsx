import { useEffect, useRef, useState } from 'react';
import { type CastingAssignment } from '../../shared/casting-board';
import {
  emptyScript,
  makeScriptLine,
  maxScriptBytes,
  parseScript,
  scriptAudioKey,
  scriptCandidate,
  scriptStorageKey,
  serializeScript,
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

type Preview = { key: string; url: string; blob: Blob; audition: LibraryAudition };
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
      const raw = localStorage.getItem(scriptStorageKey);
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
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const previewRef = useRef(previews);
  const controller = useRef<AbortController | null>(null);
  const running = useRef(false),
    importing = useRef(false);
  const audioRefs = useRef(new Map<string, HTMLAudioElement>());
  const queue = useRef<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const locked = disabled || busy || loading || exporting;
  function stop() {
    queue.current = [];
    setPlayingId(null);
    audioRefs.current.forEach((audio) => audio.pause());
  }
  useEffect(() => {
    if (!active || !opened) {
      controller.current?.abort();
      stop();
    }
  }, [active, opened]);
  useEffect(
    () => () => {
      controller.current?.abort();
      audioRefs.current.forEach((audio) => audio.pause());
      Object.values(previewRef.current).forEach((p) => URL.revokeObjectURL(p.url));
    },
    [],
  );
  function clear(ids = Object.keys(previewRef.current)) {
    stop();
    const next = { ...previewRef.current };
    for (const id of ids) {
      if (next[id]) URL.revokeObjectURL(next[id].url);
      delete next[id];
    }
    previewRef.current = next;
    setPreviews(next);
  }
  function editLine(id: string, update: Partial<ScriptLine>) {
    clear([id]);
    setScript((value) => ({
      ...value,
      lines: value.lines.map((line) => (line.id === id ? { ...line, ...update } : line)),
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
  async function generate(forceId?: string) {
    if (locked || running.current || importing.current || !active || !opened || checking) return;
    const targets = script.lines.filter((line) => (forceId ? line.id === forceId : !audio(line)));
    if (
      !targets.length ||
      targets.some((line) => !line.text.trim() || availability(line) !== '試聴可能')
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
            text: line.text,
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
        const old = previewRef.current[line.id];
        if (old) URL.revokeObjectURL(old.url);
        const next = {
          ...previewRef.current,
          [line.id]: {
            key: scriptAudioKey(line),
            url: URL.createObjectURL(blob),
            blob,
            audition: { generation, ...(model ? { modelInfo: structuredClone(model) } : {}) },
          },
        };
        previewRef.current = next;
        setPreviews(next);
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
      localStorage.setItem(scriptStorageKey, serializeScript(saved));
      clear();
      setScript(saved);
      setNotice('台本を復元しました。音声は再生成してください。キャスティング表は変更しません。');
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
                localStorage.setItem(scriptStorageKey, serializeScript(script));
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
              checking ||
              !missing.length ||
              missing.some((line) => !line.text.trim() || availability(line) !== '試聴可能')
            }
            onClick={() => void generate()}
          >
            未生成の行を台本順に生成
          </button>
          {busy && <button onClick={() => controller.current?.abort()}>台本の生成を中止</button>}
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
                <div className="casting-actions">
                  <button
                    className="secondary-button"
                    disabled={
                      locked || checking || !line.text.trim() || availability(line) !== '試聴可能'
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
