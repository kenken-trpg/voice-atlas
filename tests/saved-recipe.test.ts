import { describe, expect, it } from 'vitest';
import { voices, catalogReviewedAt } from '../shared/catalog';
import { makeRecipe } from '../shared/recommend';
import { neutralProfile } from '../shared/schema';
import { parseSavedRecipe, maxRecipeFileBytes } from '../shared/saved-recipe';

const parameters = makeRecipe(neutralProfile, voices[0]);
const legacy = {
  format: 'voice-atlas-recipe',
  version: 1,
  createdAt: '2026-10-21T00:00:00.000Z',
  source: 'manual',
  manuallyAdjusted: true,
  voice: voices[0],
  profile: neutralProfile,
  parameters,
  sampleText: '比較するセリフです。',
  catalogReviewedAt,
};
const candidate = (index: number) => ({
  voiceId: voices[index].id,
  parameters: makeRecipe(neutralProfile, voices[index]),
});
const session = () => ({
  ...legacy,
  version: 2,
  preferences: { engine: 'all', budget: 'all' },
  candidates: [candidate(0), candidate(1)],
  comparisonIds: [voices[0].id, voices[1].id],
  evaluations: [
    {
      recordedAt: legacy.createdAt,
      profile: neutralProfile,
      sampleText: '評価時のセリフ',
      candidates: [candidate(0), candidate(1)],
      outcome: 'a',
      reason: '落ち着いた声が合う',
    },
  ],
});

