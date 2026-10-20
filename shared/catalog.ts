import type { Voice } from './schema';

// Parameters below describe our editorial listening impressions (0–100), not vendor measurements.
// They must never be presented as an identity, biological trait or probability.
export const catalogReviewedAt = '2026-10-20';
const vv = {
  engine: 'VOICEVOX' as const, price: 'free' as const,
  productUrl: 'https://voicevox.hiroshiba.jp/', termsUrl: 'https://voicevox.hiroshiba.jp/term/',
  docsUrl: 'https://voicevox.hiroshiba.jp/how_to_use/',
};
const coei = {
  engine: 'COEIROINK' as const, price: 'free' as const,
  docsUrl: 'https://coeiroink.com/help', termsUrl: 'https://coeiroink.com/terms',
};
const ai = {
  engine: 'A.I.VOICE2' as const, price: 'paid' as const,
  productUrl: 'https://aivoice.jp/product/aivoice2_kotonoha/',
  docsUrl: 'https://aivoice.jp/manual/editor2/tuning.html',
  termsUrl: 'https://aivoice.jp/product/aivoice2_kotonoha/',
};
export const voices: Voice[] = [
  { ...vv, id: 'vv-metan', name: '四国めたん', style: 'ノーマル', tags: ['芯のある声', '華やか', '会話'], description: '輪郭のある発声を、少し落ち着いたテンポで。凛とした演出の出発点に。', profile: { pitch: 62, energy: 62, warmth: 45, airiness: 25 }, color: '#b86c91', credit: 'VOICEVOX:四国めたん' },
  { ...vv, id: 'vv-zundamon', name: 'ずんだもん', style: 'ノーマル', tags: ['明るい', '軽やか', 'マスコット'], description: '軽快なリズムと明るい響き。元気なマスコットや、親しみやすい案内役に。', profile: { pitch: 78, energy: 82, warmth: 75, airiness: 25 }, color: '#699b6e', credit: 'VOICEVOX:ずんだもん' },
  { ...vv, id: 'vv-tsumugi', name: '春日部つむぎ', style: 'ノーマル', tags: ['親しみ', '自然体', '明るい'], description: '親しみのある会話調から、距離の近いナレーションまで。', profile: { pitch: 65, energy: 75, warmth: 70, airiness: 25 }, color: '#be9146', credit: 'VOICEVOX:春日部つむぎ' },
  { ...vv, id: 'vv-ritsu', name: '波音リツ', style: 'ノーマル', tags: ['落ち着き', '中低音', '凛々しい'], description: '落ち着いた響きを生かして、静かな語りや芯のある役柄へ。', profile: { pitch: 35, energy: 40, warmth: 45, airiness: 30 }, color: '#a65d64', credit: 'VOICEVOX:波音リツ' },
  { ...vv, id: 'vv-ryusei', name: '青山龍星', style: 'ノーマル', tags: ['低音', '重厚', '語り'], description: '低い響きを生かした、重厚な語りや頼もしい演出の候補。', profile: { pitch: 12, energy: 45, warmth: 50, airiness: 20 }, color: '#617c95', credit: 'VOICEVOX:青山龍星' },
  { ...vv, id: 'vv-sora', name: '九州そら', style: 'ささやき', tags: ['ささやき', '柔らかい', '静か'], description: '息を含む静かな表現。音高の加工を控え、間の取り方を中心に調整します。', profile: { pitch: 65, energy: 15, warmth: 85, airiness: 95 }, color: '#879c8c', credit: 'VOICEVOX:九州そら' },
  { ...coei, id: 'coei-tsukuyomi', name: 'つくよみちゃん', style: 'れいせい', tags: ['穏やか', '丁寧', '案内'], description: 'ゆったり丁寧に語る演出の候補。まずは公式音声サンプルと比較してください。', profile: { pitch: 66, energy: 35, warmth: 85, airiness: 40 }, color: '#b18c72', productUrl: 'https://coeiroink.com/character/audio-character/tsukuyomi-chan', credit: 'COEIROINK:つくよみちゃん' },
  { ...coei, id: 'coei-kana', name: 'AI声優-金苗', style: 'のーまる', tags: ['はっきり', '親しみ', '会話'], description: '明瞭で親しみやすい会話の候補。表情に合わせてテンポを整えます。', profile: { pitch: 62, energy: 65, warmth: 70, airiness: 30 }, color: '#8d83a8', productUrl: 'https://coeiroink.com/character/audio-character/kana', credit: 'COEIROINK:AI声優-金苗' },
  { ...ai, id: 'ai-akane', name: '琴葉 茜', style: 'ノーマル', tags: ['関西弁', '感情豊か', '柔らかい'], description: '関西弁の会話を演出したいときの候補。スタイルで感情を調整できます。', profile: { pitch: 70, energy: 75, warmth: 80, airiness: 25 }, color: '#bc7679', credit: 'A.I.VOICE2 琴葉 茜（表記条件は製品規約を確認）' },
  { ...ai, id: 'ai-aoi', name: '琴葉 葵', style: 'ノーマル', tags: ['標準語', '柔らかい', '穏やか'], description: '標準語の柔らかい会話や、穏やかな案内役の演出に。', profile: { pitch: 68, energy: 45, warmth: 85, airiness: 30 }, color: '#6f8baa', credit: 'A.I.VOICE2 琴葉 葵（表記条件は製品規約を確認）' },
];
