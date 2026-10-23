import { useEffect, useRef, useState } from 'react';
import { castingInventorySchema, castingKey, type CastingInventory } from '../../shared/casting';
import { makeRecipe } from '../../shared/recommend';
import { neutralProfile } from '../../shared/schema';
import { voices } from '../../shared/catalog';
import { aivisRecipeSchema } from '../../shared/aivis';
import { jsonRequest } from '../lib/http';
import { pauseOtherAudio } from './ComparisonPanel';

export function ConnectionGuide({
  disabled,
  onBusyChange,
}: {
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [inventory, setInventory] = useState<CastingInventory | null>(null);
  const [checking, setChecking] = useState(false);
  const [selected, setSelected] = useState('');
  const [text, setText] = useState('こんにちは。物語の準備を始めましょう。');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ url: string; label: string; elapsedMs: number } | null>(
    null,
  );
  const previewRef = useRef(preview);
  const controller = useRef<AbortController | null>(null);
  const refreshId = useRef(0);
  const sectionRef = useRef<HTMLElement>(null);
  const initial = useRef(false);
  function clear() {
    sectionRef.current?.querySelector('audio')?.pause();
    if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
    previewRef.current = null;
    setPreview(null);
  }
  useEffect(
    () => () => {
      refreshId.current++;
      controller.current?.abort();
      if (previewRef.current) URL.revokeObjectURL(previewRef.current.url);
    },
    [],
  );
  useEffect(() => {
    if (!opened) {
      controller.current?.abort();
      sectionRef.current?.querySelector('audio')?.pause();
    }
  }, [opened]);
  async function refresh() {
    if (busy || checking || disabled) return;
    const id = ++refreshId.current;
    setChecking(true);
    setError('');
    clear();
    try {
      const result = castingInventorySchema.parse(await jsonRequest('/api/casting/voices'));
      if (id !== refreshId.current) return;
      setInventory(result);
      setSelected((key) =>
        result.voices.some((voice) => castingKey(voice) === key)
          ? key
          : result.voices[0]
            ? castingKey(result.voices[0])
            : '',
      );
    } catch {
      if (id === refreshId.current) {
        setInventory(null);
        setSelected('');
        setError('接続を確認できませんでした。アプリのサーバーを確認して、再確認してください。');
      }
    } finally {
      if (id === refreshId.current) setChecking(false);
    }
  }
  async function generate() {
    const voice = inventory?.voices.find((item) => castingKey(item) === selected);
    if (!voice || disabled || busy || checking || !text.trim()) return;
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    onBusyChange(true);
    setError('');
    clear();
    const started = performance.now();
    try {
      const catalogVoice =
        voice.engine === 'VOICEVOX' ? voices.find((item) => item.id === voice.voiceId) : null;
      const recipe = catalogVoice
        ? { ...makeRecipe(neutralProfile, catalogVoice), engine: 'VOICEVOX' as const }
        : aivisRecipeSchema.parse({ engine: 'AivisSpeech' });
      const response = await fetch('/api/casting/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate: { voice, recipe }, text }),
        signal: active.signal,
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || '音声を生成できませんでした。');
      }
      const blob = await response.blob();
      if (active.signal.aborted) return;
      const result = {
        url: URL.createObjectURL(blob),
        label: `${voice.engine} · ${voice.name} / ${voice.style}`,
        elapsedMs: Math.round(performance.now() - started),
      };
      previewRef.current = result;
      setPreview(result);
    } catch (cause) {
      if (!active.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : '音声を生成できませんでした。接続を再確認してください。',
        );
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setBusy(false);
        onBusyChange(false);
      }
    }
  }
  return (
    <details
      className="connection-guide"
      onToggle={(e) => {
        setOpened(e.currentTarget.open);
        if (e.currentTarget.open && !initial.current) {
          initial.current = true;
          void refresh();
        }
      }}
    >
      <summary>はじめての試聴・接続を確認する</summary>
      <section ref={sectionRef} aria-label="はじめての音声試聴">
        <h2>エンジンを確認して、最初の声を聴く</h2>
        <p>
          このPCでVOICEVOXかAivisSpeechを起動すると試聴できます。手動で声を探す操作と、この試聴にはAIのAPIキーは必要ありません。
        </p>
        <ol>
          <li>VOICEVOXまたはAivisSpeechを起動します。</li>
          <li>接続を確認し、利用できる声を選びます。</li>
          <li>セリフを生成し、再生ボタンで声を確かめます。</li>
        </ol>
        <button
          className="secondary-button"
          disabled={disabled || busy || checking}
          onClick={() => void refresh()}
        >
          試聴用の接続を再確認
        </button>
        {checking && <p role="status">音声エンジンと話者を確認しています。</p>}
        <ul className="connection-diagnostics">
          {(['VOICEVOX', 'AivisSpeech'] as const).map((engine) => {
            const state = inventory?.engines.find((item) => item.engine === engine);
            const count = inventory?.voices.filter((voice) => voice.engine === engine).length ?? 0;
            return (
              <li key={engine}>
                <strong>{engine}</strong>：
                {checking
                  ? '確認中'
                  : !state
                    ? '未確認'
                    : !state.ready
                      ? '未接続。アプリを起動し、接続を再確認してください。'
                      : count === 0
                        ? '接続済み・利用できる候補がありません。音声ライブラリやモデルを確認してください。'
                        : `接続済み・試聴可能な候補 ${count}件`}
              </li>
            );
          })}
        </ul>
        {inventory && (
          <p className="footnote">
            確認時刻：{new Date(inventory.checkedAt).toLocaleString('ja-JP')}
            。VOICEVOXは現在のカタログにある話者・スタイルを照合します。
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <fieldset disabled={disabled || busy || checking}>
          <legend>最初の試聴</legend>
          <label>
            試聴する声
            <select
              aria-label="はじめての試聴の声"
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                clear();
              }}
            >
              <option value="">利用できる声を選択</option>
              {inventory?.voices.map((voice) => (
                <option key={castingKey(voice)} value={castingKey(voice)}>
                  {voice.engine} · {voice.name} / {voice.style}
                </option>
              ))}
            </select>
          </label>
          <label>
            試聴するセリフ
            <textarea
              aria-label="はじめての試聴のセリフ"
              value={text}
              maxLength={300}
              onChange={(e) => {
                setText(e.target.value);
                clear();
              }}
            />
          </label>
          <button
            className="primary-button"
            disabled={!selected || !text.trim()}
            onClick={() => void generate()}
          >
            最初の試聴音声を生成
          </button>
        </fieldset>
        {busy && (
          <>
            <p role="status">音声を生成しています。</p>
            <button className="secondary-button" onClick={() => controller.current?.abort()}>
              試聴の待機を中止
            </button>
          </>
        )}
        {preview && (
          <div>
            <p role="status">
              {preview.label}の音声を生成しました。生成待ち時間{' '}
              {(preview.elapsedMs / 1000).toFixed(1)}秒
            </p>
            <audio
              controls
              aria-label="はじめての試聴音声"
              src={preview.url}
              onPlay={pauseOtherAudio}
            />
            <a href={preview.url} download="voice-atlas-first-preview.wav">
              最初の試聴WAVを保存
            </a>
          </div>
        )}
        <p className="footnote">
          この試聴では声の採用や台本への登録は行いません。聴き比べるときは「VOICEVOX・AivisSpeechを比較する」を開いてください。
        </p>
      </section>
    </details>
  );
}
