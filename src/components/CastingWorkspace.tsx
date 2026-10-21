import { useEffect, useRef, useState } from 'react';
import { aivisRecipeSchema } from '../../shared/aivis';
import {
  castingKey,
  maxCastingSessionFileBytes,
  castingRecipeFields as controls,
  castingInventorySchema,
  castingSessionSchema,
  castingEvaluationSchema,
  generationSchema,
  nativeRecipeSchema,
  type CastingCandidate,
  type CastingInventory,
  type CastingEvaluation,
  type CastingVoice,
} from '../../shared/casting';
import { defaultText, type CharacterInput, type Profile } from '../../shared/schema';
import { makeRecipe } from '../../shared/recommend';
import { voices } from '../../shared/catalog';
import { download, jsonRequest } from '../lib/http';
import { pauseOtherAudio } from './ComparisonPanel';
import { CharacterContext } from './CharacterContext';
import { CastingEvaluationWorkbench } from './CastingEvaluationWorkbench';
import { resumeCastingEvaluation } from '../../shared/casting-dataset';
import {
  aivisModelInfoResponseSchema,
  modelInfoKey,
  modelInfoChanged,
  type AivisModelInfo,
  type AivisModelInfoResponse,
} from '../../shared/aivis-model-info';
import { AivisModelDetails } from './AivisModelDetails';

