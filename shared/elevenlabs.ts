import { z } from 'zod';

export const elevenLabsVoiceIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);
export const elevenLabsCursorSchema = z.uuid();
export const elevenLabsRecipeSchema = z.strictObject({
  engine: z.literal('ElevenLabs'),
  // Explicitly forbid local-engine settings, including in typed recipe unions.
  speedScale: z.never().optional(),
  pitchScale: z.never().optional(),
  intonationScale: z.never().optional(),
  volumeScale: z.never().optional(),
  prePhonemeLength: z.never().optional(),
  postPhonemeLength: z.never().optional(),
  tempoDynamicsScale: z.never().optional(),
  modelId: z.string().min(1).max(100),
  stability: z.number().min(0).max(1).default(0.5),
  similarityBoost: z.number().min(0).max(1).default(0.75),
  style: z.number().min(0).max(1).default(0),
  useSpeakerBoost: z.boolean().default(false),
  seed: z.number().int().min(0).max(4294967295).nullable().default(null),
  outputFormat: z.literal('pcm_22050').default('pcm_22050'),
});
export type ElevenLabsRecipe = z.infer<typeof elevenLabsRecipeSchema>;

export const elevenLabsModelSchema = z.object({
  modelId: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  canUseStyle: z.boolean(),
  canUseSpeakerBoost: z.boolean(),
  maxCharacters: z.number().int().positive().max(100000),
  languages: z.array(z.object({ id: z.string().max(20), name: z.string().max(100) })).max(300),
});
export type ElevenLabsModel = z.infer<typeof elevenLabsModelSchema>;

export const elevenLabsModelsResponseSchema = z.object({
  ready: z.boolean(),
  detail: z.string().max(300),
  checkedAt: z.iso.datetime(),
  models: z.array(elevenLabsModelSchema).max(100),
});
export type ElevenLabsModelsResponse = z.infer<typeof elevenLabsModelsResponseSchema>;

export const elevenLabsVoiceSchema = z.object({
  engine: z.literal('ElevenLabs'),
  voiceId: elevenLabsVoiceIdSchema,
  name: z.string().min(1).max(200),
  category: z.string().max(40).optional(),
  style: z.string().max(40).default('default'),
});

export const elevenLabsVoicePageSchema = z.object({
  voices: z.array(elevenLabsVoiceSchema).max(50),
  hasMore: z.boolean(),
  nextCursor: elevenLabsCursorSchema.nullable(),
});
export type ElevenLabsVoicePage = z.infer<typeof elevenLabsVoicePageSchema>;

export const elevenLabsGenerationSchema = z.object({
  modelId: z.string().min(1).max(100),
  outputFormat: z.literal('pcm_22050'),
  seed: z.number().int().min(0).max(4294967295).nullable(),
  requestId: z.string().max(200).optional(),
});
export type ElevenLabsGeneration = z.infer<typeof elevenLabsGenerationSchema>;
