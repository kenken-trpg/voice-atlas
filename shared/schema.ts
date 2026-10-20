import { z } from 'zod';

export const providerSchema = z.enum(['ollama', 'openai', 'anthropic', 'gemini']);
export type Provider = z.infer<typeof providerSchema>;
export const providerLabels: Record<Provider, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI',
  anthropic: 'Anthropic（Claude）',
  gemini: 'Google（Gemini）',
};
export const defaultAnthropicModel = 'claude-sonnet-5-5';
export const defaultGeminiModel = 'gemini-3.8-flash';

export const axes = ['pitch', 'energy', 'warmth', 'airiness'] as const;
export const axisLabels: Record<(typeof axes)[number], string> = {
  pitch: '声の高さ',
  energy: '活発さ',
  warmth: '柔らかさ',
  airiness: '息の多さ',
};
export const profileSchema = z.object({
  pitch: z.number().min(0).max(100),
  energy: z.number().min(0).max(100),
  warmth: z.number().min(0).max(100),
  airiness: z.number().min(0).max(100),
});
export type Profile = z.infer<typeof profileSchema>;
export const neutralProfile: Profile = { pitch: 50, energy: 50, warmth: 50, airiness: 30 };
export const engineSchema = z.enum(['VOICEVOX', 'COEIROINK', 'A.I.VOICE2']);
export type Engine = z.infer<typeof engineSchema>;
export const preferencesSchema = z.object({
  engine: z.union([engineSchema, z.literal('all')]).default('all'),
  budget: z.enum(['all', 'free']).default('all'),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export const analysisSchema = z.object({
  subjectFound: z.boolean(),
  summary: z.string().min(1).max(500),
  cues: z.array(z.string().min(1).max(120)).max(5),
  delivery: z.string().min(1).max(400),
  profile: profileSchema,
});
export type Analysis = z.infer<typeof analysisSchema>;
export const recipeSchema = z.object({
  speedScale: z.number().min(0.5).max(2),
  pitchScale: z.number().min(-0.15).max(0.15),
  intonationScale: z.number().min(0).max(2),
  volumeScale: z.number().min(0).max(2),
  prePhonemeLength: z.number().min(0).max(1),
  postPhonemeLength: z.number().min(0).max(1),
});
export type Recipe = z.infer<typeof recipeSchema>;
export const recipeFields: {
  key: keyof Recipe;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  help: string;
}[] = [
  {
    key: 'speedScale',
    label: '話速',
    min: 0.5,
    max: 2,
    step: 0.01,
    unit: '倍',
    help: '大きいほど速く。落ち着いた演技なら少し下げます。',
  },
  {
    key: 'pitchScale',
    label: '音高',
    min: -0.15,
    max: 0.15,
    step: 0.01,
    unit: '',
    help: '0が元の音高。話者の声質を保つため、小さく調整します。',
  },
  {
    key: 'intonationScale',
    label: '抑揚',
    min: 0,
    max: 2,
    step: 0.01,
    unit: '倍',
    help: '小さいほど平坦に、大きいほど表情豊かになります。',
  },
  {
    key: 'volumeScale',
    label: '音量',
    min: 0,
    max: 2,
    step: 0.01,
    unit: '倍',
    help: 'まずは1.00を基準に試聴します。',
  },
  {
    key: 'prePhonemeLength',
    label: '開始無音',
    min: 0,
    max: 1,
    step: 0.01,
    unit: '秒',
    help: '音声の先頭に置く無音です。',
  },
  {
    key: 'postPhonemeLength',
    label: '終了無音',
    min: 0,
    max: 1,
    step: 0.01,
    unit: '秒',
    help: '余韻を残したい場合は少し長くします。',
  },
];
export interface Voice {
  id: string;
  engine: Engine;
  name: string;
  style: string;
  price: 'free' | 'paid';
  tags: string[];
  description: string;
  profile: Profile;
  color: string;
  productUrl: string;
  termsUrl: string;
  docsUrl: string;
  credit: string;
}
export interface Recommendation {
  voice: Voice;
  score: number;
  reasons: string[];
  recipe: Recipe | null;
  guide: string[];
}
export interface Capabilities {
  ollama: { ready: boolean; model: string; detail: string };
  openai: { ready: boolean; model: string };
  anthropic: { ready: boolean; model: string };
  gemini: { ready: boolean; model: string };
  voicevox: { ready: boolean; detail: string };
}
export const defaultText =
  'こんにちは。あなたと出会えて、とてもうれしいです。さあ、物語の続きを始めましょう。';
