import type { CharacterInput } from '../../shared/schema';

export function CharacterContext({ input }: { input: CharacterInput | undefined }) {
  return input && (input.text.trim() || input.direction.trim()) ? (
    <details className="character-context">
      <summary>声の方向を作ったときの設定</summary>
      <p>入力：{input.mode === 'text' ? '設定テキストのみ' : '画像と設定（画像は保存しません）'}</p>
      <p className="evaluation-text">キャラクター設定：{input.text || '記入なし'}</p>
      <p className="evaluation-text">演出の補足：{input.direction || '記入なし'}</p>
    </details>
  ) : null;
}
