import { describe, expect, it } from 'vitest';
import {
  castingKey,
  castingCandidateSchema,
  castingEvaluationSchema,
  castingSessionSchema,
  type CastingCandidate,
} from '../shared/casting';
import { aivisRecipeSchema } from '../shared/aivis';
import { voices } from '../shared/catalog';
import { makeRecipe } from '../shared/recommend';
import { neutralProfile } from '../shared/schema';
const voice = voices[0];
const a: CastingCandidate = {
  voice: {
    engine: 'AivisSpeech',
    speakerUuid: '11111111-1111-4111-8111-111111111111',
    name: 'テスト',
    style: 'ノーマル',
  },
  recipe: aivisRecipeSchema.parse({ engine: 'AivisSpeech', tempoDynamicsScale: 0.7 }),
};
const b: CastingCandidate = {
  voice: { engine: 'VOICEVOX', voiceId: voice.id, name: voice.name, style: voice.style },
  recipe: { ...makeRecipe(neutralProfile, voice), engine: 'VOICEVOX' },
};
const evaluation = {
  recordedAt: '2026-10-21T12:00:00.000Z',
  text: '比較するセリフです。',
  candidates: [a, b],
  generations: [
    {
      engine: 'AivisSpeech',
      engineVersion: '1.0',
      checkedAt: '2026-10-21T12:00:00.000Z',
      observedStyleId: -12,
    },
    null,
  ],
  outcome: 'a',
  reason: 'テンポが合う',
  profile: neutralProfile,
  characterInput: { mode: 'text', text: '静かな案内役', direction: '' },
};
function session() {
  return {
    format: 'voice-atlas-casting',
    version: 1,
    createdAt: evaluation.recordedAt,
    text: evaluation.text,
    candidates: [a, b],
    comparisonKeys: [castingKey(a.voice), castingKey(b.voice)],
    selectedKey: castingKey(a.voice),
    evaluations: [evaluation],
  };
}
describe('product-specific casting session', () => {
  it('round trips native settings, chosen identity and independent historic conditions', () => {
    const saved = castingSessionSchema.parse(JSON.parse(JSON.stringify(session())));
    expect(saved.evaluations[0]).toMatchObject(evaluation);
    saved.candidates[0].recipe.intonationScale = 0.4;
    expect(saved.evaluations[0].candidates[0].recipe.intonationScale).toBe(1);
    expect(saved.candidates[0].recipe.engine).toBe('AivisSpeech');
  });
  it('accepts an uninstalled AivisSpeech identity without fabricating a score', () => {
    expect(castingSessionSchema.parse(session()).evaluations[0]).not.toHaveProperty('score');
  });
  it('rejects mismatched engine settings and the wrong VOICEVOX identity', () => {
    expect(castingCandidateSchema.safeParse({ ...a, recipe: b.recipe }).success).toBe(false);
    expect(
      castingCandidateSchema.safeParse({ ...b, voice: { ...b.voice, name: '別名' } }).success,
    ).toBe(false);
    expect(
      castingCandidateSchema.safeParse({ ...b, recipe: { ...b.recipe, tempoDynamicsScale: 1 } })
        .success,
    ).toBe(false);
  });
  it('rejects duplicate candidates, invalid pair keys and an absent chosen identity', () => {
    expect(castingSessionSchema.safeParse({ ...session(), candidates: [a, a] }).success).toBe(
      false,
    );
    expect(
      castingSessionSchema.safeParse({
        ...session(),
        comparisonKeys: ['missing', castingKey(b.voice)],
      }).success,
    ).toBe(false);
    expect(castingSessionSchema.safeParse({ ...session(), selectedKey: 'missing' }).success).toBe(
      false,
    );
    expect(
      castingSessionSchema.safeParse({
        ...session(),
        comparisonKeys: [castingKey(a.voice), castingKey(a.voice)],
      }).success,
    ).toBe(false);
  });
  it('rejects evaluation pairs with the same identity and mismatched generation provenance', () => {
    expect(castingEvaluationSchema.safeParse({ ...evaluation, candidates: [a, a] }).success).toBe(
      false,
    );
    expect(
      castingEvaluationSchema.safeParse({
        ...evaluation,
        generations: [{ ...evaluation.generations[0], engine: 'VOICEVOX' }, null],
      }).success,
    ).toBe(false);
  });
  it('strips imported URLs and numeric IDs from voice identities', () => {
    const result = castingCandidateSchema.parse({
      ...a,
      voice: { ...a.voice, termsUrl: 'https://untrusted.invalid', observedStyleId: 123 },
    });
    expect(result.voice).not.toHaveProperty('termsUrl');
    expect(result.voice).not.toHaveProperty('observedStyleId');
  });
  it('bounds history and validates versions and native parameter limits', () => {
    expect(castingSessionSchema.safeParse({ ...session(), version: 2 }).success).toBe(false);
    expect(
      castingSessionSchema.safeParse({ ...session(), evaluations: Array(101).fill(evaluation) })
        .success,
    ).toBe(false);
    expect(
      castingCandidateSchema.safeParse({ ...a, recipe: { ...a.recipe, tempoDynamicsScale: 3 } })
        .success,
    ).toBe(false);
  });
});
