import { z } from 'zod';

// AivisSpeech units, not a conversion of the VOICEVOX recommendation recipe.
export const aivisRecipeSchema = z.strictObject({
  engine: z.literal('AivisSpeech'),
  speedScale: z.number().min(0.5).max(2).default(1),
  intonationScale: z.number().min(0).max(2).default(1),
  tempoDynamicsScale: z.number().min(0).max(2).default(1),
  pitchScale: z.number().min(-0.15).max(0.15).default(0),
  volumeScale: z.number().min(0).max(2).default(1),
  // Application limits for silence, in seconds.
  prePhonemeLength: z.number().min(0).max(1).default(0.1),
  postPhonemeLength: z.number().min(0).max(1).default(0.1),
});
export type AivisRecipe = z.infer<typeof aivisRecipeSchema>;
