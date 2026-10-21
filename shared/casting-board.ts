import { z } from 'zod';
import { libraryComparisonRecordSchema, type LibraryComparisonRecord } from './library-comparison';
import { libraryCandidate, type VoiceLibraryEntry } from './voice-library';

export const castingBoardStorageKey = 'voice-atlas-casting-board-v1';
export const maxCastingBoardBytes = 8 * 1024 * 1024;
export const castingAssignmentSchema = z.object({
  id: z.uuid(),
  project: z.string().trim().min(1).max(100),
  character: z.string().trim().min(1).max(100),
  scene: z.string().trim().min(1).max(200),
  assignedAt: z.iso.datetime(),
  comparison: libraryComparisonRecordSchema,
});
export type CastingAssignment = z.infer<typeof castingAssignmentSchema>;
export const castingBoardSchema = z
  .object({
    format: z.literal('voice-atlas-casting-board'),
    version: z.literal(1),
    assignments: z.array(castingAssignmentSchema).max(100),
  })
  .superRefine(({ assignments }, ctx) => {
    const ids = new Set<string>(),
      keys = new Set<string>();
    for (const item of assignments) {
      const key = JSON.stringify([item.project, item.character, item.scene]);
      if (ids.has(item.id) || keys.has(key))
        ctx.addIssue({
          code: 'custom',
          message: '登録IDまたは作品・キャラクター・場面が重複しています。',
        });
      ids.add(item.id);
      keys.add(key);
    }
  });
export function assignmentEntry(item: CastingAssignment): VoiceLibraryEntry {
  const entry = structuredClone(
    item.comparison.entries.find((e) => e.id === item.comparison.selectedId)!,
  );
  const index = item.comparison.entries.findIndex((e) => e.id === entry.id);
  // Load the evidence from this audition rather than the original library registration.
  const candidate = libraryCandidate(entry);
  delete candidate.modelInfo;
  const model = item.comparison.auditions[index].modelInfo;
  if (model) candidate.modelInfo = structuredClone(model);
  if (entry.variation) {
    entry.variation.text = item.comparison.text;
    entry.variation.generation = structuredClone(item.comparison.auditions[index].generation);
  } else {
    entry.evaluation.text = item.comparison.text;
    entry.evaluation.generations[entry.evaluation.outcome === 'a' ? 0 : 1] = structuredClone(
      item.comparison.auditions[index].generation,
    );
  }
  return entry;
}
export function makeCastingAssignment(
  comparison: LibraryComparisonRecord,
  project: string,
  character: string,
  scene: string,
) {
  return castingAssignmentSchema.parse({
    id: crypto.randomUUID(),
    assignedAt: new Date().toISOString(),
    comparison,
    project,
    character,
    scene,
  });
}
export function serializeCastingBoard(assignments: CastingAssignment[]) {
  const text = JSON.stringify(
    castingBoardSchema.parse({ format: 'voice-atlas-casting-board', version: 1, assignments }),
    null,
    2,
  );
  if (new TextEncoder().encode(text).length > maxCastingBoardBytes)
    throw new Error('キャスティング表JSONは8MiB以下にしてください。');
  return text;
}
export function parseCastingBoard(text: string) {
  if (new TextEncoder().encode(text).length > maxCastingBoardBytes)
    throw new Error('キャスティング表JSONは8MiB以下にしてください。');
  return castingBoardSchema.parse(JSON.parse(text)).assignments;
}
