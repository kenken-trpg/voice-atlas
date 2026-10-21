import { z } from 'zod';
import { voices } from './catalog';
import {
  engineSchema,
  preferencesSchema,
  profileSchema,
  providerSchema,
  recipeSchema,
  recipeFields,
} from './schema';

const voiceId = z.string().min(1).max(100);
const candidateSchema = z.object({ voiceId, parameters: recipeSchema });
export const evaluationSchema = z.object({
  recordedAt: z.iso.datetime(),
  profile: profileSchema,
  sampleText: z.string().min(1).max(300),
  candidates: z.tuple([candidateSchema, candidateSchema]),
  outcome: z.enum(['a', 'b', 'tie', 'undecided']),
  reason: z.string().max(1000),
});
export type Evaluation = z.infer<typeof evaluationSchema>;
const base = {
  format: z.literal('voice-atlas-recipe'),
  createdAt: z.iso.datetime(),
  source: z.union([z.literal('manual'), providerSchema]),
  manuallyAdjusted: z.boolean(),
  voice: z.object({ id: voiceId, engine: engineSchema, name: z.string(), style: z.string() }),
  profile: profileSchema,
  parameters: recipeSchema.nullable(),
  sampleText: z.string().max(300),
  catalogReviewedAt: z.string().max(40),
};
const savedRecipeSchema = z.discriminatedUnion('version', [
  z.object({ ...base, version: z.literal(1) }),
  z.object({
    ...base,
    version: z.literal(2),
    preferences: preferencesSchema,
    candidates: z.array(candidateSchema).max(100),
    comparisonIds: z.tuple([voiceId, voiceId]).nullable(),
    evaluations: z.array(evaluationSchema).max(100),
  }),
]);

// Import only known catalog identities and validated numbers. URLs, guides and credits
// in a user-supplied file are never used to populate the interface.
export function parseSavedRecipe(input: unknown) {
  if (
    input &&
    typeof input === 'object' &&
    'format' in input &&
    input.format === 'voice-atlas-recipe' &&
    'version' in input &&
    input.version !== 1 &&
    input.version !== 2
  ) {
    throw new Error('このJSONのバージョンには対応していません。対応バージョンは1・2です。');
  }
  const result = savedRecipeSchema.safeParse(input);
  if (!result.success) throw new Error('Voice Atlasのレシピ形式・設定範囲を確認してください。');
  const saved = result.data;
  const findVoice = (id: string) => {
    const voice = voices.find((item) => item.id === id);
    if (!voice) throw new Error(`カタログにない話者が含まれています：${id}`);
    return voice;
  };
  const voice = findVoice(saved.voice.id);
  if (
    voice.engine !== saved.voice.engine ||
    voice.name !== saved.voice.name ||
    voice.style !== saved.voice.style ||
    (voice.engine === 'VOICEVOX') !== (saved.parameters !== null)
  ) {
    throw new Error('保存された話者・スタイルと調声値が現在のカタログに一致しません。');
  }
  const checkCandidate = (candidate: z.infer<typeof candidateSchema>) => {
    if (findVoice(candidate.voiceId).engine !== 'VOICEVOX')
      throw new Error('比較用の数値設定はVOICEVOXの話者だけに指定できます。');
  };
  const checkPair = (ids: [string, string]) => {
    if (ids[0] === ids[1])
      throw new Error('比較する2候補には異なる話者・スタイルの組み合わせを指定してください。');
    ids.forEach((id) => {
      if (findVoice(id).engine !== 'VOICEVOX')
        throw new Error('比較にはVOICEVOXの話者を指定してください。');
    });
  };
  if (saved.version === 2) {
    saved.candidates.forEach(checkCandidate);
    if (new Set(saved.candidates.map((item) => item.voiceId)).size !== saved.candidates.length)
      throw new Error('候補の設定が重複しています。');
    const candidateIds = new Set(saved.candidates.map((item) => item.voiceId));
    if (voice.engine === 'VOICEVOX' && !candidateIds.has(voice.id))
      throw new Error('選択中の話者の設定がありません。');
    if (saved.comparisonIds) {
      checkPair(saved.comparisonIds);
      if (saved.comparisonIds.some((id) => !candidateIds.has(id)))
        throw new Error('比較する候補の設定がありません。');
    }
    const chosen = saved.candidates.find((item) => item.voiceId === voice.id);
    if (
      chosen &&
      saved.parameters &&
      recipeFields.some(({ key }) => chosen.parameters[key] !== saved.parameters![key])
    )
      throw new Error('選択中の話者の設定が一致しません。');
    saved.evaluations.forEach((evaluation) => {
      evaluation.candidates.forEach(checkCandidate);
      checkPair(evaluation.candidates.map((item) => item.voiceId) as [string, string]);
    });
  }
  return saved;
}
