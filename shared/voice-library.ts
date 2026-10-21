import { z } from 'zod';
import {
  castingEvaluationSchema,
  castingCandidateSchema,
  castingKey,
  type CastingEvaluation,
  type CastingCandidate,
} from './casting';

export const libraryStorageKey = 'voice-atlas-voice-library-v1';
export const maxLibraryBytes = 4 * 1024 * 1024;
export const voiceLibraryEntrySchema = z.object({
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
export type VoiceLibraryEntry = z.infer<typeof voiceLibraryEntrySchema>;
export const voiceLibrarySchema = z
  .object({
    format: z.literal('voice-atlas-voice-library'),
    version: z.literal(1),
    entries: z.array(voiceLibraryEntrySchema).max(100),
  })
  .refine(
    (value) => new Set(value.entries.map((e) => e.id)).size === value.entries.length,
    '登録IDが重複しています。',
  );
export function libraryCandidate(entry: VoiceLibraryEntry): CastingCandidate {
  return entry.evaluation.candidates[entry.evaluation.outcome === 'a' ? 0 : 1];
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
    voiceLibrarySchema.parse({ format: 'voice-atlas-voice-library', version: 1, entries }),
    null,
    2,
  );
  if (new TextEncoder().encode(text).length > maxLibraryBytes)
    throw new Error('ライブラリは4MiB以下にしてください。');
  return text;
}
export function parseLibrary(text: string) {
  if (new TextEncoder().encode(text).length > maxLibraryBytes)
    throw new Error('ライブラリは4MiB以下にしてください。');
  return voiceLibrarySchema.parse(JSON.parse(text)).entries;
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
    text: parsed.evaluation.text,
    context: {
      profile: parsed.evaluation.profile,
      characterInput: parsed.evaluation.characterInput,
    },
  };
}
