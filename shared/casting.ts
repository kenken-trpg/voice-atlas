import { z } from 'zod';
import { aivisRecipeSchema } from './aivis';
import { characterInputSchema, profileSchema, recipeSchema } from './schema';
import { voices } from './catalog';

export const castingVoiceSchema = z.discriminatedUnion('engine', [
  z.object({
    engine: z.literal('VOICEVOX'),
    voiceId: z.string().max(100),
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
export const castingCandidateSchema = z
  .object({ voice: castingVoiceSchema, recipe: nativeRecipeSchema })
  .superRefine((candidate, ctx) => {
    if (candidate.voice.engine !== candidate.recipe.engine)
      ctx.addIssue({ code: 'custom', message: '話者と調声値の製品が一致しません。' });
    if (candidate.voice.engine === 'VOICEVOX') {
      const voice = voices.find(
        (item) => item.id === (candidate.voice as { voiceId: string }).voiceId,
      );
      if (
        !voice ||
        voice.engine !== 'VOICEVOX' ||
        voice.name !== candidate.voice.name ||
        voice.style !== candidate.voice.style
      )
        ctx.addIssue({ code: 'custom', message: 'VOICEVOXカタログの話者と一致しません。' });
    }
  });
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
  .tuple([castingCandidateSchema, castingCandidateSchema])
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
