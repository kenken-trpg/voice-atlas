import { type CastingAssignment } from './casting-board';
import { scriptSchema, type VoiceScript } from './script';
import { planScriptRecast, scriptCharacter, type ScriptRecastPlan } from './script-recast';

export function unassignedSpeakers(script: VoiceScript) {
  const groups = new Map<string, { character: string; unassigned: number; assigned: number }>();
  for (const line of script.lines) {
    const character = scriptCharacter(line);
    if (!character) continue;
    const group = groups.get(character) ?? { character, unassigned: 0, assigned: 0 };
    if (line.assignment) group.assigned++;
    else group.unassigned++;
    groups.set(character, group);
  }
  return [...groups.values()].filter((group) => group.unassigned > 0);
}

export function planScriptCasting(
  script: VoiceScript,
  assignments: CastingAssignment[],
  choices: { character: string; assignmentId: string }[],
  overwriteAssigned = false,
): ScriptRecastPlan {
  const parsed = scriptSchema.parse(script);
  const available = new Set(unassignedSpeakers(parsed).map((group) => group.character));
  if (!choices.length || new Set(choices.map((choice) => choice.character)).size !== choices.length)
    throw new Error('配役する発話者を重複なく選択してください。');
  let next = parsed;
  const targetedIds: string[] = [],
    changedIds: string[] = [],
    audioChangedIds: string[] = [];
  for (const choice of choices) {
    const targets = assignments.filter((assignment) => assignment.id === choice.assignmentId);
    if (!available.has(choice.character) || targets.length !== 1)
      throw new Error('発話者またはキャスティング表の設定が変わりました。選び直してください。');
    const plan = planScriptRecast(
      next,
      choice.character,
      overwriteAssigned ? 'all' : 'unassigned',
      targets[0],
    );
    next = plan.script;
    targetedIds.push(...plan.targetedIds);
    changedIds.push(...plan.changedIds);
    audioChangedIds.push(...plan.audioChangedIds);
  }
  const inOrder = (ids: string[]) =>
    parsed.lines.filter((line) => ids.includes(line.id)).map((line) => line.id);
  return {
    script: next,
    targetedIds: inOrder(targetedIds),
    changedIds: inOrder(changedIds),
    audioChangedIds: inOrder(audioChangedIds),
  };
}
