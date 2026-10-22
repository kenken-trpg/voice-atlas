import { useState } from 'react';
import { planPronunciations, pronunciationSchema } from '../../shared/pronunciations';
import { scriptSpokenText, type VoiceScript } from '../../shared/script';
import { useProject } from '../lib/project-context';

export function PronunciationDictionary({
  script,
  disabled,
  onApply,
}: {
  script: VoiceScript;
  disabled: boolean;
  onApply: (plan: ReturnType<typeof planPronunciations>) => void;
}) {
  const { pronunciations, setPronunciations } = useProject();
  const [term, setTerm] = useState(''),
    [reading, setReading] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<ReturnType<typeof planPronunciations> | null>(null);
  const [error, setError] = useState('');
  function act(action: () => void) {
    setError('');
    try {
      action();
    } catch {
      setError('表記・読み方・重複・文字数を確認してください。台本と現在の辞書は保持しています。');
    }
  }
  const stale = pending?.source !== JSON.stringify([script, pronunciations]);
  return (
    <details className="pronunciation-dictionary">
      <summary>作品の読み方辞書</summary>
      <section aria-label="作品の読み方辞書">
        <h5>名前・地名・用語の読み方</h5>
        <p>
          最大100件。長い表記を優先して一度だけ置換します。行ごとの手動の読み上げ文を優先します。辞書の変更は作品を保存すると残ります。
        </p>
        {error && <p role="alert">{error}</p>}
        <fieldset disabled={disabled}>
          <legend>{editing ? '読み方を編集' : '読み方を追加'}</legend>
          <label>
            表記
            <input
              aria-label="辞書の表記"
              maxLength={100}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
          </label>
          <label>
            読み方
            <input
              aria-label="辞書の読み方"
              maxLength={300}
              value={reading}
              onChange={(e) => setReading(e.target.value)}
            />
          </label>
          <button
            className="secondary-button"
            disabled={!term.trim() || !reading.trim() || (!editing && pronunciations.length >= 100)}
            onClick={() =>
              act(() => {
                const item = pronunciationSchema.parse({
                  id: editing ?? crypto.randomUUID(),
                  term,
                  reading,
                });
                setPronunciations(
                  editing
                    ? pronunciations.map((p) => (p.id === editing ? item : p))
                    : [...pronunciations, item],
                );
                setTerm('');
                setReading('');
                setEditing(null);
              })
            }
          >
            読み方を辞書に反映
          </button>
          {editing && (
            <button
              className="text-button"
              onClick={() => {
                setEditing(null);
                setTerm('');
                setReading('');
              }}
            >
              読み方の編集をキャンセル
            </button>
          )}
        </fieldset>
        <ul>
          {pronunciations.map((rule) => (
            <li key={rule.id}>
              {rule.term} → {rule.reading}{' '}
              <button
                className="text-button"
                disabled={disabled}
                onClick={() => {
                  setEditing(rule.id);
                  setTerm(rule.term);
                  setReading(rule.reading);
                }}
              >
                「{rule.term}」の読み方を編集
              </button>
              <button
                className="text-button"
                disabled={disabled}
                onClick={() =>
                  act(() => {
                    setPronunciations(pronunciations.filter((p) => p.id !== rule.id));
                    if (editing === rule.id) {
                      setEditing(null);
                      setTerm('');
                      setReading('');
                    }
                  })
                }
              >
                「{rule.term}」の読み方を削除
              </button>
            </li>
          ))}
        </ul>
        <button
          className="secondary-button"
          disabled={disabled || !script.lines.length}
          onClick={() => act(() => setPending(planPronunciations(script, pronunciations)))}
        >
          辞書を適用する行を確認
        </button>
        {pending && (
          <div role="group" aria-label="辞書適用の確認">
            <p role="status">
              設定変更{pending.changedIds.length}行 / 音声再生成が必要
              {pending.audioChangedIds.length}行
            </p>
            <ul>
              {pending.script.lines
                .filter((line) => pending.changedIds.includes(line.id))
                .map((line) => (
                  <li key={line.id}>
                    {line.text} → {scriptSpokenText(line)}
                  </li>
                ))}
            </ul>
            {stale && (
              <p role="status">台本または辞書が変わりました。対象を確認し直してください。</p>
            )}
            <button
              className="secondary-button"
              disabled={disabled || stale || !pending.changedIds.length}
              onClick={() => {
                if (!stale) {
                  onApply(pending);
                  setPending(null);
                }
              }}
            >
              確認した読み方を台本に反映
            </button>
            <button className="text-button" onClick={() => setPending(null)}>
              辞書の適用をキャンセル
            </button>
          </div>
        )}
      </section>
    </details>
  );
}
