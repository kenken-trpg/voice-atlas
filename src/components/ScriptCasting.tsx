import { useState } from 'react';
import { type CastingAssignment } from '../../shared/casting-board';
import { scriptCandidate, type VoiceScript } from '../../shared/script';
import { scriptCharacter, type ScriptRecastPlan } from '../../shared/script-recast';
import { planScriptCasting, unassignedSpeakers } from '../../shared/script-casting';
import { castingRecipeSummary } from '../../shared/casting';

export function ScriptCasting({
  script,
  assignments,
  disabled,
  onApply,
}: {
  script: VoiceScript;
  assignments: CastingAssignment[];
  disabled: boolean;
  onApply: (plan: ScriptRecastPlan) => void;
}) {
  const [choices, setChoices] = useState<Map<string, string>>(() => new Map());
  const [overwrite, setOverwrite] = useState(false);
  const [review, setReview] = useState<{
    original: VoiceScript;
    assignments: string;
    plan: ScriptRecastPlan;
  } | null>(null);
  const [error, setError] = useState('');
  const groups = unassignedSpeakers(script);
  const unnamed = script.lines.filter((line) => !line.assignment && !scriptCharacter(line)).length;
  const selected = groups.filter((group) =>
    assignments.some((item) => item.id === choices.get(group.character)),
  );
  const current =
    review?.original === script && review.assignments === JSON.stringify(assignments)
      ? review
      : null;
  const count = groups.reduce((sum, group) => sum + group.unassigned, 0) + unnamed;
  const label = (assignment: CastingAssignment) => {
    const candidate = scriptCandidate({ id: assignment.id, text: '', assignment })!;
    return `${assignment.project} / ${assignment.character} / ${assignment.scene} · ${candidate.voice.engine} · ${candidate.voice.name} / ${candidate.voice.style}`;
  };
  function reset() {
    setReview(null);
    setError('');
  }
  return (
    <section className="script-casting" aria-label="未配役の一括設定">
      <h5>未配役の発話者に声を割り当てる</h5>
      <p role="status">
        未配役：{groups.length}人・{count}行{unnamed ? `（発話者名なし${unnamed}行を含む）` : ''}
      </p>
      {count === 0 ? (
        <p>
          すべての行に声が割り当てられています。変更するときは「キャラクターの声をまとめて差し替える」を使えます。
        </p>
      ) : (
        <>
          <p>
            発話者ごとにキャスティング表の声を選び、対象行を確認してまとめて配役します。空欄の発話者は今回の対象に含めません。セリフ・読み上げ文・行順・発話者名は保持します。
          </p>
          {unnamed > 0 && (
            <p>
              発話者名のない行は一括配役の対象外です。各行で発話者名を入力するか、声を直接割り当ててください。
            </p>
          )}
          {!assignments.length && (
            <p>
              キャスティング表に声がありません。先に採用声の設定比較を記録し、キャラクター・場面ごとの声を確定してください。
            </p>
          )}
          <fieldset disabled={disabled || !assignments.length}>
            <legend>発話者ごとの配役</legend>
            {groups.map((group) => (
              <label key={group.character}>
                {group.character}：未配役{group.unassigned}行・配役済み{group.assigned}行
                <select
                  aria-label={`${group.character}の一括配役`}
                  value={
                    assignments.some((item) => item.id === choices.get(group.character))
                      ? choices.get(group.character)
                      : ''
                  }
                  onChange={(event) => {
                    setChoices(new Map(choices).set(group.character, event.target.value));
                    reset();
                  }}
                >
                  <option value="">今回は配役しない</option>
                  {assignments.map((assignment) => (
                    <option key={assignment.id} value={assignment.id}>
                      {label(assignment)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="script-casting-overwrite">
              <input
                type="checkbox"
                checked={overwrite}
                onChange={(event) => {
                  setOverwrite(event.target.checked);
                  reset();
                }}
              />
              選んだ発話者の配役済み行も上書きする
            </label>
            <p className="footnote">
              通常は未配役行だけを変更します。上書きすると、同じ発話者名の行は作品・場面が異なる配役も含めて変更対象になります。未接続の声も割り当てられますが、生成には対応するエンジンが必要です。
            </p>
            <button
              className="secondary-button"
              disabled={!selected.length || disabled}
              onClick={() => {
                try {
                  const plan = planScriptCasting(
                    script,
                    assignments,
                    selected.map((group) => ({
                      character: group.character,
                      assignmentId: choices.get(group.character)!,
                    })),
                    overwrite,
                  );
                  setReview({ original: script, assignments: JSON.stringify(assignments), plan });
                  setError('');
                } catch (cause) {
                  setReview(null);
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : '配役を準備できませんでした。現在の台本は保持しています。',
                  );
                }
              }}
            >
              一括配役の対象を確認
            </button>
          </fieldset>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {review && !current && (
        <p role="status">
          台本またはキャスティング表が変更されました。対象をもう一度確認してください。
        </p>
      )}
      {current && (
        <div role="group" aria-label="一括配役の確認">
          <p role="status">
            対象{current.plan.targetedIds.length}行 / 設定変更{current.plan.changedIds.length}行 /
            音声が変わる{current.plan.audioChangedIds.length}行
          </p>
          <ol>
            {script.lines.flatMap((line, index) => {
              if (!current.plan.targetedIds.includes(line.id)) return [];
              const updated = current.plan.script.lines[index];
              const candidate = scriptCandidate(updated)!;
              return [
                <li key={line.id}>
                  <strong>
                    第{index + 1}行：{scriptCharacter(line)}
                  </strong>
                  <p>{line.text || 'セリフ未入力'}</p>
                  <p>
                    {line.assignment ? `配役済み：${label(line.assignment)}` : '未配役'} →{' '}
                    {label(updated.assignment!)}
                  </p>
                  <details>
                    <summary>割り当てる声の調声</summary>
                    <p>{castingRecipeSummary(candidate)}</p>
                  </details>
                  <p>
                    {!current.plan.changedIds.includes(line.id)
                      ? '設定変更なし・音声を保持'
                      : current.plan.audioChangedIds.includes(line.id)
                        ? '音声の条件が変わります'
                        : '同じ音声条件のため音声を保持'}
                  </p>
                </li>,
              ];
            })}
          </ol>
          <p>
            反映時に音声は生成しません。直前の変更は下の「直前の声の差し替え」から取り消せます。変更する行以外の配役・音声と、台本ライブラリ・キャスティング表は保持します。
          </p>
          <button
            className="secondary-button"
            disabled={disabled || !current.plan.changedIds.length}
            onClick={() => {
              onApply(current.plan);
              setReview(null);
              setChoices(new Map());
              setOverwrite(false);
            }}
          >
            確認した一括配役を反映
          </button>
          <button className="secondary-button" disabled={disabled} onClick={() => setReview(null)}>
            一括配役をキャンセル
          </button>
        </div>
      )}
    </section>
  );
}
