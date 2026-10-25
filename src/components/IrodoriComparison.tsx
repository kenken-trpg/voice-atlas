import { useState, type Dispatch, type SetStateAction } from 'react';
import {
  irodoriAssignmentsSchema,
  irodoriCandidates,
  irodoriComparisonsSchema,
  type IrodoriAssignment,
  type IrodoriComparison,
  type IrodoriVoiceId,
} from '../../shared/irodori-candidates';
import { pauseOtherAudio } from './ComparisonPanel';

export function IrodoriComparison({
  selected,
  comparisons,
  setComparisons,
  assignments,
  setAssignments,
  audio,
  busy,
}: {
  selected: IrodoriVoiceId[];
  comparisons: IrodoriComparison[];
  setComparisons: Dispatch<SetStateAction<IrodoriComparison[]>>;
  assignments: IrodoriAssignment[];
  setAssignments: Dispatch<SetStateAction<IrodoriAssignment[]>>;
  audio: Record<string, string>;
  busy: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [character, setCharacter] = useState('');
  const [voiceIds, setVoiceIds] = useState<IrodoriVoiceId[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function open(item: IrodoriComparison) {
    setEditing(item.character);
    setCharacter(item.character);
    setVoiceIds(item.voiceIds);
    setNote(item.note);
    setError('');
    setMessage('');
  }

  function clear() {
    setEditing(null);
    setCharacter('');
    setVoiceIds([]);
    setNote('');
  }

  function save(chosen?: IrodoriVoiceId) {
    const item = { character, voiceIds, note };
    const parsed = irodoriComparisonsSchema.safeParse([
      ...comparisons.filter((entry) => entry.character !== editing),
      item,
    ]);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '比較を保存できませんでした。');
      return;
    }
    if (voiceIds.some((id) => !selected.includes(id))) {
      setError('作品の候補に保存した声だけを比較できます。');
      return;
    }
    let nextAssignments: IrodoriAssignment[] | null = null;
    if (chosen) {
      if (!voiceIds.includes(chosen)) {
        setError('比較中の声を選んでください。');
        return;
      }
      const result = irodoriAssignmentsSchema.safeParse([
        ...assignments.filter((entry) => entry.character !== item.character.trim()),
        { character: item.character, voiceId: chosen, reason: item.note },
      ]);
      if (!result.success) {
        setError(result.error.issues[0]?.message ?? '仮配役を保存できませんでした。');
        return;
      }
      nextAssignments = result.data;
    }
    setComparisons(parsed.data);
    if (nextAssignments) setAssignments(nextAssignments);
    setError('');
    setMessage(
      chosen
        ? '比較記録と仮配役を更新しました。作品を保存すると記録されます。'
        : '比較記録を更新しました。作品を保存すると記録されます。',
    );
    clear();
  }

  return (
    <section className="irodori-comparison" aria-label="キャラクターごとのIrodori比較">
      <h3>キャラクターごとに聴き比べる</h3>
      <p>
        作品の候補から2〜3声を選び、保存済みの基準音声と別台詞を並べて試聴します。音声ごとに台詞が異なるため、声の印象を比較してください。
      </p>
      {comparisons.length > 0 && (
        <div className="irodori-comparison-history">
          {comparisons.map((item) => {
            const assignment = assignments.find((entry) => entry.character === item.character);
            return (
              <article key={item.character}>
                <strong>{item.character}</strong>
                <p>
                  比較した声：
                  {item.voiceIds
                    .map((id) => irodoriCandidates.find((voice) => voice.id === id)!.name)
                    .join('・')}
                </p>
                {item.note && <p>比較メモ：{item.note}</p>}
                {assignment && (
                  <p>
                    現在の仮配役：
                    {irodoriCandidates.find((voice) => voice.id === assignment.voiceId)!.name}
                  </p>
                )}
                <div className="casting-actions">
                  <button className="secondary-button" disabled={busy} onClick={() => open(item)}>
                    比較を開く
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => {
                      setComparisons((current) =>
                        current.filter((entry) => entry.character !== item.character),
                      );
                      if (editing === item.character) clear();
                      setMessage('比較記録を削除しました。作品を保存すると反映されます。');
                      setError('');
                    }}
                  >
                    比較記録を削除
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <fieldset disabled={busy || selected.length < 2}>
        <legend>{editing ? `${editing}の比較を編集` : '新しい比較'}</legend>
        {selected.length < 2 && <p>比較するには作品の候補声を2つ以上保存してください。</p>}
        <label>
          キャラクター名
          <input
            aria-label="比較するキャラクター名"
            maxLength={100}
            readOnly={editing !== null}
            value={character}
            onChange={(event) => setCharacter(event.target.value)}
          />
        </label>
        <div role="group" aria-label="比較する候補声">
          {irodoriCandidates
            .filter((voice) => selected.includes(voice.id))
            .map((voice) => (
              <label key={voice.id}>
                <input
                  type="checkbox"
                  checked={voiceIds.includes(voice.id)}
                  onChange={(event) => {
                    setVoiceIds((current) =>
                      event.target.checked
                        ? [...current, voice.id]
                        : current.filter((id) => id !== voice.id),
                    );
                  }}
                />
                {voice.name}
              </label>
            ))}
        </div>
        <div className="irodori-comparison-voices">
          {irodoriCandidates
            .filter((voice) => voiceIds.includes(voice.id))
            .map((voice) => (
              <article key={voice.id}>
                <h4>{voice.name}</h4>
                {voice.samples.map((sample) => (
                  <div key={sample.sha256}>
                    <strong>{sample.label}</strong>
                    {audio[sample.sha256] ? (
                      <audio
                        controls
                        src={audio[sample.sha256]}
                        onPlay={pauseOtherAudio}
                        aria-label={`${character || '比較中のキャラクター'}・${voice.name}・${sample.label}`}
                      />
                    ) : (
                      <p>音声未読み込み：{sample.file}</p>
                    )}
                  </div>
                ))}
                <button
                  disabled={!character.trim() || voiceIds.length < 2}
                  onClick={() => save(voice.id)}
                >
                  この声に仮配役
                </button>
              </article>
            ))}
        </div>
        <label>
          比較メモ
          <textarea
            aria-label="Irodoriの比較メモ"
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <div className="casting-actions">
          <button
            className="secondary-button"
            disabled={!character.trim() || voiceIds.length < 2}
            onClick={() => save()}
          >
            比較メモを保存
          </button>
          {(editing || character || voiceIds.length > 0 || note) && (
            <button className="secondary-button" onClick={clear}>
              新しい比較に戻す
            </button>
          )}
        </div>
      </fieldset>
    </section>
  );
}
