import { scriptCandidate, scriptSpokenText, type ScriptLine } from '../../shared/script';
import type { CastingCandidate } from '../../shared/casting';
import type { AivisModelInfo } from '../../shared/aivis-model-info';

export function ScriptGenerationPlan({
  lines,
  reusable,
  excluded,
  disabled,
  issue,
  currentModel,
  onToggle,
}: {
  lines: ScriptLine[];
  reusable: (line: ScriptLine) => boolean;
  excluded: string[];
  disabled: boolean;
  issue: (line: ScriptLine) => string | null;
  currentModel: (candidate: CastingCandidate) => AivisModelInfo | undefined;
  onToggle: (id: string) => void;
}) {
  const targets = lines.filter((line) => !reusable(line) && !excluded.includes(line.id));
  const retained = lines.filter(reusable).length;
  return (
    <section className="script-generation" aria-label="生成前の対象確認">
      <h5>今回生成する行を確認</h5>
      <p role="status">
        生成対象{targets.length}行 · 読み上げ文
        {targets.reduce((sum, line) => sum + Array.from(scriptSpokenText(line)).length, 0)}文字 ·
        音声を再利用{retained}行 · 対象外{lines.length - targets.length - retained}行
      </p>
      <p>
        未生成・読み上げ条件が変わった行が対象です。音声がある行は再利用し、送信しません。文字数は読み上げ文の文字数です。
      </p>
      <ol>
        {lines.map((line, index) => {
          const cached = reusable(line);
          const candidate = scriptCandidate(line);
          const model = candidate ? currentModel(candidate) : undefined;
          const problem = cached ? null : issue(line);
          return (
            <li key={line.id} aria-label={`生成予定 第${index + 1}行`}>
              {cached ? (
                <strong>第{index + 1}行 · 音声を再利用（送信なし）</strong>
              ) : (
                <label>
                  <input
                    type="checkbox"
                    aria-label={`第${index + 1}行を生成対象に含める`}
                    checked={!excluded.includes(line.id)}
                    disabled={disabled}
                    onChange={() => onToggle(line.id)}
                  />
                  第{index + 1}行 · {excluded.includes(line.id) ? '今回は生成しない' : '生成対象'}
                </label>
              )}
              <p>
                {line.character ?? line.assignment?.character ?? '発話者未設定'} ·{' '}
                {candidate ? `${candidate.voice.engine} / ${candidate.voice.name}` : '声が未設定'}
              </p>
              {candidate && (
                <p>
                  モデル：
                  {candidate.recipe.engine === 'ElevenLabs'
                    ? candidate.recipe.modelId
                    : model
                      ? `${model.modelName} ${model.modelVersion}`
                      : candidate.voice.engine === 'VOICEVOX'
                        ? '接続中のVOICEVOXエンジン'
                        : '現在のモデル情報は未取得'}
                </p>
              )}
              {!cached && (
                <p>
                  読み上げ文（{Array.from(scriptSpokenText(line)).length}文字）：
                  {scriptSpokenText(line) || '未入力'}
                </p>
              )}
              {problem && <p>生成には確認が必要です：{problem}</p>}
            </li>
          );
        })}
      </ol>
      <p>
        対象を選ぶだけでは生成しません。「未生成の行を台本順に生成」で選択した行を送信します。行別生成・差し替え生成・再試行は、それぞれの操作の対象を使います。
      </p>
    </section>
  );
}
