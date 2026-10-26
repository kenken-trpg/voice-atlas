import { useState } from 'react';
import type { CastingCandidate } from '../../shared/casting';
import type { ElevenLabsModel } from '../../shared/elevenlabs';

export function ElevenLabsCandidateManager({
  candidates,
  models,
  slots,
  selected,
  ready,
  disabled,
  onAssign,
  onRemove,
}: {
  candidates: Record<string, CastingCandidate>;
  models: ElevenLabsModel[];
  slots: [string | null, string | null];
  selected: string | null;
  ready: Set<string>;
  disabled: boolean;
  onAssign: (key: string, slot: 0 | 1) => void;
  onRemove: (key: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('added');
  const cloud = Object.entries(candidates).filter(
    ([, candidate]) => candidate.voice.engine === 'ElevenLabs',
  );
  const filtered = cloud.filter(([, candidate]) => {
    const recipe = candidate.recipe;
    return [
      candidate.voice.name,
      candidate.voice.engine === 'ElevenLabs' ? candidate.voice.voiceId : '',
      candidate.recipe.engine === 'ElevenLabs' ? candidate.recipe.modelId : '',
      recipe.engine === 'ElevenLabs'
        ? (models.find((model) => model.modelId === recipe.modelId)?.name ?? '')
        : '',
    ]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase());
  });
  if (sort === 'name')
    filtered.sort(
      (a, b) => a[1].voice.name.localeCompare(b[1].voice.name, 'ja') || a[0].localeCompare(b[0]),
    );
  return (
    <section className="casting-candidate-manager" aria-label="追加したElevenLabsの比較候補">
      <h3>追加したElevenLabsの比較候補</h3>
      <p className="footnote">
        A・Bに使う候補を選べます。候補から削除すると現在の調声と試聴音声を外します。記録済みの評価と採用声ライブラリは保持します。
      </p>
      {!!cloud.length && (
        <div className="casting-filter-controls">
          <label>
            追加した候補を検索
            <input
              type="search"
              value={query}
              maxLength={200}
              disabled={disabled}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="声の名前・モデル名"
            />
          </label>
          <label>
            候補の並び順
            <select
              aria-label="候補の並び順"
              value={sort}
              disabled={disabled}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="added">追加した順</option>
              <option value="name">名前順</option>
            </select>
          </label>
        </div>
      )}
      <p role="status">
        ElevenLabsの比較候補：{cloud.length}件・{filtered.length}件表示
      </p>
      {!cloud.length ? (
        <p>検索結果から声を追加してください。</p>
      ) : !filtered.length ? (
        <p>検索条件に一致する比較候補がありません。</p>
      ) : (
        <ul className="eleven-voice-grid" aria-label="追加済みのElevenLabsの比較候補">
          {filtered.map(([key, candidate]) => {
            const modelId =
              candidate.recipe.engine === 'ElevenLabs' ? candidate.recipe.modelId : '';
            const model = models.find((item) => item.modelId === modelId);
            return (
              <li key={key} className="eleven-voice-card">
                <div>
                  <strong>{candidate.voice.name}</strong>
                  {slots.map(
                    (slotKey, index) =>
                      slotKey === key && (
                        <span key={index} className="casting-tag">
                          候補{index === 0 ? 'A' : 'B'}
                        </span>
                      ),
                  )}
                  {selected === key && <span className="casting-tag">保存対象</span>}
                </div>
                <p>合成モデル：{model?.name ?? modelId}</p>
                {ready.has(key) && <p className="footnote">現在の設定で生成済み</p>}
                <div className="casting-card-actions">
                  <button
                    className="secondary-button"
                    disabled={disabled || slots[0] === key}
                    onClick={() => onAssign(key, 0)}
                  >
                    候補Aで比較
                  </button>
                  <button
                    className="secondary-button"
                    disabled={disabled || slots[1] === key}
                    onClick={() => onAssign(key, 1)}
                  >
                    候補Bで比較
                  </button>
                  <button className="text-button" disabled={disabled} onClick={() => onRemove(key)}>
                    候補から削除
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
