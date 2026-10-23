import { z } from 'zod';
import { scriptAudioKey, scriptSchema, serializeScript, type VoiceScript } from './script';
export const pronunciationSchema = z.object({
  id: z.uuid(),
  term: z.string().trim().min(1).max(100),
  reading: z.string().trim().min(1).max(300),
});
export const pronunciationsSchema = z
  .array(pronunciationSchema)
  .max(100)
  .superRefine((items, ctx) => {
    if (
      new Set(items.map((p) => p.id)).size !== items.length ||
      new Set(items.map((p) => p.term)).size !== items.length
    )
      ctx.addIssue({ code: 'custom', message: '読み方のIDまたは表記が重複しています。' });
  });
export type Pronunciation = z.infer<typeof pronunciationSchema>;
export function replacePronunciations(text: string, rules: Pronunciation[]) {
  const sorted = [...pronunciationsSchema.parse(rules)].sort(
    (a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term),
  );
  let result = '',
    i = 0;
  while (i < text.length) {
    const rule = sorted.find((p) => text.startsWith(p.term, i));
    if (rule) {
      result += rule.reading;
      i += rule.term.length;
    } else {
      result += text[i];
      i++;
    }
  }
  return result;
}
export function planPronunciations(script: VoiceScript, rules: Pronunciation[]) {
  const parsed = scriptSchema.parse(script),
    validated = pronunciationsSchema.parse(rules);
  const changedIds: string[] = [],
    audioChangedIds: string[] = [];
  const next = scriptSchema.parse({
    ...parsed,
    lines: parsed.lines.map((line) => {
      if (line.spokenText !== undefined && line.readingSource !== 'dictionary') return line;
      const reading = replacePronunciations(line.text, validated);
      const updated = { ...line };
      if (reading === line.text) {
        delete updated.spokenText;
        delete updated.readingSource;
      } else {
        updated.spokenText = reading;
        updated.readingSource = 'dictionary';
      }
      if (JSON.stringify(line) !== JSON.stringify(updated)) changedIds.push(line.id);
      if (scriptAudioKey(line) !== scriptAudioKey(updated)) audioChangedIds.push(line.id);
      return updated;
    }),
  });
  serializeScript(next);
  return { script: next, changedIds, audioChangedIds, source: JSON.stringify([script, rules]) };
}
