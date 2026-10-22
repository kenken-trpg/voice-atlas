import { useState } from 'react';
import { type CastingAssignment } from '../../shared/casting-board';
import {
  castingCandidateSchema,
  castingKey,
  castingRecipeFields,
  type CastingInventory,
} from '../../shared/casting';
import { scriptCandidate, type VoiceScript } from '../../shared/script';
import {
  planScriptScene,
  sceneSettingLines,
  type ScriptRecastPlan,
} from '../../shared/script-recast';

export function ScriptSceneSettings({
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
  const [project, setProject] = useState('');
  const [character, setCharacter] = useState('');
  const [targetId, setTargetId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [review, setReview] = useState<{
    original: VoiceScript;
    assignment: string;
    selected: string;
    plan: ScriptRecastPlan;
  } | null>(null);
  const projects = [...new Set(assignments.map((item) => item.project))];
  const characters = [
    ...new Set(
      assignments.filter((item) => item.project === project).map((item) => item.character),
    ),
  ];
  const settings = assignments.filter(
    (item) => item.project === project && item.character === character,
  );
  const target = settings.find((item) => item.id === targetId);
  const candidate = target
    ? scriptCandidate({ id: target.id, text: '', assignment: target })
    : null;
  const lines = sceneSettingLines(script, project, character);
  const current =
    review &&
    review.original === script &&
    target &&
    review.assignment === JSON.stringify(target) &&
    review.selected === JSON.stringify(selected) &&
    review.plan.targetedIds.every((id) => lines.some((line) => line.id === id))
      ? review
      : null;
  const status = !candidate
    ? ''
    : !castingCandidateSchema.safeParse(candidate).success
      ? '現行カタログ対象外'
      : checking
        ? '確認中'
        : inventory?.voices.some((voice) => castingKey(voice) === castingKey(candidate.voice))
          ? '試聴可能'
          : inventory?.engines.find((engine) => engine.engine === candidate.voice.engine)?.ready
            ? '未導入'
            : '未接続';
  function reset() {
    setReview(null);
    setError('');
  }
  return (
    <details className="script-scene-settings">
      <summary>場面別の声を呼び出す</summary>
      <section aria-label="台本の場面別設定">
        <h5>選んだ行に場面の設定を適用</h5>
        <p>
          キャスティング表に登録した通常・小声・緊迫などの設定を呼び出します。作品・キャラクター・場面を選び、適用する行を確認してください。
        </p>
        {!assignments.length && (
          <p>先にキャスティング表へ、キャラクターと使用場面ごとの確定設定を保存してください。</p>
        )}
        {error && <p role="alert">{error}</p>}
        <fieldset disabled={disabled}>
          <legend>呼び出す設定</legend>
          <label>
            作品
            <select
              aria-label="場面設定の作品"
              value={project}
              onChange={(event) => {
                setProject(event.target.value);
                setCharacter('');
                setTargetId('');
                setSelected([]);
                reset();
              }}
            >
              <option value="">作品を選択</option>
              {projects.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label>
            キャラクター
            <select
              aria-label="場面設定のキャラクター"
              value={character}
              disabled={!projects.includes(project)}
              onChange={(event) => {
                setCharacter(event.target.value);
                setTargetId('');
                setSelected([]);
                reset();
              }}
            >
              <option value="">キャラクターを選択</option>
              {characters.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </label>
          <label>
            使用場面
            <select
              aria-label="呼び出す場面設定"
              value={targetId}
              disabled={!characters.includes(character)}
              onChange={(event) => {
                setTargetId(event.target.value);
                reset();
              }}
            >
              <option value="">場面を選択</option>
              {settings.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.scene}
                </option>
              ))}
            </select>
          </label>
          {candidate && (
            <div>
              <p>
                {candidate.voice.engine} · {candidate.voice.name} / {candidate.voice.style} ·{' '}
                {status}
              </p>
              <p>
                {castingRecipeFields(candidate)
                  .map(
                    (field) =>
                      `${field.label}：${(candidate.recipe as unknown as Record<string, number>)[field.key]}${field.unit}`,
                  )
                  .join(' ／ ')}
              </p>
            </div>
          )}
          {character && (
            <>
              <p>
                同じ作品に割り当てられた「{character}
                」の行と、声が未割り当ての同名の行を表示します。
              </p>
              {!lines.length && <p>この作品・キャラクターに対応する行がありません。</p>}
              <div className="casting-actions">
                <button
                  className="text-button"
                  disabled={!lines.length}
                  onClick={() => {
                    setSelected(lines.map((line) => line.id));
                    reset();
                  }}
                >
                  対象行をすべて選択
                </button>
                <button
                  className="text-button"
                  disabled={!selected.length}
                  onClick={() => {
                    setSelected([]);
                    reset();
                  }}
                >
                  対象行の選択を解除
                </button>
              </div>
              <ul>
                {lines.map((line) => {
                  const position = script.lines.findIndex((item) => item.id === line.id) + 1;
                  return (
                    <li key={line.id}>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`場面設定の対象 第${position}行`}
                          checked={selected.includes(line.id)}
                          onChange={(event) => {
                            setSelected(
                              event.target.checked
                                ? [...selected, line.id]
                                : selected.filter((id) => id !== line.id),
                            );
                            reset();
                          }}
                        />
                        第{position}行：{line.text || 'セリフ未入力'} · 現在：
                        {line.assignment?.scene ?? '声が未割り当て'}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <button
            className="secondary-button"
            disabled={!target || !selected.length}
            onClick={() => {
              try {
                const plan = planScriptScene(script, target!, selected);
                setReview({
                  original: script,
                  assignment: JSON.stringify(target),
                  selected: JSON.stringify(selected),
                  plan,
                });
                setError('');
              } catch {
                setReview(null);
                setError('台本・設定・対象行を確認し直してください。現在の台本は保持しています。');
              }
            }}
          >
            場面設定の適用対象を確認
          </button>
        </fieldset>
        {review && (
          <div role="group" aria-label="場面設定の適用確認">
            {!current ? (
              <p role="status">台本または設定が変わりました。適用対象を確認し直してください。</p>
            ) : (
              <>
                <p>
                  適用する設定：{target!.project} / {target!.character} / {target!.scene}
                </p>
                <p role="status">
                  対象{current.plan.targetedIds.length}行 / 設定変更{current.plan.changedIds.length}
                  行 / 音声再生成が必要{current.plan.audioChangedIds.length}行
                </p>
                <ol>
                  {script.lines.flatMap((line, index) =>
                    current.plan.targetedIds.includes(line.id)
                      ? [
                          <li key={line.id}>
                            第{index + 1}行：{line.text || 'セリフ未入力'} ·{' '}
                            {current.plan.audioChangedIds.includes(line.id)
                              ? '音声を再生成'
                              : '音声条件を保持'}
                          </li>,
                        ]
                      : [],
                  )}
                </ol>
              </>
            )}
            <p>
              反映では音声を生成しません。セリフ・読み上げ文・行順と対象外の音声を保持します。キャスティング表は変更しません。直前の差し替え記録から元へ戻せます。未接続・未導入の声は接続・導入後に生成してください。
            </p>
            <button
              className="secondary-button"
              disabled={disabled || !current || !current.plan.changedIds.length}
              onClick={() => {
                if (!current || disabled) return;
                onApply(current.plan);
                reset();
              }}
            >
              確認した場面設定を反映
            </button>
            <button className="text-button" disabled={disabled} onClick={reset}>
              場面設定の適用をキャンセル
            </button>
          </div>
        )}
      </section>
    </details>
  );
}
