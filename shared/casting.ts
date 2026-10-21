import { z } from 'zod';
import { aivisRecipeSchema } from './aivis';
import { characterInputSchema, profileSchema, recipeSchema, recipeFields } from './schema';
import { voices } from './catalog';
import { aivisModelInfoSchema } from './aivis-model-info';
export const maxCastingSessionFileBytes = 8 * 1024 * 1024;

export const castingVoiceSchema = z.discriminatedUnion('engine', [
  z.object({
    engine: z.literal('VOICEVOX'),
    voiceId: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    style: z.string().min(1).max(200),
  }),
  z.object({
    engine: z.literal('AivisSpeech'),
    speakerUuid: z.uuid(),
    name: z.string().min(1).max(200),
    style: z.string().min(1).max(200),
  }),
]);
export type CastingVoice = z.infer<typeof castingVoiceSchema>;
export const nativeRecipeSchema = z.discriminatedUnion('engine', [
  recipeSchema.extend({ engine: z.literal('VOICEVOX') }).strict(),
  aivisRecipeSchema,
]);
export type NativeRecipe = z.infer<typeof nativeRecipeSchema>;
// Historic identities remain valid records even when today's catalog has changed.
export const historicalCastingCandidateSchema = z
  .object({
    voice: castingVoiceSchema,
    recipe: nativeRecipeSchema,
    modelInfo: aivisModelInfoSchema.optional(),
  })
  .refine(
    (candidate) => candidate.voice.engine === candidate.recipe.engine,
    '話者と調声値の製品が一致しません。',
  )
  .refine(
    (candidate) =>
      !candidate.modelInfo ||
      (candidate.voice.engine === 'AivisSpeech' &&
        candidate.modelInfo.speakerUuid.toLowerCase() ===
          candidate.voice.speakerUuid.toLowerCase() &&
        candidate.modelInfo.styleName === candidate.voice.style),
    'モデル情報と話者・スタイルが一致しません。',
  );
export const castingCandidateSchema = historicalCastingCandidateSchema.superRefine(
  (candidate, ctx) => {
    if (candidate.voice.engine === 'VOICEVOX') {
      const voiceId = candidate.voice.voiceId;
      const voice = voices.find((item) => item.id === voiceId);
      if (
        !voice ||
        voice.engine !== 'VOICEVOX' ||
        voice.name !== candidate.voice.name ||
        voice.style !== candidate.voice.style
      )
        ctx.addIssue({ code: 'custom', message: 'VOICEVOXカタログの話者と一致しません。' });
    }
  },
);
export type CastingCandidate = z.infer<typeof castingCandidateSchema>;
export function castingKey(voice: CastingVoice) {
  return voice.engine === 'VOICEVOX'
    ? `VOICEVOX:${voice.voiceId}`
    : JSON.stringify(['AivisSpeech', voice.speakerUuid.toLowerCase(), voice.style]);
}
export const generationSchema = z.object({
  engine: z.enum(['VOICEVOX', 'AivisSpeech']),
  engineVersion: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[^\u0000-\u001f\u007f]+$/)
    .nullable(),
  checkedAt: z.iso.datetime(),
  observedStyleId: z.number().int().min(-2147483648).max(2147483647).optional(),
});
export const castingPreviewSchema = z.object({
  candidate: castingCandidateSchema,
  text: z.string().trim().min(1).max(300),
});
const pair = z
  .tuple([historicalCastingCandidateSchema, historicalCastingCandidateSchema])
  .refine(
    (items) => castingKey(items[0].voice) !== castingKey(items[1].voice),
    '異なる2候補を指定してください。',
  );
export const castingEvaluationSchema = z
  .object({
    recordedAt: z.iso.datetime(),
    text: z.string().min(1).max(300),
    candidates: pair,
    generations: z.tuple([generationSchema.nullable(), generationSchema.nullable()]),
    outcome: z.enum(['a', 'b', 'tie', 'undecided']),
    reason: z.string().max(1000),
    profile: profileSchema,
    characterInput: characterInputSchema.nullable(),
  })
  .refine(
    (record) =>
      record.generations.every(
        (info, i) => !info || info.engine === record.candidates[i].voice.engine,
      ),
    '音声と製品が一致しません。',
  );
export type CastingEvaluation = z.infer<typeof castingEvaluationSchema>;
export const castingSessionSchema = z
  .object({
    format: z.literal('voice-atlas-casting'),
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    text: z.string().max(300),
    candidates: z.array(castingCandidateSchema).max(200),
    comparisonKeys: z.tuple([z.string().max(500), z.string().max(500)]).nullable(),
    selectedKey: z.string().max(500).nullable(),
    evaluations: z.array(castingEvaluationSchema).max(100),
    comparisonContext: z
      .object({ profile: profileSchema, characterInput: characterInputSchema.nullable() })
      .optional(),
  })
  .superRefine((saved, ctx) => {
    const keys = saved.candidates.map((item) => castingKey(item.voice));
    if (
      new Set(keys).size !== keys.length ||
      (saved.selectedKey && !keys.includes(saved.selectedKey)) ||
      (saved.comparisonKeys &&
        (saved.comparisonKeys[0] === saved.comparisonKeys[1] ||
          saved.comparisonKeys.some((key) => !keys.includes(key))))
    )
      ctx.addIssue({ code: 'custom', message: '保存した候補の識別情報が一致しません。' });
  });
export type CastingSession = z.infer<typeof castingSessionSchema>;
export const castingInventorySchema = z.object({
  checkedAt: z.iso.datetime(),
  engines: z.array(
    z.object({
      engine: z.enum(['VOICEVOX', 'AivisSpeech']),
      ready: z.boolean(),
      detail: z.string().max(300),
    }),
  ),
  voices: z.array(castingVoiceSchema).max(200),
});
export type CastingInventory = z.infer<typeof castingInventorySchema>;

export function castingRecipeFields(candidate: CastingCandidate) {
  const fields = recipeFields.map((field) =>
    candidate.recipe.engine === 'AivisSpeech' && field.key === 'intonationScale'
      ? {
          ...field,
          label: '感情表現の強さ',
          help: '選んだスタイルの感情表現の強さです。VOICEVOXの抑揚とは異なります。ノーマルでは無視される場合があります。',
        }
      : candidate.recipe.engine === 'AivisSpeech' && field.key === 'pitchScale'
        ? { ...field, help: '初期値は0です。変更すると音質が低下する場合があります。' }
        : field,
  );
  return candidate.recipe.engine === 'AivisSpeech'
    ? [
        ...fields,
        {
          key: 'tempoDynamicsScale' as const,
          label: 'テンポの緩急',
          min: 0,
          max: 2,
          step: 0.01,
          unit: '倍',
          help: 'AivisSpeech固有の、話す速さの緩急を調整します。',
        },
      ]
    : fields;
}
