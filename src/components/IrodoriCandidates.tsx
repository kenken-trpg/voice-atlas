import { useEffect, useRef, useState } from 'react';
import {
  irodoriCandidates,
  irodoriAssignmentsSchema,
  irodoriModel,
  irodoriModelRevision,
  type IrodoriAssignment,
  type IrodoriVoiceId,
} from '../../shared/irodori-candidates';
import { useProject, useProjectPart } from '../lib/project-context';
import { readIrodoriAudio, saveIrodoriAudio } from '../lib/irodori-audio-store';
import { pauseOtherAudio } from './ComparisonPanel';

export function IrodoriCandidates() {
  const { initial } = useProject();
  const [selected, setSelected] = useState<IrodoriVoiceId[]>(
    initial?.documents.irodoriCandidates ?? [],
  );
  const [assignments, setAssignments] = useState<IrodoriAssignment[]>(
    initial?.documents.irodoriAssignments ?? [],
  );
  const [editing, setEditing] = useState<string | null>(null);
  const [character, setCharacter] = useState('');
  const [voiceId, setVoiceId] = useState<IrodoriVoiceId | ''>('');
  const [reason, setReason] = useState('');
  const [audio, setAudio] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const urls = useRef<string[]>([]);

  useProjectPart('irodoriCandidates', () => selected, busy);
  useProjectPart('irodoriAssignments', () => assignments, busy);

  function setAudioUrls(blobs: Record<string, Blob>) {
    const next = Object.fromEntries(
      Object.entries(blobs).map(([key, blob]) => [key, URL.createObjectURL(blob)]),
    );
    const previous = urls.current;
    urls.current = Object.values(next);
    setAudio(next);
    previous.forEach((url) => URL.revokeObjectURL(url));
  }

  useEffect(() => {
    let active = true;
    readIrodoriAudio()
      .then((blobs) => {
        if (active) setAudioUrls(blobs);
      })
      .catch(() => {
        if (active) setError('ブラウザ内のIrodori音声を読み込めませんでした。');
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      urls.current.forEach((url) => URL.revokeObjectURL(url));
      urls.current = [];
    };
  }, []);

  async function importAudio(files?: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const count = await saveIrodoriAudio(Array.from(files));
      setAudioUrls(await readIrodoriAudio());
      setMessage(`${count}件の音声をブラウザに保存しました。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '音声を読み込めませんでした。');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function importLocalAudio() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const samples = irodoriCandidates.flatMap((voice) => [...voice.samples]);
      const files: File[] = [];
      for (const sample of samples) {
        const response = await fetch(`/api/irodori-samples/${sample.sha256}`);
        if (!response.ok)
          throw new Error('この端末に検証済みWAVがありません。ファイルから読み込んでください。');
        files.push(new File([await response.blob()], sample.file, { type: 'audio/wav' }));
      }
      const count = await saveIrodoriAudio(files);
      setAudioUrls(await readIrodoriAudio());
      setMessage(`${count}件の検証音声をブラウザに保存しました。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '検証音声を読み込めませんでした。');
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: IrodoriVoiceId) {
    if (selected.includes(id) && assignments.some((item) => item.voiceId === id)) {
      setError('この声には仮配役があります。先に仮配役を変更または削除してください。');
      return;
    }
    setError('');
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
    setMessage('候補を変更しました。作品を保存すると、選択した声のIDが作品JSONに入ります。');
  }

  function clearForm() {
    setEditing(null);
    setCharacter('');
    setVoiceId('');
    setReason('');
  }

  function saveAssignment() {
    try {
      const item = { character, voiceId, reason };
      if (!selected.includes(item.voiceId as IrodoriVoiceId))
        throw new Error('作品の候補に保存した声を選んでください。');
      const parsed = irodoriAssignmentsSchema.safeParse([
        ...assignments.filter((entry) => entry.character !== editing),
        item,
      ]);
      if (!parsed.success)
        throw new Error(parsed.error.issues[0]?.message ?? '仮配役を保存できませんでした。');
      setAssignments(parsed.data);
      clearForm();
      setError('');
      setMessage('仮配役を更新しました。作品を保存すると記録されます。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '仮配役を保存できませんでした。');
    }
  }

  return (
    <section className="irodori-candidates" aria-label="Irodori生成済みの声を比較">
      <div className="section-heading">
        <div>
          <span className="eyebrow">IRODORI VOICE DESIGN</span>
          <h2>生成済みの3つの声を比較</h2>
        </div>
      </div>
      <p>
        2026年10月24日のv4.1-Small検証音声です。基準の声と別の台詞を聴き比べ、作品で使いたい候補を選べます。新しい台詞の生成には対応していません。
      </p>
      <p>
        音声はこのブラウザに保存します。作品JSONには選んだ声のIDが入り、WAVは含まれません。別のブラウザへ音声も移す場合は音声付き作品アーカイブを使えます。
      </p>
      <div className="casting-actions">
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => void importLocalAudio()}
        >
          この端末の検証音声を読み込む
        </button>
        <button className="secondary-button" disabled={busy} onClick={() => input.current?.click()}>
          検証済みWAVを読み込む
        </button>
        <input
          ref={input}
          type="file"
          hidden
          multiple
          accept=".wav,audio/wav,audio/x-wav"
          aria-label="IrodoriのWAVファイル"
          onChange={(event) => void importAudio(event.target.files)}
        />
        <span>6件のWAVをまとめて選択できます。</span>
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div className="irodori-candidate-grid">
        {irodoriCandidates.map((voice) => (
          <article key={voice.id} className="irodori-candidate-card">
            <h3>{voice.name}</h3>
            <p>{voice.caption}</p>
            <p>試聴記録：{voice.review}</p>
            {voice.samples.map((sample) => (
              <div key={sample.sha256}>
                <strong>{sample.label}</strong>
                {audio[sample.sha256] ? (
                  <audio
                    controls
                    src={audio[sample.sha256]}
                    onPlay={pauseOtherAudio}
                    aria-label={`${voice.name}・${sample.label}`}
                  />
                ) : (
                  <p>音声未読み込み：{sample.file}</p>
                )}
              </div>
            ))}
            <button
              className="secondary-button"
              disabled={busy}
              aria-pressed={selected.includes(voice.id)}
              onClick={() => toggle(voice.id)}
            >
              {selected.includes(voice.id) ? '候補から外す' : '作品の候補に保存'}
            </button>
          </article>
        ))}
      </div>
      <p role="status">この作品の候補：{selected.length}件 / 3件</p>
      <section className="irodori-assignments" aria-label="Irodoriの仮配役">
        <h3>キャラクターへの仮配役</h3>
        <p>
          作品の候補声をキャラクターに結び付け、理由とともに記録します。台本の音声生成にはまだ使いません。
        </p>
        <div className="irodori-assignment-list">
          {assignments.length === 0 && <p>仮配役はまだありません。</p>}
          {assignments.map((item) => {
            const voice = irodoriCandidates.find((candidate) => candidate.id === item.voiceId)!;
            const sample = voice.samples[0];
            return (
              <article key={item.character}>
                <h4>
                  {item.character}：{voice.name}
                </h4>
                {item.reason && <p>理由：{item.reason}</p>}
                {audio[sample.sha256] ? (
                  <audio
                    controls
                    src={audio[sample.sha256]}
                    onPlay={pauseOtherAudio}
                    aria-label={`${item.character}の仮配役音声`}
                  />
                ) : (
                  <p>試聴音声は未読み込みです。</p>
                )}
                <div className="casting-actions">
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => {
                      setEditing(item.character);
                      setCharacter(item.character);
                      setVoiceId(item.voiceId);
                      setReason(item.reason);
                      setError('');
                    }}
                  >
                    編集
                  </button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => {
                      setAssignments((current) =>
                        current.filter((entry) => entry.character !== item.character),
                      );
                      if (editing === item.character) clearForm();
                      setMessage('仮配役を削除しました。作品を保存すると反映されます。');
                    }}
                  >
                    削除
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        <fieldset disabled={busy || selected.length === 0}>
          <legend>{editing ? '仮配役を編集' : '仮配役を追加'}</legend>
          <label>
            キャラクター名
            <input
              aria-label="仮配役のキャラクター名"
              maxLength={100}
              value={character}
              onChange={(event) => setCharacter(event.target.value)}
            />
          </label>
          <label>
            候補声
            <select
              aria-label="仮配役の候補声"
              value={voiceId}
              onChange={(event) => setVoiceId(event.target.value as IrodoriVoiceId | '')}
            >
              <option value="">声を選択</option>
              {irodoriCandidates
                .filter((voice) => selected.includes(voice.id))
                .map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            採用理由・メモ
            <textarea
              aria-label="仮配役の理由"
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="casting-actions">
            <button disabled={!character.trim() || !voiceId} onClick={saveAssignment}>
              {editing ? '仮配役を更新' : '仮配役を保存'}
            </button>
            {editing && (
              <button className="secondary-button" onClick={clearForm}>
                編集を取り消す
              </button>
            )}
          </div>
        </fieldset>
      </section>
      <small>
        モデル：{irodoriModel}（リビジョン {irodoriModelRevision}）
      </small>
    </section>
  );
}
