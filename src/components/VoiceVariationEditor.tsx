import { useState } from 'react';
import { makeVoiceVariation, type VoiceLibraryEntry } from '../../shared/voice-library';
import { type CastingCandidate, type generationSchema } from '../../shared/casting';
import { type CharacterInput, type Profile } from '../../shared/schema';

export function VoiceVariationEditor({
  parent,
  candidate,
  text,
  generation,
  context,
  ready,
  disabled,
  onSave,
}: {
  parent: VoiceLibraryEntry;
  candidate: CastingCandidate;
  text: string;
  generation: ReturnType<typeof generationSchema.parse> | null;
  context: { profile: Profile; characterInput: CharacterInput | null };
  ready: boolean;
  disabled: boolean;
  onSave: (entry: VoiceLibraryEntry) => void;
}) {
  const [setting, setSetting] = useState('');
  const [reason, setReason] = useState('');
  const [memo, setMemo] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  return (
    <fieldset className="voice-variation" disabled={disabled}>
      <legend>調整した声を別設定として保存</legend>
      <p>
        派生元：{parent.characterName} / {parent.settingName}
      </p>
      <p>
        候補の現在の設定で音声を生成・試聴してから保存してください。元の登録と比較評価は保持します。
      </p>
      <label>
        新しい設定名
        <input
          aria-label="派生声の設定名"
          maxLength={100}
          value={setting}
          onChange={(e) => {
            setSetting(e.target.value);
            setNotice('');
          }}
        />
      </label>
      <label>
        変更理由
        <textarea
          aria-label="派生声の変更理由"
          maxLength={1000}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setNotice('');
          }}
        />
      </label>
      <label>
        メモ
        <textarea
          aria-label="派生声のメモ"
          maxLength={1000}
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />
      </label>
      {!ready && <p>現在の調声値・セリフの音声生成が必要です。</p>}
      <button
        className="secondary-button"
        disabled={
          !ready || !setting.trim() || setting.trim() === parent.settingName || !reason.trim()
        }
        onClick={() => {
          setError('');
          setNotice('');
          try {
            onSave(
              makeVoiceVariation(
                parent,
                { candidate, text, generation, ...context, reason },
                setting,
                memo,
              ),
            );
            setNotice('別設定として保存しました。元の登録は保持しています。');
            setSetting('');
          } catch {
            setError(
              '保存できませんでした。登録件数・入力内容・ブラウザの保存容量を確認してください。元の登録は保持しています。',
            );
          }
        }}
      >
        調整した声を別設定で保存
      </button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </fieldset>
  );
}
