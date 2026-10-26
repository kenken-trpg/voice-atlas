import { useRef, useState } from 'react';
import { type CastingAssignment } from '../../shared/casting-board';
import { type VoiceScript, scriptCandidate } from '../../shared/script';
import {
  makeImportedScript,
  maxScriptImportBytes,
  parseScriptImport,
  resolveScriptImport,
  scopedImportAssignments,
  type ImportedDialogue,
  type ScriptImportFormat,
} from '../../shared/script-import';
import { castingCandidateSchema, castingKey, type CastingInventory } from '../../shared/casting';
export function ScriptImport({
  assignments,
  disabled,
  gapMs,
  inventory,
  checking,
  onImport,
}: {
  assignments: CastingAssignment[];
  disabled: boolean;
  gapMs: number;
  inventory: CastingInventory | null;
  checking: boolean;
  onImport: (script: VoiceScript) => void;
}) {
  const [format, setFormat] = useState<ScriptImportFormat>('text');
  const [source, setSource] = useState('');
  const [title, setTitle] = useState('取り込み台本');
  const [rows, setRows] = useState<ImportedDialogue[] | null>(null);
  const [allowUnassigned, setAllowUnassigned] = useState(false);
  const [mapping, setMapping] = useState(new Map<string, string>());
  const [project, setProject] = useState(''),
    [scene, setScene] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const importing = useRef(false),
    fileRef = useRef<HTMLInputElement>(null);
  const locked = disabled || loading;
  const scope = { project, scene };
  const options = scopedImportAssignments(assignments, scope);
  const resolved = rows
    ? resolveScriptImport(rows, assignments, scope, mapping, allowUnassigned)
    : [];
  const characters = [...new Set(rows?.map((row) => row.character.trim()).filter(Boolean))];
  function invalidate() {
    setRows(null);
    setMapping(new Map());
    setError('');
  }
  function preview(value = source, mode = format) {
    try {
      setRows(parseScriptImport(value, mode));
      setMapping(new Map());
      setError('');
    } catch (e) {
      setRows(null);
      setMapping(new Map());
      setError(e instanceof Error ? e.message : '入力の形式を確認してください。');
    }
  }
  async function readCsv(file?: File) {
    if (!file || locked || importing.current) return;
    importing.current = true;
    setLoading(true);
    invalidate();
    try {
      if (file.size > maxScriptImportBytes)
        throw new Error('CSVファイルは64KiB以下にしてください。');
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw new Error('CSVをUTF-8で保存し直してください。');
      }
      setSource(text);
      setFormat('csv');
      preview(text, 'csv');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'CSVを読み込めませんでした。');
    } finally {
      importing.current = false;
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  function availability(assignment: CastingAssignment) {
    const candidate = scriptCandidate({ id: assignment.id, text: '', assignment })!;
    if (!castingCandidateSchema.safeParse(candidate).success) return '現行カタログ対象外';
    if (checking) return '確認中';
    if (inventory?.voices.some((voice) => castingKey(voice) === castingKey(candidate.voice)))
      return '試聴可能';
    return inventory?.engines.find((engine) => engine.engine === candidate.voice.engine)?.ready
      ? '未導入'
      : '未接続';
  }
  return (
    <details className="script-import">
      <summary>テキスト・CSVから台本を取り込む</summary>
      <section aria-label="台本の一括取り込み">
        <h5>台本の一括取り込みと声の対応付け</h5>
        <p>
          テキストは「案内人：ようこそ。」の形式で1発言1行。CSVは先頭行に「キャラクター名,セリフ」の2列を指定します。20行・各セリフ300文字、入力は64KiBまでです。CSVファイルはUTF-8に対応します。
        </p>
        <p>
          名前が完全一致する確定設定が絞り込み内に1件だけある場合は自動で対応付けます。複数候補や未登録の名前は、声を選んでください。同じ名前の全行に同じ声を使います。
        </p>
        {error && <p role="alert">{error}</p>}
        <label>
          入力形式
          <select
            aria-label="台本取り込みの形式"
            disabled={locked}
            value={format}
            onChange={(event) => {
              setFormat(event.target.value as ScriptImportFormat);
              invalidate();
            }}
          >
            <option value="text">テキスト（名前：セリフ）</option>
            <option value="csv">CSV（キャラクター名・セリフ）</option>
          </select>
        </label>
        <label>
          台本の入力
          <textarea
            aria-label="一括取り込みの入力"
            value={source}
            disabled={locked}
            onChange={(event) => {
              setSource(event.target.value);
              invalidate();
            }}
            placeholder={'案内人：ようこそ。\n騎士：案内を頼もう。'}
          />
        </label>
        <div className="casting-actions">
          <button className="secondary-button" disabled={locked} onClick={() => preview()}>
            取り込み内容を確認
          </button>
          <button
            className="secondary-button"
            disabled={locked}
            onClick={() => fileRef.current?.click()}
          >
            CSVファイルを読み込む
          </button>
          <input
            ref={fileRef}
            hidden
            type="file"
            accept=".csv,text/csv"
            aria-label="台本取り込みCSVファイル"
            onChange={(event) => void readCsv(event.target.files?.[0])}
          />
        </div>
        {rows && (
          <>
            <label>
              取り込む台本名
              <input
                aria-label="取り込む台本名"
                value={title}
                maxLength={100}
                disabled={locked}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <label>
              作品で絞り込み
              <select
                aria-label="取り込み候補の作品"
                value={project}
                disabled={locked}
                onChange={(event) => {
                  setProject(event.target.value);
                  setScene('');
                  setMapping(new Map());
                }}
              >
                <option value="">すべての作品</option>
                {[...new Set(assignments.map((item) => item.project))].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              場面で絞り込み
              <select
                aria-label="取り込み候補の場面"
                value={scene}
                disabled={locked}
                onChange={(event) => {
                  setScene(event.target.value);
                  setMapping(new Map());
                }}
              >
                <option value="">すべての場面</option>
                {[
                  ...new Set(
                    assignments
                      .filter((item) => !project || item.project === project)
                      .map((item) => item.scene),
                  ),
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <fieldset disabled={locked}>
              <legend>キャラクター名と確定した声の対応</legend>
              {characters.map((name) => {
                const match = resolved.find((item) => item.row.character.trim() === name)!;
                return (
                  <label key={name}>
                    {name}：
                    {match.matches.length === 1
                      ? '完全一致1件'
                      : match.matches.length > 1
                        ? '同名候補が複数あります'
                        : '一致候補なし・手動で選択'}
                    <select
                      aria-label={`「${name}」に割り当てる声`}
                      value={match.selected?.id ?? ''}
                      onChange={(event) =>
                        setMapping((previous) => new Map(previous).set(name, event.target.value))
                      }
                    >
                      <option value="">声を選択してください</option>
                      {options.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.project} / {item.character} / {item.scene} · {availability(item)}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </fieldset>
            <label className="script-import-unassigned">
              <input
                type="checkbox"
                checked={allowUnassigned}
                disabled={locked}
                onChange={(event) => setAllowUnassigned(event.target.checked)}
              />
              声を選んでいない発話者は未配役のまま取り込む
            </label>
            <p className="footnote">
              未配役で取り込んだ行は、台本の「未配役の発話者に声を割り当てる」でまとめて配役できます。名前・セリフのエラーは修正が必要です。
            </p>
            <p role="status">
              取り込み確認：{rows.length}行 / 要修正
              {resolved.filter((item) => item.issues.length).length}行
            </p>
            <p>
              以下のプレビューで名前・セリフを修正できます。修正は元の入力欄に戻しません。元の入力や形式を変更すると、プレビューと声の選択をやり直します。反映は既存の台本を置き換え、行間
              {gapMs}msを引き継ぎます。
            </p>
            <ol className="evaluation-history">
              {resolved.map((item, index) => (
                <li key={index} aria-label={`取り込みの第${index + 1}行`}>
                  <label>
                    キャラクター名
                    <input
                      aria-label={`取り込み第${index + 1}行の名前`}
                      value={item.row.character}
                      disabled={locked}
                      onChange={(event) =>
                        setRows(
                          rows.map((row, at) =>
                            at === index ? { ...row, character: event.target.value } : row,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    セリフ
                    <textarea
                      aria-label={`取り込み第${index + 1}行のセリフ`}
                      value={item.row.text}
                      disabled={locked}
                      onChange={(event) =>
                        setRows(
                          rows.map((row, at) =>
                            at === index ? { ...row, text: event.target.value } : row,
                          ),
                        )
                      }
                    />
                  </label>
                  <p>
                    {item.row.text.length} / 300文字 ·{' '}
                    {item.selected
                      ? `${item.selected.character} / ${item.selected.scene} · ${availability(item.selected)}`
                      : '声が未割り当てです'}
                  </p>
                  {item.issues.map((issue) => (
                    <p key={issue} className="import-issue">
                      {issue}
                    </p>
                  ))}
                </li>
              ))}
            </ol>
            <button
              className="secondary-button"
              disabled={locked || !title.trim() || resolved.some((item) => item.issues.length)}
              onClick={() => {
                try {
                  const script = makeImportedScript(
                    title,
                    gapMs,
                    rows,
                    assignments,
                    scope,
                    mapping,
                    allowUnassigned,
                  );
                  setError('');
                  onImport(script);
                } catch (e) {
                  setError(
                    e instanceof Error && e.message.length < 250
                      ? e.message
                      : '台本を反映できませんでした。現在の台本は保持しています。',
                  );
                }
              }}
            >
              確認した内容を台本に反映
            </button>
            <p>
              反映だけでは音声を生成しません。未導入・未接続の声も設定として取り込めますが、生成するには接続と導入が必要です。未保存の変更があれば、台本ライブラリの確認欄で保存・破棄・キャンセルを選んでください。
            </p>
          </>
        )}
      </section>
    </details>
  );
}
