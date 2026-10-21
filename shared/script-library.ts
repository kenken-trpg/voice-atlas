import { z } from 'zod';
import { scriptSchema, serializeScript, type VoiceScript } from './script';
export const scriptLibraryStorageKey = 'voice-atlas-script-library-v1';
export const maxScriptLibraryBytes = 16 * 1024 * 1024;
export const scriptLibraryEntrySchema = z.object({
  id: z.uuid(),
  project: z.string().trim().min(1).max(100),
  scene: z.string().trim().min(1).max(200),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  script: scriptSchema.refine((script) => !!script.title.trim(), '台本名を入力してください。'),
});
export type ScriptLibraryEntry = z.infer<typeof scriptLibraryEntrySchema>;
export const scriptLibrarySchema = z
  .object({
    format: z.literal('voice-atlas-script-library'),
    version: z.literal(1),
    entries: z.array(scriptLibraryEntrySchema).max(30),
  })
  .refine(
    (value) => new Set(value.entries.map((entry) => entry.id)).size === value.entries.length,
    '台本の登録IDが重複しています。',
  );
export function makeScriptLibraryEntry(
  script: VoiceScript,
  project: string,
  scene: string,
  existing?: ScriptLibraryEntry,
) {
  serializeScript(script);
  const now = new Date().toISOString();
  return scriptLibraryEntrySchema.parse({
    id: existing?.id ?? crypto.randomUUID(),
    project,
    scene,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    script,
  });
}
export function duplicateScriptEntry(entry: ScriptLibraryEntry) {
  const source = scriptLibraryEntrySchema.parse(entry);
  const copy = {
    ...source.script,
    title: `${source.script.title.slice(0, 94)}（コピー）`,
    lines: source.script.lines.map((line) => ({ ...line, id: crypto.randomUUID() })),
  };
  return makeScriptLibraryEntry(copy, source.project, source.scene);
}
export function serializeScriptLibrary(entries: ScriptLibraryEntry[]) {
  const parsed = scriptLibrarySchema.parse({
    format: 'voice-atlas-script-library',
    version: 1,
    entries,
  });
  parsed.entries.forEach((entry) => serializeScript(entry.script));
  const text = JSON.stringify(parsed, null, 2);
  if (new TextEncoder().encode(text).length > maxScriptLibraryBytes)
    throw new Error('台本ライブラリJSONは16MiB以下にしてください。');
  return text;
}
export function parseScriptLibrary(text: string) {
  if (new TextEncoder().encode(text).length > maxScriptLibraryBytes)
    throw new Error('台本ライブラリJSONは16MiB以下にしてください。');
  const parsed = scriptLibrarySchema.parse(JSON.parse(text));
  parsed.entries.forEach((entry) => serializeScript(entry.script));
  return parsed.entries;
}
export function mergeScriptLibrary(existing: ScriptLibraryEntry[], incoming: ScriptLibraryEntry[]) {
  const next = [...existing];
  for (const entry of incoming) {
    const found = next.find((item) => item.id === entry.id);
    if (found && JSON.stringify(found) !== JSON.stringify(entry))
      throw new Error('同じ登録IDの異なる台本があります。現在のライブラリは変更していません。');
    if (!found) next.push(entry);
  }
  return parseScriptLibrary(serializeScriptLibrary(next));
}
