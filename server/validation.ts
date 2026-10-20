import { z } from 'zod';
import { preferencesSchema, profileSchema, recipeSchema, providerSchema } from '../shared/schema';

export const recommendRequestSchema = z.object({
  profile: profileSchema,
  preferences: preferencesSchema,
});
export const analyzeRequestSchema = z.object({
  provider: providerSchema,
  image: z.string().max(11_200_000),
  direction: z.string().max(1000).default(''),
  consent: z.boolean().default(false),
});
export const previewRequestSchema = z.object({
  voiceId: z.string().max(80),
  text: z.string().trim().min(1).max(300),
  recipe: recipeSchema,
});
