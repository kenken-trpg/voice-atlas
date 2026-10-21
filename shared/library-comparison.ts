import { z } from 'zod';
import { voiceLibraryEntrySchema, libraryCandidate, type VoiceLibraryEntry } from './voice-library';
import { generationSchema, castingRecipeFields } from './casting';
import { aivisModelInfoSchema } from './aivis-model-info';

export const libraryComparisonStorageKey = 'voice-atlas-library-comparisons-v1';
export const maxLibraryComparisonBytes = 8 * 1024 * 1024;
export const libraryComparisonPairSchema = z
  .tuple([voiceLibraryEntrySchema, voiceLibraryEntrySchema])
  .refine((pair) => pair[0].id !== pair[1].id, '異なる2つの登録を選んでください。');
export const libraryAuditionSchema = z.object({
  generation: generationSchema.nullable(),
  modelInfo: aivisModelInfoSchema.optional(),
});
export type LibraryAudition = z.infer<typeof libraryAuditionSchema>;
export const libraryComparisonRecordSchema = z
  .object({
    id: z.uuid(),
    recordedAt: z.iso.datetime(),
    entries: libraryComparisonPairSchema,
    text: z.string().trim().min(1).max(300),
    scene: z.string().trim().max(200),
    reason: z.string().trim().min(1).max(1000),
    selectedId: z.uuid(),
    auditions: z.tuple([libraryAuditionSchema, libraryAuditionSchema]),
  })
  .superRefine((record, ctx) => {
    if (!record.entries.some((entry) => entry.id === record.selectedId))
      ctx.addIssue({ code: 'custom', message: '選択した登録が比較に含まれていません。' });
    record.auditions.forEach((audition, index) => {
      const voice = libraryCandidate(record.entries[index]).voice;
      if (
        (audition.generation && audition.generation.engine !== voice.engine) ||
        (audition.modelInfo &&
          (voice.engine !== 'AivisSpeech' ||
            audition.modelInfo.speakerUuid.toLowerCase() !== voice.speakerUuid.toLowerCase() ||
            audition.modelInfo.styleName !== voice.style))
      )
        ctx.addIssue({ code: 'custom', message: '試聴時の情報と話者・製品が一致しません。' });
    });
  });
export type LibraryComparisonRecord = z.infer<typeof libraryComparisonRecordSchema>;
export const libraryComparisonSessionSchema = z
  .object({
    format: z.literal('voice-atlas-library-comparison'),
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    entries: libraryComparisonPairSchema.nullable(),
    text: z.string().max(300),
    scene: z.string().max(200),
    reason: z.string().max(1000),
    selectedId: z.uuid().nullable(),
    records: z.array(libraryComparisonRecordSchema).max(100),
  })
  .superRefine((session, ctx) => {
    if (
      (session.selectedId && !session.entries?.some((entry) => entry.id === session.selectedId)) ||
      new Set(session.records.map((record) => record.id)).size !== session.records.length
    )
      ctx.addIssue({ code: 'custom', message: '比較の識別情報が一致しません。' });
  });
export type LibraryComparisonSession = z.infer<typeof libraryComparisonSessionSchema>;
export function serializeLibraryComparison(session: LibraryComparisonSession) {
  const text = JSON.stringify(libraryComparisonSessionSchema.parse(session), null, 2);
  if (new TextEncoder().encode(text).length > maxLibraryComparisonBytes)
    throw new Error('設定比較JSONは8MiB以下にしてください。');
  return text;
}
export function parseLibraryComparison(text: string) {
  if (new TextEncoder().encode(text).length > maxLibraryComparisonBytes)
    throw new Error('設定比較JSONは8MiB以下にしてください。');
  return libraryComparisonSessionSchema.parse(JSON.parse(text));
}
export function makeLibraryComparisonRecord(
  input: Omit<LibraryComparisonRecord, 'id' | 'recordedAt'>,
) {
  return libraryComparisonRecordSchema.parse({
    ...input,
    id: crypto.randomUUID(),
    recordedAt: new Date().toISOString(),
  });
}
export function formatLibraryComparisonValue(value: number) {
  return Number(value.toFixed(2)) === value ? value.toFixed(2) : String(value);
}
export function libraryRecipeDifferences(entries: [VoiceLibraryEntry, VoiceLibraryEntry]) {
  const candidates = entries.map(libraryCandidate);
  const fields = candidates.map(castingRecipeFields);
  const keys = [...new Set(fields.flatMap((group) => group.map((field) => field.key)))];
  const sameEngine = candidates[0].recipe.engine === candidates[1].recipe.engine;
  return keys.flatMap((key) => {
    const a = fields[0].find((field) => field.key === key),
      b = fields[1].find((field) => field.key === key);
    const va = a ? Number((candidates[0].recipe as unknown as Record<string, number>)[key]) : null;
    const vb = b ? Number((candidates[1].recipe as unknown as Record<string, number>)[key]) : null;
    if (sameEngine && va === vb) return [];
    return [
      {
        key,
        a: a ? `${a.label}：${formatLibraryComparisonValue(va!)}${a.unit}` : '対応項目なし',
        b: b ? `${b.label}：${formatLibraryComparisonValue(vb!)}${b.unit}` : '対応項目なし',
        delta: sameEngine && va !== null && vb !== null ? Number((vb - va).toPrecision(12)) : null,
      },
    ];
  });
}
