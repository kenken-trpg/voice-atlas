import {
  axes,
  axisLabels,
  type Preferences,
  type Profile,
  type Recipe,
  type Recommendation,
  type Voice,
} from './schema';
import { voices } from './catalog';
const round = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function makeRecipe(profile: Profile, voice: Voice): Recipe {
  const whisper = voice.pitchPolicy === 'preserve';
  return {
    speedScale: round(clamp(0.86 + profile.energy * 0.003, 0.8, 1.2)),
    pitchScale: whisper
      ? 0
      : round(clamp((profile.pitch - voice.profile.pitch) * 0.002, -0.1, 0.1)),
    intonationScale: whisper ? 0.8 : round(clamp(0.65 + profile.energy * 0.007, 0.65, 1.35)),
    volumeScale: 1,
    prePhonemeLength: 0.1,
    postPhonemeLength: round(0.18 + (100 - profile.energy) * 0.002),
  };
}

export function recommend(profile: Profile, preferences: Preferences): Recommendation[] {
  return voices
    .filter(
      (v) =>
        (preferences.engine === 'all' || v.engine === preferences.engine) &&
        (preferences.budget === 'all' || v.price === 'free'),
    )
    .map((voice) => {
      const distance = Math.sqrt(
        axes.reduce((sum, axis) => sum + (profile[axis] - voice.profile[axis]) ** 2, 0) /
          axes.length,
      );
      const close = [...axes]
        .sort(
          (a, b) =>
            Math.abs(profile[a] - voice.profile[a]) - Math.abs(profile[b] - voice.profile[b]),
        )
        .slice(0, 2);
      const recipe = voice.engine === 'VOICEVOX' ? makeRecipe(profile, voice) : null;
      const guide = recipe
        ? [
            `VOICEVOXで「${voice.name} / ${voice.style}」を選択し、下の6項目をテキスト欄ごとに入力します。`,
            '同じセリフで標準設定と比較し、まず話速、次に抑揚、最後に音高を少しずつ調整してください。',
            '単語の読みやアクセントは、エディターのアクセント・イントネーション画面で仕上げます。',
          ]
        : voice.engine === 'COEIROINK'
          ? [
              `COEIROINK v2に「${voice.name}」を追加し、「${voice.style}」を出発点に公式サンプルを聴き比べます。`,
              profile.energy >= 60
                ? '話速を標準から少し上げ、短い文と読点で軽快なリズムを作ります。'
                : '話速を標準から少し下げ、句読点でゆったりした間を作ります。',
              profile.pitch > voice.profile.pitch + 10
                ? '音高を標準から少し上げて試聴します。声質が変わりすぎる場合は標準に戻してください。'
                : '音高はまず標準で試聴し、キャラクターの印象に合わせて小さく調整します。',
              'この初期版はCOEIROINKの数値設定・API出力には未対応です。VOICEVOXの値は転用せず、公式ヘルプの設定項目を確認してください。',
            ]
          : [
              `A.I.VOICE2で「${voice.name} / ${voice.style}」を選び、チューニング画面で全文の音声効果を編集します。`,
              profile.energy >= 60
                ? '話速を標準から少し上げ、抑揚を強める方向で試聴します。対応していれば「喜」スタイルも比較します。'
                : '話速と抑揚を標準から少し下げ、語尾を穏やかに整えます。',
              '高さは標準から小さく動かし、アクセント句・文字単位の調整で仕上げます。スタイルの種類は製品ごとに確認してください。',
              'この初期版はA.I.VOICE2の数値設定・API出力には未対応です。公式チューニングガイドを併せて参照してください。',
            ];
      return {
        voice,
        score: Math.round(clamp(100 - distance, 0, 100)),
        reasons: close.map((axis) => `${axisLabels[axis]}の演出方向が近い`),
        recipe,
        guide,
      };
    })
    .sort((a, b) => b.score - a.score || a.voice.id.localeCompare(b.voice.id));
}
