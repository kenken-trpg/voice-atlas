import { scriptSchema, serializeScript, type ScriptLine, type VoiceScript } from './script';
import { type ScriptRecastPlan } from './script-recast';

export type ScriptRecastSnapshot = {
  id: string;
  recordedAt: string;
  rows: { position: number; before: ScriptLine; after: ScriptLine }[];
};
export function makeRecastSnapshot(
  before: VoiceScript,
  plan: ScriptRecastPlan,
): ScriptRecastSnapshot {
  const original = scriptSchema.parse(before),
    changed = scriptSchema.parse(plan.script);
  if (!plan.changedIds.length || new Set(plan.changedIds).size !== plan.changedIds.length)
    throw new Error('差し替え記録の対象が不正です。');
  const rows = plan.changedIds.map((id) => {
    const position = original.lines.findIndex((line) => line.id === id),
      after = changed.lines.find((line) => line.id === id);
    if (position < 0 || !after) throw new Error('差し替え対象の行が見つかりません。');
    return { position: position + 1, before: original.lines[position], after };
  });
  return { id: crypto.randomUUID(), recordedAt: new Date().toISOString(), rows };
}
export function recastUndoIssues(script: VoiceScript, snapshot: ScriptRecastSnapshot) {
  return snapshot.rows.flatMap((row) => {
    const current = script.lines.find((line) => line.id === row.after.id);
    if (!current)
      return [{ id: row.after.id, reason: `記録時の第${row.position}行が削除されています。` }];
    if (JSON.stringify(current) !== JSON.stringify(row.after))
      return [
        {
          id: row.after.id,
          reason: `第${script.lines.indexOf(current) + 1}行のセリフ・声・発話者などが差し替え後に編集されています。`,
        },
      ];
    return [];
  });
}
export function undoScriptRecast(script: VoiceScript, snapshot: ScriptRecastSnapshot) {
  if (recastUndoIssues(script, snapshot).length)
    throw new Error(
      '対象行が変更または削除されています。後からの編集を保持するため、取り消しできません。',
    );
  const originals = new Map(snapshot.rows.map((row) => [row.before.id, row.before]));
  const restored = scriptSchema.parse({
    ...script,
    lines: script.lines.map((line) => originals.get(line.id) ?? line),
  });
  serializeScript(restored);
  return restored;
}
