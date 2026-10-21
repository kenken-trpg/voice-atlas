import { z } from 'zod';
import { castingAssignmentSchema, type CastingAssignment } from './casting-board';
import { libraryCandidate } from './voice-library';

export const scriptStorageKey = 'voice-atlas-script-v1';
export const maxScriptBytes = 8 * 1024 * 1024;
export const scriptLineSchema = z.object({
  id: z.uuid(),
  assignment: castingAssignmentSchema.nullable(),
  text: z.string().max(300),
});
export type ScriptLine = z.infer<typeof scriptLineSchema>;
export const scriptSchema = z
  .object({
    format: z.literal('voice-atlas-script'),
    version: z.literal(1),
    title: z.string().max(100),
    gapMs: z.number().int().min(0).max(5000).default(300),
    lines: z.array(scriptLineSchema).max(20),
  })
  .refine(
    (value) => new Set(value.lines.map((line) => line.id)).size === value.lines.length,
    '台本の行IDが重複しています。',
  );
export type VoiceScript = z.infer<typeof scriptSchema>;
export function emptyScript(): VoiceScript {
  return { format: 'voice-atlas-script', version: 1, title: '', gapMs: 300, lines: [] };
}
export function makeScriptLine(assignment: CastingAssignment | null = null): ScriptLine {
  return scriptLineSchema.parse({ id: crypto.randomUUID(), assignment, text: '' });
}
export function scriptCandidate(line: ScriptLine) {
  if (!line.assignment) return null;
  const record = line.assignment.comparison;
  const index = record.entries.findIndex((entry) => entry.id === record.selectedId);
  const candidate = libraryCandidate(record.entries[index]);
  return {
    voice: candidate.voice,
    recipe: candidate.recipe,
    ...(record.auditions[index].modelInfo ? { modelInfo: record.auditions[index].modelInfo } : {}),
  };
}
export function scriptAudioKey(line: ScriptLine) {
  const candidate = scriptCandidate(line);
  return JSON.stringify([line.id, line.text, candidate?.voice, candidate?.recipe]);
}
export function serializeScript(script: VoiceScript) {
  const text = JSON.stringify(scriptSchema.parse(script), null, 2);
  if (new TextEncoder().encode(text).length > maxScriptBytes)
    throw new Error('台本JSONは8MiB以下にしてください。');
  return text;
}
export function parseScript(text: string) {
  if (new TextEncoder().encode(text).length > maxScriptBytes)
    throw new Error('台本JSONは8MiB以下にしてください。');
  return scriptSchema.parse(JSON.parse(text));
}