type AudioEntry = {
  key: string;
  url: string;
  generation: ReturnType<typeof generationSchema.parse> | null;
  modelInfo?: AivisModelInfo;
};
const outcomeLabels = {
  a: 'Aを採用',
  b: 'Bを採用',
  tie: '同程度',
  undecided: '判断できない',
} as const;
function initialCandidate(voice: CastingVoice, profile: Profile): CastingCandidate {
  return {
    voice,
    recipe:
      voice.engine === 'AivisSpeech'
        ? aivisRecipeSchema.parse({ engine: 'AivisSpeech' })
        : {
            engine: 'VOICEVOX',
            ...makeRecipe(
              profile,
              voices.find((item) => voice.voiceId === item.id)!,
            ),
          },
  };
}
function label(candidate: CastingCandidate) {
  return `${candidate.voice.engine} · ${candidate.voice.name} / ${candidate.voice.style}`;
}
export function CastingWorkspace({
  open,
  disabled,
  profile,
  characterInput,
}: {
  open: boolean;
  disabled: boolean;
  profile: Profile;
  characterInput: CharacterInput | null;
}) {
  const [inventory, setInventory] = useState<CastingInventory | null>(null);
  const [checking, setChecking] = useState(false);
  const [modelInfo, setModelInfo] = useState<AivisModelInfoResponse | null>(null);
  const [checkingModels, setCheckingModels] = useState(false);
  const modelRequestId = useRef(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [comparisonContext, setComparisonContext] = useState<{
    profile: Profile;
    characterInput: CharacterInput | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<Record<string, CastingCandidate>>({});
  const [pair, setPair] = useState<[string, string] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState(defaultText);
  const [evaluations, setEvaluations] = useState<CastingEvaluation[]>([]);
  const [outcome, setOutcome] = useState<CastingEvaluation['outcome']>('undecided');
  const [reason, setReason] = useState('');
  const [audio, setAudio] = useState<Record<string, AudioEntry>>({});
  const audioRef = useRef(audio);
  const requestRef = useRef<AbortController | null>(null);
  const refreshId = useRef(0);
  const generating = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const initialized = useRef(false);
  useEffect(() => {
    if (open && !initialized.current) {
      initialized.current = true;
      void refresh();
    }
  }, [open]);
  useEffect(() => {
    if (!open) requestRef.current?.abort();
  }, [open]);
  useEffect(
    () => () => {
      requestRef.current?.abort();
      refreshId.current++;
      modelRequestId.current++;
      Object.values(audioRef.current).forEach((entry) => URL.revokeObjectURL(entry.url));
    },
    [],
  );
  function clearAudio() {
    Object.values(audioRef.current).forEach((entry) => URL.revokeObjectURL(entry.url));
    audioRef.current = {};
    setAudio({});
  }
  async function refresh() {
    void refreshModels();
    const id = ++refreshId.current;
    setChecking(true);
    setError('');
    try {
      const result = castingInventorySchema.parse(await jsonRequest('/api/casting/voices'));
      if (id !== refreshId.current) return;
      setInventory(result);
      const ordered = [...result.voices].sort(
        (a, b) => (a.engine === 'AivisSpeech' ? 0 : 1) - (b.engine === 'AivisSpeech' ? 0 : 1),
      );
      setCandidates((previous) => {
        const next = { ...previous };
        ordered.forEach((voice) => {
          const key = castingKey(voice);
          if (!next[key] && Object.keys(next).length < 200)
            next[key] = initialCandidate(voice, profile);
        });
        return next;
      });
      const keys = [...new Set([...Object.keys(candidates), ...ordered.map(castingKey)])].slice(
        0,
        200,
      );
      setPair((previous) => previous ?? (keys.length >= 2 ? [keys[0], keys[1]] : null));
    } catch (e) {
      if (id === refreshId.current) {
        setInventory(null);
        setError(e instanceof Error ? e.message : '接続を確認できませんでした。');
      }
    } finally {
      if (id === refreshId.current) setChecking(false);
    }
  }
  async function refreshModels() {
    const id = ++modelRequestId.current;
    setCheckingModels(true);
    try {
      const result = aivisModelInfoResponseSchema.parse(
        await jsonRequest('/api/casting/aivis-models'),
      );
      if (id === modelRequestId.current) setModelInfo(result);
    } catch {
      if (id === modelRequestId.current) setModelInfo(null);
    } finally {
      if (id === modelRequestId.current) setCheckingModels(false);
    }
  }
  function currentModel(candidate: CastingCandidate) {
    if (checkingModels || candidate.voice.engine !== 'AivisSpeech') return undefined;
    const key = modelInfoKey({
      speakerUuid: candidate.voice.speakerUuid,
      styleName: candidate.voice.style,
    });
    return modelInfo?.ready
      ? modelInfo.models.find((info) => modelInfoKey(info) === key)
      : undefined;
  }
  function withModel(candidate: CastingCandidate, info?: AivisModelInfo): CastingCandidate {
    return {
      voice: candidate.voice,
      recipe: candidate.recipe,
      ...(info ? { modelInfo: info } : {}),
    };
  }
  const available = new Set(inventory?.voices.map(castingKey) ?? []);
  function audioKey(candidate: CastingCandidate) {
    return JSON.stringify([text, candidate.voice, candidate.recipe]);
  }
  function getAudio(key: string) {
    const entry = audio[key];
    return candidates[key] && entry?.key === audioKey(candidates[key]) ? entry : null;
  }
  function changeRecipe(key: string, field: string, value: number) {
    setCandidates((previous) => ({
      ...previous,
      [key]: {
        ...previous[key],
        recipe: nativeRecipeSchema.parse({ ...previous[key].recipe, [field]: value }),
      },
    }));
  }
  async function generate(forceKey?: string) {
    const ids = pair && forceKey && pair.includes(forceKey) ? [forceKey] : pair;
    if (!ids || generating.current || checking || !ids.every((key) => available.has(key))) return;
    generating.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      for (const key of ids) {
        if (controller.signal.aborted) break;
        const candidate = candidates[key],
          cacheKey = audioKey(candidate);
        if (key !== forceKey && audioRef.current[key]?.key === cacheKey) continue;
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
        let generation = null;
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
        const capturedModelInfo = currentModel(candidate);
        if (capturedModelInfo)
          setCandidates((previous) => ({
            ...previous,
            [key]: withModel(previous[key], capturedModelInfo),
          }));
        const old = audioRef.current[key];
        if (old) URL.revokeObjectURL(old.url);
        const next = {
          ...audioRef.current,
          [key]: {
            key: cacheKey,
            url: URL.createObjectURL(blob),
            generation,
            modelInfo: capturedModelInfo,
          },
        };
        audioRef.current = next;
        setAudio(next);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : '生成に失敗しました。');
    } finally {
      generating.current = false;
      setBusy(false);
      requestRef.current = null;
    }
  }
  function record() {
    if (!pair || !pair.every((key) => getAudio(key)) || evaluations.length >= 100) return;
    const item = castingEvaluationSchema.parse({
      recordedAt: new Date().toISOString(),
      text,
      candidates: pair.map((key) => withModel(candidates[key], getAudio(key)!.modelInfo)),
      generations: pair.map((key) => getAudio(key)!.generation),
      outcome,
      reason,
      profile: comparisonContext?.profile ?? profile,
      characterInput: comparisonContext ? comparisonContext.characterInput : characterInput,
    });
    setEvaluations((previous) => [...previous, item]);
    if (outcome === 'a' || outcome === 'b') setSelected(pair[outcome === 'a' ? 0 : 1]);
    setReason('');
    setNotice('製品・調声値・生成情報と理由を記録しました。比較セッションJSONで保存できます。');
  }
  function save() {
    const saved = castingSessionSchema.parse({
      format: 'voice-atlas-casting',
      version: 1,
      createdAt: new Date().toISOString(),
      text,
      candidates: Object.values(candidates).map((candidate) =>
        withModel(candidate, candidate.modelInfo ?? currentModel(candidate)),
      ),
      comparisonKeys: pair,
      selectedKey: selected,
      evaluations,
      comparisonContext: comparisonContext ?? { profile, characterInput },
    });
    download('voice-atlas-casting.json', JSON.stringify(saved, null, 2));
  }
  async function restore(file?: File) {
    if (!file || generating.current || loading) return;
    setLoading(true);
    try {
      if (file.size > maxCastingSessionFileBytes)
        throw new Error('比較セッションJSONは8MiB以下にしてください。');
      const saved = castingSessionSchema.parse(JSON.parse(await file.text()));
      refreshId.current++;
      setChecking(false);
      clearAudio();
      setCandidates(
        Object.fromEntries(saved.candidates.map((item) => [castingKey(item.voice), item])),
      );
      setPair(saved.comparisonKeys);
      setSelected(saved.selectedKey);
      setText(saved.text);
      setEvaluations(saved.evaluations);
      setComparisonContext(saved.comparisonContext ?? null);
      setReason('');
      setOutcome('undecided');
      setError('');
      setNotice(
        '比較セッションを復元しました。音声は再生成してください。未導入の候補も調整と履歴を保持します。',
      );
    } catch {
      setError(
        file.size > maxCastingSessionFileBytes
          ? '比較セッションJSONは8MiB以下にしてください。現在の作業は保持しています。'
          : '比較セッションJSONの形式・製品・設定範囲を確認してください。現在の作業は保持しています。',
      );
    } finally {
      if (fileRef.current) fileRef.current.value = '';
      setLoading(false);
    }
  }
  function resume(item: CastingEvaluation) {
    if (disabled || generating.current || loading)
      throw new Error('処理が完了してから比較を再開してください。');
    const next = resumeCastingEvaluation(candidates, item);
    refreshId.current++;
    setChecking(false);
    clearAudio();
    setCandidates(next.candidates);
    setPair(next.pair);
    setSelected(next.selected);
    setText(next.text);
    setComparisonContext(next.context);
    setOutcome('undecided');
    setReason('');
    setError('');
    setNotice(
      '採用した声と当時の比較条件を戻しました。音声は再生成してください。過去の評価は保持しています。',
    );
  }
  const locked = disabled || busy || loading;
  return (
    <section
      className="casting-workspace comparison-panel"
      aria-label="製品横断の比較"
      hidden={!open}
    >
      <h2>製品をまたいで、声を聴き比べる</h2>
      <p>
        導入済みのVOICEVOX・AivisSpeechから最大200候補を選べます。AivisSpeechの声質は未校正のため、ここでは推薦スコアを付けずに比較します。
      </p>
      <p className="footnote">
        AivisSpeechを起動してください。モデルごとの利用条件・クレジットはAivisSpeechで確認できます。
        <a href="https://aivis-project.com/" target="_blank" rel="noreferrer">
          AivisSpeech公式サイト
        </a>
      </p>
      <div className="casting-actions">
        <button
          className="secondary-button"
          disabled={locked || checking}
          onClick={() => void refresh()}
        >
          比較用の接続を再確認
        </button>
        <button
          className="secondary-button"
          disabled={locked || checkingModels}
          onClick={() => void refreshModels()}
        >
          モデル・利用条件を再確認
        </button>
        <button
          className="secondary-button"
          disabled={locked || !Object.keys(candidates).length}
          onClick={save}
        >
          比較セッションJSONを保存
        </button>
        <button
          className="secondary-button"
          disabled={locked}
          onClick={() => fileRef.current?.click()}
        >
          比較セッションJSONを読み込む
        </button>
        <input
          ref={fileRef}
          hidden
          type="file"
          accept=".json,application/json"
          aria-label="比較セッションJSONファイル"
          onChange={(event) => void restore(event.target.files?.[0])}
        />
      </div>
      <p role="status">
        {checking
          ? '接続を確認中…'
          : inventory
            ? inventory.engines.map((item) => `${item.engine}：${item.detail}`).join(' ／ ')
            : '接続未確認'}
        {inventory && !checking
          ? `（確認：${new Date(inventory.checkedAt).toLocaleTimeString('ja-JP')}）`
          : ''}
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {selected && candidates[selected] && <p>保存対象の声：{label(candidates[selected])}</p>}
      {!pair && (
        <p>
          比較には異なる2つの話者・スタイルが必要です。エンジンと音声モデルの起動・導入を確認してください。
        </p>
      )}
      {pair && (
        <>
          <label htmlFor="casting-text">製品横断で比較するセリフ（300文字まで）</label>
          <textarea
            id="casting-text"
            maxLength={300}
            rows={3}
            value={text}
            disabled={locked}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="comparison-candidates">
            {pair.map((key, index) => {
              const candidate = candidates[key],
                entry = getAudio(key),
                letter = index === 0 ? 'A' : 'B';
              return (
                <section
                  className="comparison-candidate"
                  aria-label={`製品比較候補${letter}`}
                  key={letter}
                >
                  <label htmlFor={`casting-${letter}`}>製品比較候補{letter}</label>
                  <select
                    id={`casting-${letter}`}
                    value={key}
                    disabled={locked}
                    onChange={(event) => {
                      setPair(
                        index === 0 ? [event.target.value, pair[1]] : [pair[0], event.target.value],
                      );
                      setReason('');
                      setOutcome('undecided');
                    }}
                  >
                    {Object.entries(candidates).map(([id, item]) => (
                      <option key={id} value={id} disabled={id === pair[1 - index]}>
                        {label(item)}
                      </option>
                    ))}
                  </select>
                  <p>
                    {label(candidate)}
                    {selected === key ? ' · 保存対象の声' : ''}
                  </p>
                  <p className="availability-badge">
                    {checking
                      ? '確認中'
                      : available.has(key)
                        ? '試聴可能'
                        : inventory?.engines.find((item) => item.engine === candidate.voice.engine)
                              ?.ready
                          ? '未導入'
                          : '未接続'}
                  </p>
                  {candidate.voice.engine === 'AivisSpeech' && (
                    <AivisModelDetails
                      current={currentModel(candidate)}
                      saved={candidate.modelInfo}
                      checking={checkingModels}
                    />
                  )}
                  <div className="recipe-sliders">
                    {controls(candidate).map((field) => (
                      <div className="recipe-control" key={field.key}>
                        <label htmlFor={`casting-${letter}-${field.key}`}>{field.label}</label>
                        <output htmlFor={`casting-${letter}-${field.key}`}>
                          {Number(
                            (candidate.recipe as unknown as Record<string, unknown>)[field.key],
                          ).toFixed(2)}
                          {field.unit}
                        </output>
                        <input
                          id={`casting-${letter}-${field.key}`}
                          type="range"
                          min={field.min}
                          max={field.max}
                          step={field.step}
                          value={Number(
                            (candidate.recipe as unknown as Record<string, unknown>)[field.key],
                          )}
                          disabled={locked}
                          aria-description={field.help}
                          onChange={(event) =>
                            changeRecipe(key, field.key, Number(event.target.value))
                          }
                        />
                        <small>{field.help}</small>
                      </div>
                    ))}
                  </div>
                  {entry && (
                    <div className="comparison-audio">
                      <audio
                        controls
                        src={entry.url}
                        aria-label={`製品比較候補${letter}の試聴`}
                        onPlay={pauseOtherAudio}
                      />
                      {candidate.voice.engine === 'AivisSpeech' && (
                        <>
                          <p>この試聴音声のモデル版：{entry.modelInfo?.modelVersion ?? '未取得'}</p>
                          {entry.modelInfo &&
                            currentModel(candidate) &&
                            modelInfoChanged(entry.modelInfo, currentModel(candidate)!) && (
                              <p role="status">
                                現在のモデル情報は音声生成時の確認情報と異なります。試聴音声は生成済みのものを再利用しています。
                              </p>
                            )}
                          <details>
                            <summary>試聴音声に対応するモデル情報を見る</summary>
                            <AivisModelDetails historical saved={entry.modelInfo} />
                          </details>
                        </>
                      )}
                      <button
                        className="secondary-button"
                        disabled={locked || checking || !available.has(key) || !text.trim()}
                        onClick={() => void generate(key)}
                      >
                        候補{letter}の音声を再生成
                      </button>
                      <a
                        href={entry.url}
                        download={`voice-atlas-${candidate.voice.engine}-${letter}.wav`}
                      >
                        製品比較候補{letter}のWAVを保存
                      </a>
                    </div>
                  )}
                  {candidate.voice.engine === 'VOICEVOX' && (
                    <a
                      href={
                        voices.find(
                          (voice) => voice.id === (candidate.voice as { voiceId: string }).voiceId,
                        )?.termsUrl
                      }
                      target="_blank"
                      rel="noreferrer"
                    >
                      話者の利用規約
                    </a>
                  )}
                </section>
              );
            })}
          </div>
          <button
            className="secondary-button"
            disabled={
              locked || checking || !text.trim() || !pair.every((key) => available.has(key))
            }
            onClick={() => void generate()}
          >
            {busy ? '製品比較音声を生成中…' : '製品比較のA・Bを生成'}
          </button>
          {busy && (
            <button className="secondary-button" onClick={() => requestRef.current?.abort()}>
              製品比較の生成を中止
            </button>
          )}
          <fieldset
            className="comparison-evaluation"
            disabled={locked || !pair.every((key) => getAudio(key)) || evaluations.length >= 100}
          >
            <legend>製品比較の評価</legend>
            {Object.entries(outcomeLabels).map(([value, title]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="casting-outcome"
                  checked={outcome === value}
                  onChange={() => setOutcome(value as CastingEvaluation['outcome'])}
                />
                {title}
              </label>
            ))}
            <label htmlFor="casting-reason">製品比較の選択理由（1000文字まで）</label>
            <textarea
              id="casting-reason"
              maxLength={1000}
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
            <button className="secondary-button" onClick={record}>
              製品比較の評価を記録
            </button>
          </fieldset>
        </>
      )}
      {comparisonContext && (
        <div className="recipe-notice">
          <p>
            再開・復元した比較の4軸とキャラクター設定を、次の評価にも記録します。上の入力欄の設定は変更しません。
          </p>
          <CharacterContext input={comparisonContext.characterInput ?? undefined} />
          <button
            className="text-button"
            disabled={locked}
            onClick={() => setComparisonContext(null)}
          >
            現在の声の方向を次の評価に使う
          </button>
        </div>
      )}
      <button
        className="secondary-button"
        aria-expanded={historyOpen}
        aria-controls="casting-evaluation-workbench"
        onClick={() => setHistoryOpen(!historyOpen)}
      >
        {historyOpen ? '製品比較の履歴集計を閉じる' : '製品比較の履歴を集計する'}
      </button>
      <div id="casting-evaluation-workbench" hidden={!historyOpen}>
        <CastingEvaluationWorkbench
          currentEvaluations={evaluations}
          disabled={locked}
          onResume={resume}
        />
      </div>
      <p role="status">製品比較の評価記録：{evaluations.length}件 / 100件</p>
      {evaluations.length > 0 && (
        <details>
          <summary>製品比較の履歴を見る</summary>
          <ol className="evaluation-history">
            {evaluations.map((item, i) => (
              <li key={i}>
                <strong>{outcomeLabels[item.outcome]}</strong>
                <p>
                  {item.candidates
                    .map((candidate, j) => `${j === 0 ? 'A' : 'B'}：${label(candidate)}`)
                    .join(' ／ ')}
                </p>
                <p>セリフ：{item.text}</p>
                <p>理由：{item.reason || '記入なし'}</p>
                <p>
                  {item.generations
                    .map(
                      (info, j) =>
                        `${j === 0 ? 'A' : 'B'}：${info ? `${info.engine} ${info.engineVersion ?? '版未取得'} / ${new Date(info.checkedAt).toLocaleString('ja-JP')}` : '生成情報なし'}`,
                    )
                    .join(' ／ ')}
                </p>
                <details>
                  <summary>評価時の調声値</summary>
                  {item.candidates.map((candidate, j) => (
                    <div key={j}>
                      <strong>
                        {j === 0 ? 'A' : 'B'}：{candidate.recipe.engine}
                      </strong>
                      <p>
                        {controls(candidate)
                          .map(
                            (field) =>
                              `${field.label}：${Number((candidate.recipe as unknown as Record<string, unknown>)[field.key]).toFixed(2)}${field.unit}`,
                          )
                          .join(' ／ ')}
                      </p>
                    </div>
                  ))}
                </details>
                {item.candidates
                  .filter((candidate) => candidate.voice.engine === 'AivisSpeech')
                  .map((candidate, index) => (
                    <AivisModelDetails key={index} historical saved={candidate.modelInfo} />
                  ))}
                <CharacterContext input={item.characterInput ?? undefined} />
                <small>{new Date(item.recordedAt).toLocaleString('ja-JP')}</small>
              </li>
            ))}
          </ol>
        </details>
      )}
      <p className="footnote">
        比較セッションはVOICEVOX・AivisSpeechの製品別調声値を保存します。音声は含まず、復元後は再生成します。従来のレシピJSONは「レシピJSONを読み込む」から復元できます。
      </p>
    </section>
  );
}
