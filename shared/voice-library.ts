import { z } from 'zod';
import {
  castingEvaluationSchema,
  castingCandidateSchema,
  castingKey,
  type CastingEvaluation,
  type CastingCandidate,
  historicalCastingCandidateSchema,
  generationSchema,
} from './casting';
import { profileSchema, characterInputSchema } from './schema';

export const libraryStorageKey = 'voice-atlas-voice-library-v1';
export const maxLibraryBytes = 4 * 1024 * 1024;
const originalEntrySchema = z.object({
  id: z.uuid(),
  characterName: z.string().trim().min(1).max(100),
  settingName: z.string().trim().min(1).max(100),
  memo: z.string().max(1000),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  evaluation: castingEvaluationSchema.refine(
    (e) => e.outcome === 'a' || e.outcome === 'b',
    '採用した声が必要です。',
  ),
});
export const voiceVariationSchema = z
  .object({
    candidate: historicalCastingCandidateSchema,
    text: z.string().trim().min(1).max(300),
    generation: generationSchema.nullable(),
    profile: profileSchema,
    characterInput: characterInputSchema.nullable(),
    reason: z.string().trim().min(1).max(1000),
    parent: z.object({
      id: z.uuid(),
      characterName: z.string().trim().min(1).max(100),
      settingName: z.string().trim().min(1).max(100),
      candidate: historicalCastingCandidateSchema,
      text: z.string().min(1).max(300),
    }),
  })
  .refine(
    (v) => castingKey(v.candidate.voice) === castingKey(v.parent.candidate.voice),
    '派生元と同じ話者・スタイルを指定してください。',
  )
  .refine(
    (v) => !v.generation || v.generation.engine === v.candidate.voice.engine,
    '生成情報の製品が一致しません。',
  );
export const voiceLibraryEntrySchema = originalEntrySchema
  .extend({ variation: voiceVariationSchema.optional() })
  .refine((e) => !e.variation || e.variation.parent.id !== e.id, '自身を派生元にはできません。');
export type VoiceLibraryEntry = z.infer<typeof voiceLibraryEntrySchema>;
export const voiceLibrarySchema = z
  .object({
    format: z.literal('voice-atlas-voice-library'),
    version: z.literal(2),
    entries: z.array(voiceLibraryEntrySchema).max(100),
  })
  .refine(
    (value) => new Set(value.entries.map((e) => e.id)).size === value.entries.length,
    '登録IDが重複しています。',
  );
export function libraryCandidate(entry: VoiceLibraryEntry): CastingCandidate {
  return (
    entry.variation?.candidate ??
    entry.evaluation.candidates[entry.evaluation.outcome === 'a' ? 0 : 1]
  );
}
export function libraryText(entry: VoiceLibraryEntry) {
  return entry.variation?.text ?? entry.evaluation.text;
}
export function libraryContext(entry: VoiceLibraryEntry) {
  const source = entry.variation ?? entry.evaluation;
  return { profile: source.profile, characterInput: source.characterInput };
}
export function libraryGeneration(entry: VoiceLibraryEntry) {
  return entry.variation
    ? entry.variation.generation
    : entry.evaluation.generations[entry.evaluation.outcome === 'a' ? 0 : 1];
}
export function makeVoiceVariation(
  parent: VoiceLibraryEntry,
  snapshot: Omit<z.infer<typeof voiceVariationSchema>, 'parent'>,
  settingName: string,
  memo: string,
) {
  const parsed = voiceLibraryEntrySchema.parse(parent);
  const now = new Date().toISOString();
  return voiceLibraryEntrySchema.parse({
    id: crypto.randomUUID(),
    characterName: parsed.characterName,
    settingName,
    memo,
    createdAt: now,
    updatedAt: now,
    evaluation: parsed.evaluation,
    variation: {
      ...snapshot,
      parent: {
        id: parsed.id,
        characterName: parsed.characterName,
        settingName: parsed.settingName,
        candidate: libraryCandidate(parsed),
        text: libraryText(parsed),
      },
    },
  });
}
export function makeLibraryEntry(
  evaluation: CastingEvaluation,
  characterName: string,
  settingName: string,
  memo: string,
): VoiceLibraryEntry {
  const now = new Date().toISOString();
  return voiceLibraryEntrySchema.parse({
    id: crypto.randomUUID(),
    characterName,
    settingName,
    memo,
    createdAt: now,
    updatedAt: now,
    evaluation,
  });
}
export function serializeLibrary(entries: VoiceLibraryEntry[]) {
  const text = JSON.stringify(
    voiceLibrarySchema.parse({ format: 'voice-atlas-voice-library', version: 2, entries }),
    null,
    2,
  );
  if (new TextEncoder().encode(text).length > maxLibraryBytes)
    throw new Error('ライブラリは4MiB以下にしてください。');
  return text;
}
export function parseLibrary(text: string): VoiceLibraryEntry[] {
  if (new TextEncoder().encode(text).length > maxLibraryBytes)
    throw new Error('ライブラリは4MiB以下にしてください。');
  const raw = JSON.parse(text);
  if (raw?.version === 1) {
    return z
      .object({
        format: z.literal('voice-atlas-voice-library'),
        version: z.literal(1),
        entries: z.array(originalEntrySchema.strict()).max(100),
      })
      .refine((v) => new Set(v.entries.map((e) => e.id)).size === v.entries.length)
      .parse(raw).entries;
  }
  return voiceLibrarySchema.parse(raw).entries;
}
export function loadLibraryCandidate(
  existing: Record<string, CastingCandidate>,
  pair: [string, string] | null,
  entry: VoiceLibraryEntry,
  slot: 0 | 1,
) {
  const parsed = voiceLibraryEntrySchema.parse(entry);
  const validated = castingCandidateSchema.safeParse(libraryCandidate(parsed));
  if (!validated.success)
    throw new Error('現在のカタログで利用できない話者・スタイルです。登録は保持しています。');
  const candidate = validated.data;
  const key = castingKey(candidate.voice);
  if (pair && pair[1 - slot] === key)
    throw new Error('もう一方の候補と同じ話者・スタイルです。別の候補を選んでください。');
  const candidates = { ...existing, [key]: candidate };
  if (Object.keys(candidates).length > 200) throw new Error('比較候補は200件までです。');
  const other = pair?.[1 - slot] ?? Object.keys(candidates).find((k) => k !== key);
  return {
    candidates,
    pair: other ? ((slot === 0 ? [key, other] : [other, key]) as [string, string]) : null,
    key,
    text: libraryText(parsed),
    context: libraryContext(parsed),
  };
}
