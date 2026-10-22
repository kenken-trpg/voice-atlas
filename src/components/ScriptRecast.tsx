import { useState } from 'react';
import { type CastingAssignment } from '../../shared/casting-board';
import { type ScriptLine, type VoiceScript, scriptCandidate } from '../../shared/script';
import {
  planScriptRecast,
  recastGroups,
  scriptCharacter,
  type ScriptRecastPlan,
} from '../../shared/script-recast';
import {
  castingCandidateSchema,
  castingKey,
  castingRecipeFields,
  type CastingInventory,
} from '../../shared/casting';

function voiceLabel(line: ScriptLine) {
  const candidate = scriptCandidate(line);
  return candidate
    ? `${candidate.voice.engine} · ${candidate.voice.name} / ${candidate.voice.style}`
    : '声が未割り当て';
}
export function ScriptRecast({
  script,
  assignments,
  disabled,
  inventory,
  checking,
  onApply,
}: {
  script: VoiceScript;
  assignments: CastingAssignment[];
  disabled: boolean;
  inventory: CastingInventory | null;
  checking: boolean;
  onApply: (plan: ScriptRecastPlan) => void;
}) {
  const [character, setCharacter] = useState('');
  const [source, setSource] = useState('all');
  const [targetId, setTargetId] = useState('');
  const [error, setError] = useState('');
  const [review, setReview] = useState<{
    original: VoiceScript;
    assignment: string;
    plan: ScriptRecastPlan;
  } | null>(null);
  const characters = [
    ...new Set(script.lines.map(scriptCharacter).filter((value): value is string => !!value)),
  ];
  const groups = recastGroups(script, character);
  const target = assignments.find((item) => item.id === targetId);
  const targetLine = target ? { id: target.id, text: '', assignment: target } : null;
  const current =
    review && review.original === script && target && review.assignment === JSON.stringify(target)
      ? review
      : null;
  const targetCandidate = targetLine ? scriptCandidate(targetLine) : null;
  function status(line: ScriptLine) {
    const candidate = scriptCandidate(line);
    if (!candidate) return '未割り当て';
    if (!castingCandidateSchema.safeParse(candidate).success) return '現行カタログ対象外';
    if (checking) return '確認中';
    if (inventory?.voices.some((voice) => castingKey(voice) === castingKey(candidate.voice)))
      return '試聴可能';
    return inventory?.engines.find((engine) => engine.engine === candidate.voice.engine)?.ready
      ? '未導入'
      : '未接続';
  }
  return (
    <details className="script-recast">
      <summary>キャラクターの声をまとめて差し替える</summary>
      <section aria-label="台本の声の一括差し替え">
        <h5>発話者ごとに声を差し替える</h5>
        <p>
          編集中の台本だけを変更します。セリフ・行順・発話者名・行間と、変更していない行の音声を保持します。台本ライブラリとキャスティング表の登録は変更しません。
        </p>
        <ul>
          {characters.map((name) => (
            <li key={name}>
              {name}：{script.lines.filter((line) => scriptCharacter(line) === name).length}行 /{' '}
              {recastGroups(script, name).length}種類の設定
            </li>
          ))}
        </ul>
        {!characters.length && (
          <p>発話者のいる行がありません。声を割り当てるか、名前付きの台本を取り込んでください。</p>
        )}
        {error && <p role="alert">{error}</p>}
        <label>
          差し替える発話者
          <select
            aria-label="差し替える発話者"
            value={character}
            disabled={disabled}
            onChange={(event) => {
              setCharacter(event.target.value);
              setSource('all');
              setReview(null);
              setError('');
            }}
          >
            <option value="">発話者を選択</option>
            {characters.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          差し替える範囲
          <select
            aria-label="声の差し替え範囲"
            value={source}
            disabled={disabled || !groups.length}
            onChange={(event) => {
              setSource(event.target.value);
              setReview(null);
              setError('');
            }}
          >
            <option value="all">この発話者の全行</option>
            {source !== 'all' && !groups.some((group) => group.key === source) && (
              <option value={source} disabled>
                以前の設定（現在の対象なし）
              </option>
            )}
            {groups.map((group) => (
              <option key={group.key} value={group.key}>
                第{script.lines.findIndex((line) => line.id === group.line.id) + 1}行など ·{' '}
                {group.line.assignment
                  ? `${group.line.assignment.project} / ${group.line.assignment.scene}`
                  : '未割り当て'}{' '}
                · {voiceLabel(group.line)} · {group.count}行
              </option>
            ))}
          </select>
        </label>
        {groups.length > 0 && (
          <details>
            <summary>現在の設定・調声値を確認</summary>
            {groups.map((group) => {
              const candidate = scriptCandidate(group.line);
              return (
                <div key={group.key}>
                  <p>
                    第{script.lines.findIndex((line) => line.id === group.line.id) + 1}行など：
                    {voiceLabel(group.line)} · {group.count}行
                  </p>
                  {candidate && (
                    <p>
                      {castingRecipeFields(candidate)
                        .map(
                          (field) =>
                            `${field.label}：${(candidate.recipe as unknown as Record<string, number>)[field.key]}${field.unit}`,
                        )
                        .join(' ／ ')}
                    </p>
                  )}
                </div>
              );
            })}
          </details>
        )}
        <label>
          差し替え先の確定設定
          <select
            aria-label="差し替え先の確定設定"
            value={targetId}
            disabled={disabled}
            onChange={(event) => {
              setTargetId(event.target.value);
              setReview(null);
              setError('');
            }}
          >
            <option value="">確定設定を選択</option>
            {assignments.map((item) => {
              const line = { id: item.id, text: '', assignment: item };
              return (
                <option key={item.id} value={item.id}>
                  {item.project} / {item.character} / {item.scene} · {voiceLabel(line)} ·{' '}
                  {status(line)}
                </option>
              );
            })}
          </select>
        </label>
        <button
          className="secondary-button"
          disabled={disabled || !character || !groups.length || !target}
          onClick={() => {
            try {
              const plan = planScriptRecast(script, character, source, target!);
              setReview({ original: script, assignment: JSON.stringify(target), plan });
              setError('');
            } catch (e) {
              setReview(null);
              setError(
                e instanceof Error && e.message.length < 250
                  ? e.message
                  : '差し替えを準備できませんでした。現在の台本は保持しています。',
              );
            }
          }}
        >
          差し替え対象を確認
        </button>
        {current && (
          <div role="group" aria-label="声の差し替え確認">
            <p role="status">
              対象{current.plan.targetedIds.length}行 / 設定変更{current.plan.changedIds.length}行 /
              音声再生成が必要{current.plan.audioChangedIds.length}行
            </p>
            <p>
              変更後：{voiceLabel(targetLine!)} · {status(targetLine!)}
            </p>
            {targetCandidate && (
              <details>
                <summary>変更後の調声値</summary>
                <p>
                  {castingRecipeFields(targetCandidate)
                    .map(
                      (field) =>
                        `${field.label}：${(targetCandidate.recipe as unknown as Record<string, number>)[field.key]}${field.unit}`,
                    )
                    .join(' ／ ')}
                </p>
              </details>
            )}
            <ol>
              {script.lines.flatMap((line, index) =>
                current.plan.targetedIds.includes(line.id)
                  ? [
                      <li key={line.id}>
                        第{index + 1}行：{line.text || 'セリフ未入力'}
                        <p>
                          現在：{voiceLabel(line)}
                          {current.plan.changedIds.includes(line.id)
                            ? current.plan.audioChangedIds.includes(line.id)
                              ? ' → 音声を再生成'
                              : ' → 同じ話者・調声値のため音声を保持'
                            : ' → 設定変更なし'}
                        </p>
                      </li>,
                    ]
                  : [],
              )}
            </ol>
            <p>
              反映では音声を生成しません。差し替え後の「差し替えた行の未生成音声を生成」で対象行だけを生成できます。未接続・未導入・現行カタログ対象外の設定も保存できますが、そのままでは生成できません。
            </p>
            <button
              className="secondary-button"
              disabled={disabled || !current.plan.changedIds.length}
              onClick={() => {
                onApply(current.plan);
                setReview(null);
              }}
            >
              確認した声の差し替えを反映
            </button>
            <button
              className="secondary-button"
              disabled={disabled}
              onClick={() => setReview(null)}
            >
              声の差し替えをキャンセル
            </button>
          </div>
        )}
      </section>
    </details>
  );
}
