import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { listeningSentences } from '../../shared/listening-evaluation';
import {
  listeningComparisonSchema,
  listeningRunSchema,
  emptyReviews,
  timingSummary,
  type ListeningComparison as Comparison,
  type SampleReview,
} from '../../shared/listening-review';
import { readPcmWav } from '../../shared/wav';
import { castingRecipeSummary } from '../../shared/casting';
import { download } from '../lib/http';

const empty = (): Comparison => ({
  format: 'voice-atlas-listening-comparison',
  version: 1,
  reviewer: '',
  environment: '',
  characterBrief: '',
  runs: [],
});
const ms = (value: number | null) =>
  value === null ? '—' : `${Math.round(value).toLocaleString('ja-JP')} ms`;
export function ListeningComparison() {
  const [comparison, setComparison] = useState<Comparison>(empty);
  const [audio, setAudio] = useState<Record<string, string>>({});
  const urls = useRef<Record<string, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(true);
  const [replace, setReplace] = useState<Comparison | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      Object.values(urls.current).forEach(URL.revokeObjectURL);
    };
  }, []);
  function clearAudio() {
    Object.values(urls.current).forEach(URL.revokeObjectURL);
    urls.current = {};
    setAudio({});
  }
  async function importFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const added: Record<string, string> = {};
    try {
      if (files.length > 7 || files.reduce((sum, f) => sum + f.size, 0) > 64 * 1024 * 1024)
        throw new Error('1回につきJSONと最大6音声、合計64MiBまで読み込めます。');
      const jsons = files.filter((file) => file.name.endsWith('.json'));
      if (jsons.length !== 1 || jsons[0].size > 1024 * 1024)
        throw new Error('1MiB以下のJSONを1件選択してください。');
      const data: unknown = JSON.parse(await jsons[0].text());
      if (!mounted.current) return;
      if (
        typeof data === 'object' &&
        data !== null &&
        'format' in data &&
        data.format === 'voice-atlas-listening-comparison'
      ) {
        if (files.length !== 1) throw new Error('比較記録JSONは単独で読み込んでください。');
        setReplace(listeningComparisonSchema.parse(data));
        return;
      }
      const manifest = listeningRunSchema.parse(data);
      const existing = comparison.runs.find((run) => run.manifest.id === manifest.id);
      if (existing && JSON.stringify(existing.manifest) !== JSON.stringify(manifest))
        throw new Error('同じ実行IDで異なる生成記録があります。既存の記録は保持しています。');
      if (!existing && comparison.runs.length >= 4)
        throw new Error('比較は最大4件です。不要なランを外してから追加してください。');
      const wavs = files.filter((file) => file !== jsons[0]);
      if (new Set(wavs.map((file) => file.name)).size !== wavs.length)
        throw new Error('同名の音声が重複しています。');
      for (const file of wavs) {
        const sample = manifest.samples.find((sample) => sample.file === file.name);
        if (!sample || file.size !== sample.bytes)
          throw new Error('音声の名前・サイズが生成記録と一致しません。');
        const buffer = await file.arrayBuffer();
        readPcmWav(new Uint8Array(buffer));
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)),
          (byte) => byte.toString(16).padStart(2, '0'),
        ).join('');
        if (!mounted.current) throw new Error('読み込みを終了しました。');
        if (hash !== sample.sha256) throw new Error('音声のSHA-256が生成記録と一致しません。');
        added[`${manifest.id}:${sample.id}`] = URL.createObjectURL(
          new Blob([buffer], { type: 'audio/wav' }),
        );
      }
      if (!existing)
        setComparison((current) => ({
          ...current,
          runs: [...current.runs, { manifest, reviews: emptyReviews(), notes: '' }],
        }));
      for (const key of Object.keys(added))
        if (urls.current[key]) URL.revokeObjectURL(urls.current[key]);
      urls.current = { ...urls.current, ...added };
      setAudio({ ...urls.current });
      setNotice(`生成記録を確認しました。音声${wavs.length}件を読み込みました。`);
    } catch (cause) {
      Object.values(added).forEach(URL.revokeObjectURL);
      setError(
        cause instanceof Error && cause.name !== 'ZodError' && cause.name !== 'SyntaxError'
          ? cause.message
          : 'JSONの形式・版・共通文を確認してください。現在の比較とメモは保持しています。',
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function edit(
    id: string,
    sentence: (typeof listeningSentences)[number]['id'],
    patch: Partial<SampleReview>,
  ) {
    setComparison((current) => ({
      ...current,
      runs: current.runs.map((run) =>
        run.manifest.id === id
          ? {
              ...run,
              reviews: { ...run.reviews, [sentence]: { ...run.reviews[sentence], ...patch } },
            }
          : run,
      ),
    }));
  }
  const [removeId, setRemoveId] = useState<string | null>(null);
  return (
    <section aria-label="実機評価結果の比較">
      <h2>共通6文で製品・モデルを比較</h2>
      <p>
        evaluate:voice または probe:elevenlabs の出力を最大4件並べます。1ランずつ manifest.json
        と対応するWAVを一緒に選択してください。JSONだけでも待ち時間と生成条件を確認できます。
      </p>
      <p className="footnote">
        ファイルはブラウザ内で読み込みます。待ち時間は通信・照合などを含み、初回と2文目以降を分けています。機器・声・調声が異なる結果は同条件の速度比較にはなりません。
      </p>
      <fieldset disabled={busy || !!replace}>
        <legend>評価ファイルと聴取記録</legend>
        <label>
          生成記録・音声または比較記録を読み込む
          <input
            type="file"
            multiple
            accept=".json,.wav"
            aria-label="実機評価ファイル"
            onChange={(event) => void importFiles(event)}
          />
        </label>
        <p>
          メモと判断は「比較記録JSONを保存」で残してください。再読み込みや作品の切り替えで画面の内容と音声は消えます。作品JSONには含まれません。復元後は元のmanifest.jsonとWAVを選ぶと音声を再接続できます。
        </p>
        <button
          className="secondary-button"
          onClick={() =>
            download(
              'listening-comparison.json',
              JSON.stringify(listeningComparisonSchema.parse(comparison), null, 2),
            )
          }
        >
          比較記録JSONを保存
        </button>
        <label>
          評価者
          <input
            value={comparison.reviewer}
            maxLength={100}
            onChange={(e) => setComparison({ ...comparison, reviewer: e.target.value })}
          />
        </label>
        <label>
          聴取環境
          <input
            value={comparison.environment}
            maxLength={500}
            onChange={(e) => setComparison({ ...comparison, environment: e.target.value })}
          />
        </label>
        <label>
          キャラクター設定
          <textarea
            value={comparison.characterBrief}
            maxLength={2000}
            onChange={(e) => setComparison({ ...comparison, characterBrief: e.target.value })}
          />
        </label>
      </fieldset>
      {busy && <p role="status">ファイルを確認しています…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {replace && (
        <div role="group" aria-label="比較記録の復元確認">
          <p>
            {replace.runs.length}
            件の比較記録で現在のメモを置き換えます。読み込み済みの音声も外れます。必要なら先に現在の記録を保存してください。
          </p>
          <button
            className="secondary-button"
            onClick={() =>
              download('listening-comparison-backup.json', JSON.stringify(comparison, null, 2))
            }
          >
            現在の比較記録を保存
          </button>
          <button
            className="secondary-button"
            onClick={() => {
              clearAudio();
              setComparison(replace);
              setReplace(null);
              setRemoveId(null);
              setNotice('比較記録を復元しました。音声は元のファイルから再接続してください。');
            }}
          >
            比較記録を復元する
          </button>
          <button className="text-button" onClick={() => setReplace(null)}>
            復元をキャンセル
          </button>
        </div>
      )}
      {!comparison.runs.length && (
        <p>
          まず1件目の評価ランを読み込んでください。音声生成の成功と聴取による品質判断は別に記録します。
        </p>
      )}
      <div className="listening-run-grid">
        {comparison.runs.map(({ manifest: run, notes }) => {
          const timing = timingSummary(run);
          return (
            <article key={run.id} aria-label={`評価ラン ${run.id}`}>
              <h3>
                {run.candidate.voice.engine} / {run.candidate.voice.name}
              </h3>
              <p>{castingRecipeSummary(run.candidate)}</p>
              <p>
                生成状態：{run.status} ／ 成功 {run.samples.length}/6文
              </p>
              <p>
                初回：{ms(timing.first)} ／ 2文目以降の平均：{ms(timing.laterMean)}（
                {timing.laterCount}文）
              </p>
              {run.error && (
                <p>
                  失敗した文：{run.failedSentenceId} ／ {run.error}
                </p>
              )}
              <details>
                <summary>機器・生成条件・実行ID</summary>
                <p>
                  {run.id} / {run.createdAt}
                </p>
                <p>
                  {run.machine.platform} {run.machine.release} / {run.machine.arch} /{' '}
                  {run.machine.cpu} / {(run.machine.memoryBytes / 1024 ** 3).toFixed(1)} GiB
                </p>
                <p>{run.machine.note}</p>
                <pre>{JSON.stringify(run.candidate, null, 2)}</pre>
              </details>
              <label>
                ラン全体のメモ
                <textarea
                  maxLength={2000}
                  value={notes}
                  disabled={busy || !!replace}
                  onChange={(e) =>
                    setComparison({
                      ...comparison,
                      runs: comparison.runs.map((item) =>
                        item.manifest.id === run.id ? { ...item, notes: e.target.value } : item,
                      ),
                    })
                  }
                />
              </label>
              <button
                className="text-button"
                disabled={busy || !!replace}
                onClick={() => setRemoveId(run.id)}
              >
                このランを比較から外す
              </button>
            </article>
          );
        })}
      </div>
      {removeId && (
        <div role="group" aria-label="評価ランの削除確認">
          <p>このランのメモと読み込み音声を比較から外します。元のファイルは保持されます。</p>
          <button
            className="secondary-button"
            disabled={busy || !!replace}
            onClick={() => {
              setComparison({
                ...comparison,
                runs: comparison.runs.filter((run) => run.manifest.id !== removeId),
              });
              for (const key of Object.keys(urls.current))
                if (key.startsWith(`${removeId}:`)) {
                  URL.revokeObjectURL(urls.current[key]);
                  delete urls.current[key];
                }
              setAudio({ ...urls.current });
              setRemoveId(null);
            }}
          >
            ランを外す
          </button>
          <button className="text-button" onClick={() => setRemoveId(null)}>
            削除をキャンセル
          </button>
        </div>
      )}
      {comparison.runs.length > 0 &&
        listeningSentences.map((sentence) => (
          <section key={sentence.id} aria-label={sentence.purpose} className="listening-sentence">
            <h3>{sentence.purpose}</h3>
            <p>{sentence.text}</p>
            <div className="listening-run-grid">
              {comparison.runs.map((run) => {
                const sample = run.manifest.samples.find((sample) => sample.id === sentence.id);
                const review = run.reviews[sentence.id];
                const url = audio[`${run.manifest.id}:${sentence.id}`];
                return (
                  <fieldset key={run.manifest.id} disabled={busy || !!replace || !sample}>
                    <legend>
                      {run.manifest.candidate.voice.engine} / {run.manifest.candidate.voice.name}
                    </legend>
                    {sample ? (
                      <>
                        <p>
                          待ち時間：{ms(sample.elapsedMs)} ／ {(sample.bytes / 1024).toFixed(1)} KiB
                        </p>
                        {url ? (
                          <audio
                            controls
                            preload="none"
                            src={url}
                            aria-label={`${run.manifest.candidate.voice.name} ${sentence.purpose}`}
                          />
                        ) : (
                          <p>音声未読込：{sample.file}</p>
                        )}
                        <details>
                          <summary>この音声の生成情報</summary>
                          <pre>{JSON.stringify(sample.generation, null, 2)}</pre>
                          <p>SHA-256：{sample.sha256}</p>
                        </details>
                      </>
                    ) : (
                      <p>未生成</p>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={review.listened}
                        onChange={(e) =>
                          edit(run.manifest.id, sentence.id, { listened: e.target.checked })
                        }
                      />
                      聴取済み
                    </label>
                    {(
                      [
                        ['naturalness', '自然さ'],
                        ['intelligibility', '聞き取りやすさ'],
                        ['characterFit', 'キャラクターへの適合'],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <select
                          aria-label={label}
                          value={review[key] ?? ''}
                          onChange={(e) =>
                            edit(run.manifest.id, sentence.id, {
                              [key]: e.target.value ? Number(e.target.value) : null,
                            })
                          }
                        >
                          <option value="">未評価</option>
                          {[1, 2, 3, 4, 5].map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                    <label>
                      採用判断
                      <select
                        aria-label="採用判断"
                        value={review.decision}
                        onChange={(e) =>
                          edit(run.manifest.id, sentence.id, {
                            decision: e.target.value as SampleReview['decision'],
                          })
                        }
                      >
                        <option value="undecided">未判断</option>
                        <option value="adopt">採用したい</option>
                        <option value="reject">見送る</option>
                      </select>
                    </label>
                    <label>
                      読み違い・音の問題・判断理由
                      <textarea
                        maxLength={2000}
                        value={review.notes}
                        onChange={(e) =>
                          edit(run.manifest.id, sentence.id, { notes: e.target.value })
                        }
                      />
                    </label>
                  </fieldset>
                );
              })}
            </div>
          </section>
        ))}
      <p className="footnote">
        評価は1＝利用困難、3＝修正すれば利用可能、5＝そのまま採用可能が目安です。未評価は空欄のまま残せます。
      </p>
    </section>
  );
}