describe('saved casting recipes', () => {
  it('retains draft and applied character inputs independently without importing images or URLs', () => {
    const original = session();
    const applied = { mode: 'text', text: '穏やかな司書。', direction: '丁寧に。' };
    const draft = { ...applied, text: '威厳のある司書。' };
    const saved = parseSavedRecipe({
      ...original,
      version: 3,
      characterInput: { ...draft, image: 'private' },
      profileInput: applied,
      evaluations: [
        { ...original.evaluations[0], characterInput: { ...applied, image: 'private' } },
      ],
    });
    if (saved.version !== 3) throw new Error('expected v3');
    expect(saved.characterInput).toEqual(draft);
    expect(saved.profileInput).toEqual(applied);
    expect(saved.evaluations[0].characterInput).toEqual(applied);
    expect(JSON.stringify(saved)).not.toContain('private');
    expect(parseSavedRecipe({ ...original, version: 3, profileInput: null })).toHaveProperty(
      'profileInput',
      null,
    );
    expect(() =>
      parseSavedRecipe({
        ...original,
        version: 3,
        characterInput: { ...draft, text: 'a'.repeat(2001) },
      }),
    ).toThrow('設定範囲');
  });
  it('keeps a full history of long settings within the import limit', () => {
    const original = session();
    const input = { mode: 'text', text: '設'.repeat(2000), direction: '指'.repeat(1000) };
    const file = {
      ...original,
      version: 3,
      characterInput: input,
      profileInput: input,
      evaluations: Array.from({ length: 100 }, () => ({
        ...original.evaluations[0],
        reason: '理'.repeat(1000),
        sampleText: '声'.repeat(300),
        characterInput: input,
      })),
    };
    const serialized = JSON.stringify(file, null, 2);
    expect(Buffer.byteLength(serialized)).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(serialized)).toBeLessThan(maxRecipeFileBytes);
    const restored = parseSavedRecipe(JSON.parse(serialized));
    if (restored.version !== 3) throw new Error('expected v3');
    expect(restored.evaluations).toHaveLength(100);
  });
  it('keeps all ten original candidate identities readable without new catalog metadata', () => {
    const identities = [
      ['vv-metan', 'VOICEVOX', '四国めたん', 'ノーマル'],
      ['vv-zundamon', 'VOICEVOX', 'ずんだもん', 'ノーマル'],
      ['vv-tsumugi', 'VOICEVOX', '春日部つむぎ', 'ノーマル'],
      ['vv-ritsu', 'VOICEVOX', '波音リツ', 'ノーマル'],
      ['vv-ryusei', 'VOICEVOX', '青山龍星', 'ノーマル'],
      ['vv-sora', 'VOICEVOX', '九州そら', 'ささやき'],
      ['coei-tsukuyomi', 'COEIROINK', 'つくよみちゃん', 'れいせい'],
      ['coei-kana', 'COEIROINK', 'AI声優-金苗', 'のーまる'],
      ['ai-akane', 'A.I.VOICE2', '琴葉 茜', 'ノーマル'],
      ['ai-aoi', 'A.I.VOICE2', '琴葉 葵', 'ノーマル'],
    ];
    for (const [id, engine, name, style] of identities) {
      const saved = parseSavedRecipe({
        ...legacy,
        catalogReviewedAt: '2026-10-20',
        voice: { id, engine, name, style },
        parameters: engine === 'VOICEVOX' ? parameters : null,
      });
      expect(saved.voice).toEqual({ id, engine, name, style });
    }
  });
  it('reads existing v1 exports and uses catalog data instead of imported URLs', () => {
    const saved = parseSavedRecipe({
      ...legacy,
      voice: { ...legacy.voice, productUrl: 'javascript:alert(1)' },
      image: 'private',
    });
    expect(saved.version).toBe(1);
    expect(saved.parameters).toEqual(parameters);
    expect(saved.voice).not.toHaveProperty('productUrl');
    expect(saved).not.toHaveProperty('image');
  });
  it('round-trips comparison settings and immutable evaluation snapshots', () => {
    const original = session();
    original.candidates[0].parameters.speedScale = 1.1;
    original.parameters = { ...original.parameters, speedScale: 1.1 };
    const saved = parseSavedRecipe(JSON.parse(JSON.stringify(original)));
    expect(saved.version).toBe(2);
    if (saved.version !== 2) throw new Error('expected v2');
    expect(saved.candidates[0].parameters.speedScale).toBe(1.1);
    expect(saved.evaluations[0].candidates[0].parameters.speedScale).toBe(parameters.speedScale);
    expect(saved.evaluations[0].reason).toBe('落ち着いた声が合う');
  });
  it('supports guide-only legacy recipes without numeric parameters', () => {
    expect(
      parseSavedRecipe({ ...legacy, voice: voices[6], parameters: null }).parameters,
    ).toBeNull();
    expect(() => parseSavedRecipe({ ...legacy, voice: voices[6] })).toThrow('一致しません');
  });
  it('rejects future versions, missing voices, changed identity and out-of-range settings', () => {
    expect(() => parseSavedRecipe({ ...legacy, version: 99 })).toThrow('バージョン');
    expect(() => parseSavedRecipe({ ...legacy, voice: { ...voices[0], id: 'removed' } })).toThrow(
      'カタログ',
    );
    expect(() =>
      parseSavedRecipe({ ...legacy, voice: { ...voices[0], style: 'unknown' } }),
    ).toThrow('一致しません');
    expect(() =>
      parseSavedRecipe({ ...legacy, parameters: { ...parameters, speedScale: 100 } }),
    ).toThrow('設定範囲');
  });
  it('rejects duplicate, non-VOICEVOX and incomplete comparison identities', () => {
    const saved = session();
    expect(() =>
      parseSavedRecipe({ ...saved, comparisonIds: [voices[0].id, voices[0].id] }),
    ).toThrow('異なる');
    expect(() =>
      parseSavedRecipe({ ...saved, comparisonIds: [voices[0].id, voices[6].id] }),
    ).toThrow('VOICEVOX');
    expect(() => parseSavedRecipe({ ...saved, candidates: [candidate(0)] })).toThrow(
      '設定がありません',
    );
    expect(() => parseSavedRecipe({ ...saved, candidates: [candidate(0), candidate(0)] })).toThrow(
      '重複',
    );
    expect(() =>
      parseSavedRecipe({ ...saved, parameters: { ...parameters, speedScale: 0.5 } }),
    ).toThrow('一致しません');
  });
  it('validates historical conditions even when current candidates are valid', () => {
    const saved = session();
    saved.evaluations[0].candidates[1].voiceId = 'removed';
    expect(() => parseSavedRecipe(saved)).toThrow('カタログ');
    expect(() =>
      parseSavedRecipe({ ...session(), evaluations: Array(101).fill(session().evaluations[0]) }),
    ).toThrow('形式');
  });
});
