import { z } from 'zod';
import { preferencesSchema, profileSchema, recipeSchema, providerSchema } from '../shared/schema';

export const recommendRequestSchema = z.object({
  profile: profileSchema,
  preferences: preferencesSchema,
});
export const analyzeRequestSchema = z
  .object({
    provider: providerSchema,
    inputMode: z.enum(['image', 'text']).default('image'),
    image: z.string().max(11_200_000).optional(),
    characterText: z.string().max(2000).default(''),
    direction: z.string().max(1000).default(''),
    consent: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (input.inputMode === 'image' && !input.image)
      ctx.addIssue({ code: 'custom', path: ['image'], message: '画像を指定してください。' });
    if (input.inputMode === 'text' && (!input.characterText.trim() || input.image !== undefined))
      ctx.addIssue({
        code: 'custom',
        path: ['characterText'],
        message: '画像を含めず、キャラクター設定を指定してください。',
      });
  });
export const previewRequestSchema = z.object({
  voiceId: z.string().max(80),
  text: z.string().trim().min(1).max(300),
  recipe: recipeSchema,
});
