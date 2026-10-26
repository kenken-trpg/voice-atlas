import { useState } from 'react';
import { castingKey, type CastingCandidate } from '../../shared/casting';
import type { ElevenLabsVoicePage } from '../../shared/elevenlabs';

type Voice = ElevenLabsVoicePage['voices'][number];
const categories: Record<string, string> = {
  premade: '既定の声',
  cloned: '複製した声',
  generated: 'デザインした声',
  professional: 'プロの声',
  high_quality: 'スタジオ品質の声',
};
const categoryLabel = (category?: string) =>
  category ? (categories[category] ?? 'その他の声') : '種別不明';

export function ElevenLabsVoiceResults({
  voices,
  candidates,
  searched,
  resultsSearch,
  queryChanged,
  loading,
  disabled,
  canAdd,
  hasMore,
  onMore,
  onAdd,
}: {
  voices: Voice[];
  candidates: Record<string, CastingCandidate>;
  searched: boolean;
  resultsSearch: string;
  queryChanged: boolean;
  loading: boolean;
  disabled: boolean;
  canAdd: boolean;
  hasMore: boolean;
  onMore: () => void;
  onAdd: (voice: Voice) => void;
}) {
  const [category, setCategory] = useState('all');
  const [added, setAdded] = useState('all');
  const [sort, setSort] = useState('received');
  const groups = [...new Set(voices.map((voice) => voice.category ?? 'unknown'))];
  const effectiveCategory = groups.includes(category) ? category : 'all';
  const filtered = voices.filter(
    (voice) =>
      (effectiveCategory === 'all' || (voice.category ?? 'unknown') === effectiveCategory) &&
      (added === 'all' || Boolean(candidates[castingKey(voice)]) === (added === 'added')),
  );
  if (sort === 'name')
    filtered.sort(
      (a, b) => a.name.localeCompare(b.name, 'ja') || a.voiceId.localeCompare(b.voiceId),
    );
  if (!searched) return null;
  return (
    <div className="eleven-voice-results" aria-busy={loading}>
      <p role="status">
        {resultsSearch ? `「${resultsSearch}」の検索結果` : '声の検索結果'}：{voices.length}件取得・
        {filtered.length}件表示
      </p>
      {queryChanged && (
        <p className="footnote">検索欄を変更しています。検索を実行すると結果を更新します。</p>
      )}
      {!!voices.length && (
        <div className="casting-filter-controls">
          <label>
            声の種別
            <select
              aria-label="声の種別"
              value={effectiveCategory}
              disabled={disabled}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="all">すべての種別</option>
              {groups.map((group) => (
                <option key={group} value={group}>
                  {categoryLabel(group === 'unknown' ? undefined : group)}
                </option>
              ))}
            </select>
          </label>
          <label>
            追加状況
            <select
              aria-label="追加状況"
              value={added}
              disabled={disabled}
              onChange={(event) => setAdded(event.target.value)}
            >
              <option value="all">すべての声</option>
              <option value="unadded">未追加の声</option>
              <option value="added">追加済みの声</option>
            </select>
          </label>
          <label>
            声の並び順
            <select
              aria-label="声の並び順"
              value={sort}
              disabled={disabled}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="received">取得した順</option>
              <option value="name">名前順</option>
            </select>
          </label>
        </div>
      )}
      {!voices.length ? (
        <p>検索条件に一致する声がありません。</p>
      ) : !filtered.length ? (
        <p>表示条件に一致する声がありません。声の種別・追加状況を変更してください。</p>
      ) : (
        <ul className="eleven-voice-grid" aria-label="ElevenLabsの声の検索結果">
          {filtered.map((voice) => {
            const isAdded = Boolean(candidates[castingKey(voice)]);
            return (
              <li key={voice.voiceId} className="eleven-voice-card">
                <div>
                  <strong>{voice.name}</strong>
                  <span className="casting-tag">{categoryLabel(voice.category)}</span>
                </div>
                <details>
                  <summary>声IDを見る</summary>
                  <small>{voice.voiceId}</small>
                </details>
                <button
                  className="secondary-button"
                  disabled={disabled || isAdded || !canAdd}
                  onClick={() => onAdd(voice)}
                >
                  {isAdded ? '追加済み' : '比較候補に追加'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {hasMore && !queryChanged && voices.length < 200 && (
        <button className="secondary-button" disabled={disabled || loading} onClick={onMore}>
          {loading ? '声を取得中…' : '次の声を表示'}
        </button>
      )}
      {voices.length >= 200 && hasMore && (
        <p className="footnote">声の表示は200件までです。検索語で絞り込んでください。</p>
      )}
    </div>
  );
}
