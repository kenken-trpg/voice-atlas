import { useEffect, useRef, useState } from 'react';
import { type VoiceScript } from '../../shared/script';
import { type LibraryAudition } from '../../shared/library-comparison';
import type { makeScriptAudioManifest } from '../../shared/script-audio';
import { pauseOtherAudio } from './ComparisonPanel';

type Source = { blob: Blob; url: string; audition: LibraryAudition };
type Result = {
  script: VoiceScript;
  sourceUrls: string;
  wavUrl: string;
  jsonUrl: string;
  manifest: ReturnType<typeof makeScriptAudioManifest>;
};
export function ScriptAudioExport({
  script,
  sources,
  disabled,
  active,
  onPreparingChange,
}: {
  script: VoiceScript;
  sources: (Source | null)[];
  disabled: boolean;
  active: boolean;
  onPreparingChange: (value: boolean) => void;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const resultRef = useRef<Result | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const player = useRef<HTMLAudioElement>(null);
  const sourceUrls = JSON.stringify(sources.map((source) => source?.url));
  function clear() {
    player.current?.pause();
    const current = resultRef.current;
    if (current) {
      URL.revokeObjectURL(current.wavUrl);
      URL.revokeObjectURL(current.jsonUrl);
    }
    resultRef.current = null;
    setResult(null);
  }
  useEffect(() => {
    controller.current?.abort();
    clear();
    setError('');
  }, [script, sourceUrls]);
  useEffect(() => {
    if (!active) {
      controller.current?.abort();
      player.current?.pause();
    }
  }, [active]);
  useEffect(
    () => () => {
      controller.current?.abort();
      player.current?.pause();
      const current = resultRef.current;
      if (current) {
        URL.revokeObjectURL(current.wavUrl);
        URL.revokeObjectURL(current.jsonUrl);
      }
    },
    [],
  );
  async function prepare() {
    if (
      disabled ||
      controller.current ||
      !active ||
      !sources.length ||
      sources.some((source) => !source)
    )
      return;
    const selected = sources as Source[];
    const request = new AbortController();
    controller.current = request;
    setPreparing(true);
    onPreparingChange(true);
    setError('');
    player.current?.pause();
    let wavUrl: string | undefined, jsonUrl: string | undefined;
    try {
      const { prepareScriptAudio } = await import('../lib/script-audio-export');
      const { bytes, manifest } = await prepareScriptAudio(
        script,
        selected.map(({ blob, audition }) => ({ blob, audition })),
        request.signal,
      );
      request.signal.throwIfAborted();
      wavUrl = URL.createObjectURL(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }),
      );
      jsonUrl = URL.createObjectURL(
        new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }),
      );
      clear();
      const next = { script, sourceUrls, wavUrl, jsonUrl, manifest };
      resultRef.current = next;
      setResult(next);
    } catch (e) {
      if (wavUrl) URL.revokeObjectURL(wavUrl);
      if (jsonUrl) URL.revokeObjectURL(jsonUrl);
      setError(
        request.signal.aborted
          ? '結合を中止しました。行別の音声は保持しています。'
          : e instanceof Error
            ? e.message
            : '結合できませんでした。行別の音声は保持しています。',
      );
    } finally {
      controller.current = null;
      setPreparing(false);
      onPreparingChange(false);
    }
  }
  const current = result?.script === script && result.sourceUrls === sourceUrls ? result : null;
  return (
    <section aria-label="台本の結合WAV" className="script-audio-export">
      <h5>台本を1本のWAVにまとめる</h5>
      <p>
        全行の音声を48kHz・16bit・モノラルに揃え、指定した無音を行間に追加します。追加する無音は先頭・末尾には入りません。エンジンが各行に含めた無音は保持します。16bit
        PCM・1/2チャンネル・8〜48kHzに対応しています。
      </p>
      <button
        className="secondary-button"
        disabled={disabled || !sources.length || sources.some((source) => !source)}
        onClick={() => void prepare()}
      >
        台本の全行をWAVに結合
      </button>
      {preparing && <button onClick={() => controller.current?.abort()}>台本の結合を中止</button>}
      {error && <p role="alert">{error}</p>}
      {current && (
        <>
          <p role="status">
            結合済み：{current.manifest.lines.length}行 ·{' '}
            {(current.manifest.output.durationMs / 1000).toFixed(3)}秒 · 行間{script.gapMs}ms
          </p>
          <audio
            ref={player}
            controls
            src={current.wavUrl}
            aria-label="台本の結合音声の試聴"
            onPlay={pauseOtherAudio}
          />
          <div className="casting-actions">
            <a
              className="secondary-button"
              href={current.wavUrl}
              download={current.manifest.wavFileName}
            >
              台本全体のWAVを保存
            </a>
            <a
              className="secondary-button"
              href={current.jsonUrl}
              download={current.manifest.wavFileName.replace(/\.wav$/, '.json')}
            >
              結合音声の出力記録JSONを保存
            </a>
          </div>
          <p>
            出力記録には台本・各行の開始/終了時刻と設定・今回の生成情報が含まれます。台本や行順、音声、行間を変えた場合は再結合してください。出力記録JSONは台本読み込み用JSONとは異なります。
          </p>
        </>
      )}
    </section>
  );
}
