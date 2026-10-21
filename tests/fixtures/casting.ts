import { castingEvaluationSchema, castingKey, type CastingEvaluation } from '../../shared/casting';
import { aivisRecipeSchema } from '../../shared/aivis';
import { voices } from '../../shared/catalog';
import { makeRecipe } from '../../shared/recommend';
import { neutralProfile } from '../../shared/schema';

export function makeCastingEvaluation(
  overrides: Partial<CastingEvaluation> = {},
): CastingEvaluation {
  const voice = voices[0];
  return castingEvaluationSchema.parse({
    recordedAt: '2026-10-21T12:00:00.000Z',
    text: '同じセリフで比較します。',
    candidates: [
      {
        voice: {
          engine: 'AivisSpeech',
          speakerUuid: 'abcdefab-1111-4111-8111-111111111111',
          name: '評価用話者',
          style: 'ノーマル',
        },
        recipe: aivisRecipeSchema.parse({
          engine: 'AivisSpeech',
          tempoDynamicsScale: 0.72,
          intonationScale: 1.2,
        }),
      },
      {
        voice: { engine: 'VOICEVOX', voiceId: voice.id, name: voice.name, style: voice.style },
        recipe: { ...makeRecipe(neutralProfile, voice), engine: 'VOICEVOX', speedScale: 0.85 },
      },
    ],
    generations: [
      {
        engine: 'AivisSpeech',
        engineVersion: 'aivis-test',
        checkedAt: '2026-10-21T12:00:00.000Z',
        observedStyleId: -12,
      },
      { engine: 'VOICEVOX', engineVersion: 'vv-test', checkedAt: '2026-10-21T12:00:01.000Z' },
    ],
    outcome: 'a',
    reason: '落ち着きとテンポが合う。',
    profile: { ...neutralProfile, pitch: 17 },
    characterInput: { mode: 'text', text: '静かな案内役', direction: 'ゆっくりと' },
    ...overrides,
  });
}
export function makeCastingSession(evaluations: CastingEvaluation[]) {
  const record = evaluations[0] ?? makeCastingEvaluation();
  return {
    format: 'voice-atlas-casting',
    version: 1,
    createdAt: '2026-10-21T12:00:00.000Z',
    text: record.text,
    candidates: record.candidates,
    comparisonKeys: record.candidates.map((candidate) => castingKey(candidate.voice)),
    selectedKey: castingKey(record.candidates[0].voice),
    evaluations,
  };
}
