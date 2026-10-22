import { castingAssignmentSchema, type CastingAssignment } from './casting-board';
import {
  scriptAudioKey,
  scriptCandidate,
  scriptSchema,
  serializeScript,
  type ScriptLine,
  type VoiceScript,
} from './script';

export function scriptCharacter(line: ScriptLine) {
  return line.character ?? line.assignment?.character ?? null;
}
// Registration identity alone is insufficient: rows may contain different saved versions.
export function scriptSettingKey(line: ScriptLine) {
  const candidate = scriptCandidate(line);
  return line.assignment
    ? JSON.stringify([line.assignment.id, candidate?.voice, candidate?.recipe])
    : 'unassigned';
}
export function recastGroups(script: VoiceScript, character: string) {
  const groups = new Map<string, { key: string; line: ScriptLine; count: number }>();
  for (const line of script.lines) {
    if (scriptCharacter(line) !== character) continue;
    const key = scriptSettingKey(line),
      group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { key, line, count: 1 });
  }
  return [...groups.values()];
}
export function planScriptRecast(
  script: VoiceScript,
  character: string,
  source: string,
  replacement: CastingAssignment,
) {
  const parsed = scriptSchema.parse(script),
    assignment = castingAssignmentSchema.parse(replacement);
  const targeted = parsed.lines.filter(
    (line) =>
      scriptCharacter(line) === character &&
      (source === 'all' || scriptSettingKey(line) === source),
  );
  if (!character || !targeted.length)
    throw new Error('差し替え対象の発話者と設定を選んでください。');
  const ids = new Set(targeted.map((line) => line.id));
  const changedIds: string[] = [],
    audioChangedIds: string[] = [];
  const next = scriptSchema.parse({
    ...parsed,
    lines: parsed.lines.map((line) => {
      if (!ids.has(line.id) || JSON.stringify(line.assignment) === JSON.stringify(assignment))
        return line;
      const updated = { ...line, character: scriptCharacter(line)!, assignment };
      changedIds.push(line.id);
      if (scriptAudioKey(updated) !== scriptAudioKey(line)) audioChangedIds.push(line.id);
      return updated;
    }),
  });
  serializeScript(next);
  return { script: next, targetedIds: [...ids], changedIds, audioChangedIds };
}
export type ScriptRecastPlan = ReturnType<typeof planScriptRecast>;
