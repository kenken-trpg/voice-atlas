import { type Ref, type SyntheticEvent } from 'react';
import {
  scriptAudioKey,
  scriptCandidate,
  type VoiceScript,
  type ScriptLine,
} from '../../shared/script';
import { recastUndoIssues, type ScriptRecastSnapshot } from '../../shared/script-recast-history';
import { castingRecipeFields } from '../../shared/casting';
import { type LibraryAudition } from '../../shared/library-comparison';
import { AivisModelDetails } from './AivisModelDetails';

export type ScriptPreview = { key: string; url: string; blob: Blob; audition: LibraryAudition };
export type RecastMemory = {
  snapshot: ScriptRecastSnapshot;
  beforeAudio: Record<string, ScriptPreview>;
};
export function ScriptRecastHistory({
  script,
  memory,
  previews,
  disabled,
  onUndo,
  onDiscard,
  onPlay,
  ref,
}: {
  script: VoiceScript;
  memory: RecastMemory | null;
  previews: Record<string, ScriptPreview>;
  disabled: boolean;
  onUndo: () => void;
  onDiscard: () => void;
  onPlay: (event: SyntheticEvent<HTMLAudioElement>) => void;
  ref: Ref<HTMLElement>;
}) {
  if (!memory) return null;
  const issues = recastUndoIssues(script, memory.snapshot);
  function side(
    line: ScriptLine,
    preview: ScriptPreview | undefined,
    label: string,
    rowNumber: number,
  ) {
    const candidate = scriptCandidate(line),
      valid = preview?.key === scriptAudioKey(line) ? preview : null;
    return (
      <div className="recast-audio-side">
        <strong>{label}</strong>
        <p>
          {candidate
            ? `${candidate.voice.engine} · ${candidate.voice.name} / ${candidate.voice.style}`
            : '声が未割り当て'}
        </p>
        {candidate && (
          <details>
            <summary>{label}の調声値</summary>
            <p>
              {castingRecipeFields(candidate)
                .map(
                  (field) =>
                    `${field.label}：${(candidate.recipe as unknown as Record<string, number>)[field.key]}${field.unit}`,
                )
                .join(' ／ ')}
            </p>
          </details>
        )}
        {valid ? (
          <>
            <audio
              controls
              src={valid.url}
              aria-label={`記録第${rowNumber}行の${label}の試聴`}
              onPlay={onPlay}
            />
            <p>
              {label}の生成エンジン版：{valid.audition.generation?.engineVersion ?? '未取得'}
            </p>
            {candidate?.voice.engine === 'AivisSpeech' && (
              <AivisModelDetails historical saved={valid.audition.modelInfo} />
            )}
          </>
        ) : (
          <p>
            {label}の音声は未生成です。
            {label === '差し替え前'
              ? '取り消し後に必要な行を生成してください。'
              : '対象行の音声を生成すると比較できます。'}
          </p>
        )}
      </div>
    );
  }
  return (
    <section ref={ref} className="script-recast-history" aria-label="声の差し替え前後の比較">
      <h5>直前の差し替えを比較・取り消す</h5>
      <p>
        直前の一括差し替え1回分だけ、変更前の設定と生成済み音声を保持しています。同じセリフの前後を聴き比べられます。取り消しは対象行の設定だけを戻し、台本名・行間・並べ替えや対象外の編集は保持します。
      </p>
      <p>
        対象行のセリフや声を編集した場合、または行を削除した場合は、後からの編集を失わないよう取り消しを止めます。次の一括差し替え・別台本の読み込み・ページ再読み込みでこの記録を破棄します。保存済みライブラリは取り消しでは変わりません。
      </p>
      {issues.map((issue) => (
        <p key={issue.id} role="status">
          {issue.reason}
        </p>
      ))}
      <div className="casting-actions">
        <button
          className="secondary-button"
          disabled={disabled || !!issues.length}
          onClick={onUndo}
        >
          直前の声の差し替えを取り消す
        </button>
        <button className="text-button" disabled={disabled} onClick={onDiscard}>
          差し替え前の記録を破棄
        </button>
      </div>
      <ol className="evaluation-history">
        {memory.snapshot.rows.map((row) => {
          const index = script.lines.findIndex((line) => line.id === row.after.id),
            current = script.lines[index];
          const compatible = !!current && !issues.some((issue) => issue.id === row.after.id);
          return (
            <li key={row.after.id} aria-label={`差し替え比較の記録第${row.position}行`}>
              <strong>
                {index >= 0
                  ? `現在の第${index + 1}行`
                  : `削除された行（記録時の第${row.position}行）`}
              </strong>
              <p>比較のセリフ：{row.before.text || 'セリフ未入力'}</p>
              <div className="recast-audio-pair">
                {side(row.before, memory.beforeAudio[row.before.id], '差し替え前', row.position)}
                {compatible ? (
                  side(row.after, previews[row.after.id], '差し替え後', row.position)
                ) : (
                  <p>
                    この行は差し替え後に編集・削除されたため、前後比較できません。変更前の記録のみ表示しています。
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
