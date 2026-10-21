import { useEffect, useState } from 'react';
import type { Evaluation } from '../../shared/saved-recipe';
import type { Recipe, Voice } from '../../shared/schema';
import { RecipeControls } from './RecipeControls';
import { availabilityLabels, type VoiceAvailability } from '../../shared/voicevox';
import { AvailabilityBadge, AvailabilityHelp } from './AvailabilityBadge';
import { EvaluationProvenance } from './EvaluationProvenance';

export function pauseOtherAudio(event: React.SyntheticEvent<HTMLAudioElement>) {
  document.querySelectorAll('audio').forEach((audio) => {
    if (audio !== event.currentTarget) audio.pause();
  });
}

export function ComparisonPanel({
  voices,
  ids,
  text,
  disabled,
  availability,
  availableOnly,
  generating,
  evaluations,
  getRecipe,
  getAudio,
  onPairChange,
  onTextChange,
  onRecipeChange,
  onGenerate,
  onRecord,
  selectedId,
  contextKey,
}: {
  voices: Voice[];
  ids: [string, string];
  text: string;
  disabled: boolean;
  availability: Record<string, VoiceAvailability>;
  availableOnly: boolean;
  generating: boolean;
  evaluations: Evaluation[];
  getRecipe: (id: string) => Recipe;
  getAudio: (id: string) => string;
  onPairChange: (ids: [string, string]) => void;
  onTextChange: (text: string) => void;
  onRecipeChange: (id: string, recipe: Recipe) => void;
  onGenerate: () => void;
  onRecord: (outcome: Evaluation['outcome'], reason: string) => void;
  selectedId: string;
  contextKey: string;
}) {
  const [outcome, setOutcome] = useState<Evaluation['outcome']>('undecided');
  const [reason, setReason] = useState('');
  useEffect(() => {
    setOutcome('undecided');
    setReason('');
  }, [contextKey]);
  const haveAudio = ids.every((id) => Boolean(getAudio(id)));
  const ready = ids.every((id) => availability[id] === 'available');
  return (
    <section className="comparison-panel" aria-label="2候補の比較試聴">
      <h3>同じセリフで、2つの声を聴き比べる</h3>
      <p>調整値は候補ごとに保持します。A・Bの音声は順番に生成します。</p>
      <label htmlFor="comparison-text">比較するセリフ（単独試聴と共通・300文字まで）</label>
      <textarea
        id="comparison-text"
        rows={3}
        maxLength={300}
        value={text}
        disabled={disabled}
        onChange={(e) => onTextChange(e.target.value)}
      />
      <div className="comparison-candidates">
        {ids.map((id, index) => {
          const voice = voices.find((item) => item.id === id)!;
          const recipe = getRecipe(id);
          const audio = getAudio(id);
          const label = index === 0 ? 'A' : 'B';
          return (
            <section className="comparison-candidate" key={label} aria-label={`比較候補${label}`}>
              <label htmlFor={`candidate-${label}`}>候補{label}</label>
              <select
                id={`candidate-${label}`}
                value={id}
                disabled={disabled}
                onChange={(e) =>
                  onPairChange(index === 0 ? [e.target.value, ids[1]] : [ids[0], e.target.value])
                }
              >
                {voices
                  .filter(
                    (item) =>
                      !availableOnly || item.id === id || availability[item.id] === 'available',
                  )
                  .map((item) => (
                    <option key={item.id} value={item.id} disabled={item.id === ids[1 - index]}>
                      {item.name} / {item.style} · {availabilityLabels[availability[item.id]]}
                    </option>
                  ))}
              </select>
              <p>
                {voice.name} / {voice.style}
                {selectedId === id ? ' · 保存対象の声' : ''}
              </p>
              <AvailabilityBadge status={availability[id]} />
              <AvailabilityHelp status={availability[id]} />
              <RecipeControls
                recipe={recipe}
                disabled={disabled}
                idPrefix={`compare-${label}`}
                onChange={(key, value) => onRecipeChange(id, { ...recipe, [key]: value })}
              />
              {audio ? (
                <div className="comparison-audio">
                  <audio
                    controls
                    src={audio}
                    aria-label={`候補${label}の試聴`}
                    onPlay={pauseOtherAudio}
                  />
                  <a href={audio} download={`voice-atlas-${id}.wav`}>
                    候補{label}のWAVを保存
                  </a>
                </div>
              ) : (
                <p className="footnote">現在のセリフ・設定の音声は未生成です。</p>
              )}
              <small className="footnote">クレジット参考：{voice.credit}</small>
              {voice.termsNote && <p className="footnote">{voice.termsNote}</p>}
              <a href={voice.termsUrl} target="_blank" rel="noreferrer">
                候補{label}の利用規約
              </a>
            </section>
          );
        })}
      </div>
      <button
        className="secondary-button"
        onClick={onGenerate}
        disabled={disabled || !ready || !text.trim()}
      >
        {generating ? '比較音声を生成中…' : 'A・Bの比較音声を生成'}
      </button>
      {!ready && (
        <p className="footnote">
          両候補が「試聴可能」になると比較音声を生成できます。候補ごとの調整はそのまま保持します。
        </p>
      )}
      <fieldset
        disabled={disabled || !haveAudio || evaluations.length >= 100}
        className="comparison-evaluation"
      >
        <legend>聴き比べた結果</legend>
        <p className="footnote">A・Bの採用を記録すると、その声がJSON保存の対象になります。</p>
        <div className="comparison-outcomes">
          {(
            [
              ['a', 'Aを採用'],
              ['b', 'Bを採用'],
              ['tie', '同程度'],
              ['undecided', '判断できない'],
            ] as const
          ).map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="comparison-outcome"
                value={value}
                checked={outcome === value}
                onChange={() => setOutcome(value)}
              />
              {label}
            </label>
          ))}
        </div>
        <label htmlFor="comparison-reason">選択理由（任意・1000文字まで）</label>
        <textarea
          id="comparison-reason"
          rows={2}
          maxLength={1000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button
          className="secondary-button"
          onClick={() => {
            onRecord(outcome, reason);
            setReason('');
          }}
        >
          評価を記録
        </button>
      </fieldset>
      {!haveAudio && (
        <p className="footnote">両候補の現在の音声を生成してから評価を記録できます。</p>
      )}
      <p role="status">評価記録：{evaluations.length}件 / 100件</p>
      <p className="footnote">
        新しい評価には評価時のスコア・VOICEVOX全候補内の順位・推薦とカタログの版を記録します。
      </p>
      {evaluations.length >= 100 && <p>記録の上限です。JSONで保存してください。</p>}
      {evaluations.length > 0 && (
        <details>
          <summary>記録した評価を見る</summary>
          <ol className="evaluation-history">
            {evaluations.map((item, index) => (
              <li key={index}>
                <strong>
                  {
                    { a: 'Aを採用', b: 'Bを採用', tie: '同程度', undecided: '判断できない' }[
                      item.outcome
                    ]
                  }
                </strong>
                <p>
                  {item.candidates
                    .map(
                      (candidate, i) =>
                        `${i === 0 ? 'A' : 'B'}：${voices.find((v) => v.id === candidate.voiceId)?.name} / ${voices.find((v) => v.id === candidate.voiceId)?.style}`,
                    )
                    .join(' ／ ')}
                </p>
                <p>セリフ：{item.sampleText}</p>
                <p>理由：{item.reason || '記入なし'}</p>
                <p>
                  {item.evidence
                    ? item.evidence.candidates
                        .map(
                          (candidate, index) =>
                            `${index === 0 ? 'A' : 'B'}：評価時スコア ${candidate.score}（${candidate.rank}位 / ${item.evidence!.candidateCount}候補）`,
                        )
                        .join(' ／ ')
                    : '評価時スコア：記録なし'}
                </p>
                <EvaluationProvenance evaluation={item} />
                <small>{new Date(item.recordedAt).toLocaleString('ja-JP')}</small>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
