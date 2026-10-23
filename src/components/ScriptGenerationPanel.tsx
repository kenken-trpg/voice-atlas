import {
  generationRetryPlan,
  type ScriptGenerationJob,
  type ScriptRetryMode,
} from '../../shared/script-generation';
import { scriptAudioKey, type ScriptLine, type VoiceScript } from '../../shared/script';

export function ScriptGenerationPanel({
  job,
  script,
  busy,
  disabled,
  stopping,
  issue,
  onStop,
  onRetry,
  onDismiss,
}: {
  job: ScriptGenerationJob | null;
  script: VoiceScript;
  busy: boolean;
  disabled: boolean;
  stopping: boolean;
  issue: (line: ScriptLine) => string | null;
  onStop: () => void;
  onRetry: (mode: ScriptRetryMode) => void;
  onDismiss: () => void;
}) {
  if (!job) return null;
  const completed = job.rows.filter((row) => row.status === 'succeeded').length;
  const failed = job.rows.filter((row) => row.status === 'failed').length;
  const stopped = job.rows.filter((row) => row.status === 'stopped').length;
  const waiting = job.rows.filter((row) => row.status === 'waiting').length;
  const retry = (mode: ScriptRetryMode) => {
    const plan = generationRetryPlan(script, job, mode);
    return { ...plan, unavailable: plan.lines.some((line) => issue(line)) };
  };
  const failures = retry('failed'),
    unfinished = retry('unfinished');
  const label = {
    waiting: '未処理',
    generating: '生成中',
    succeeded: '成功',
    failed: '失敗',
    stopped: '中止',
  };
  return (
    <section className="script-generation" aria-label="台本の生成状況">
      <h5>生成の進捗・停止・再試行</h5>
      <p role="status">
        {busy
          ? stopping
            ? '生成の中止を待っています。'
            : '台本の音声を生成しています。'
          : completed === job.rows.length
            ? 'この生成の対象行はすべて成功しました。'
            : '未完了の対象行があります。'}{' '}
        成功{completed} / 対象{job.rows.length}行 · 失敗{failed}行 · 中止{stopped}行 · 未処理
        {waiting}行
      </p>
      <progress aria-label="台本音声の生成完了行数" max={job.rows.length} value={completed} />
      <div className="casting-actions">
        {busy && (
          <button disabled={stopping} onClick={onStop}>
            台本の生成を中止
          </button>
        )}
        <button
          className="secondary-button"
          disabled={
            disabled ||
            busy ||
            !failures.lines.length ||
            !!failures.invalidIds.length ||
            failures.unavailable
          }
          onClick={() => onRetry('failed')}
        >
          失敗した行だけ再試行
        </button>
        <button
          className="secondary-button"
          disabled={
            disabled ||
            busy ||
            !unfinished.lines.length ||
            !!unfinished.invalidIds.length ||
            unfinished.unavailable
          }
          onClick={() => onRetry('unfinished')}
        >
          未完了の対象行を再開
        </button>
        <button className="text-button" disabled={disabled || busy} onClick={onDismiss}>
          生成の記録を閉じる
        </button>
      </div>
      <ol>
        {job.rows.map((row) => {
          const index = script.lines.findIndex((line) => line.id === row.lineId);
          const changed = index < 0 || scriptAudioKey(script.lines[index]) !== row.key;
          return (
            <li key={row.lineId} aria-label={`生成記録 開始時の第${row.position}行`}>
              <strong>
                開始時の第{row.position}行 · {label[row.status]} · 試行{row.attempts}回
              </strong>
              <p>{row.text}</p>
              {row.spokenText !== row.text && <p>読み上げ文：{row.spokenText}</p>}
              {row.error && <p>失敗理由：{row.error}</p>}
              {changed ? (
                <p>この行は変更または削除されています。この記録からは再試行できません。</p>
              ) : (
                row.status !== 'succeeded' &&
                issue(script.lines[index]) && (
                  <p>生成には確認が必要です：{issue(script.lines[index])}</p>
                )
              )}
            </li>
          );
        })}
      </ol>
      <p>
        失敗時は後続の生成を止めます。成功した音声を保持し、失敗行だけの再試行と未処理・中止行を含む再開を選べます。生成条件が変わった行は、台本側から改めて生成してください。再試行中も現在の音声を保持し、成功した行から置き換えます。新しい生成を始めると記録を置き換え、台本の切り替え・ページ再読み込みで解除します。
      </p>
    </section>
  );
}
