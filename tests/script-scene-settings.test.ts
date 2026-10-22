import { describe, expect, it } from 'vitest';
import { scriptFixture } from './fixtures/script';
import { makeScriptLine, scriptAudioKey } from '../shared/script';
import { sceneSettingLines, planScriptScene } from '../shared/script-recast';
import { makeRecastSnapshot, undoScriptRecast } from '../shared/script-recast-history';

function fixture() {
  const base = scriptFixture();
  const scene = structuredClone(base.assignments[0]);
  scene.id = crypto.randomUUID();
  scene.scene = '緊迫';
  scene.comparison.entries[0].evaluation.candidates[0].recipe.speedScale = 1.2;
  const other = { ...base.assignments[0], id: crypto.randomUUID(), project: '別の物語' };
  const script = {
    ...base.script,
    gapMs: 420,
    lines: [
      { ...base.script.lines[0], spokenText: 'ほしよみのとう', readingSource: 'manual' as const },
      { ...makeScriptLine(base.assignments[0]), text: '通常のまま' },
      base.script.lines[1],
      { ...makeScriptLine(other), text: '別作品の同名人物' },
      { ...makeScriptLine(), character: '案内人', text: '未割り当て' },
      { ...makeScriptLine(base.assignments[0]), character: '語り手', text: '別の役名' },
    ],
  };
  return { base, script, scene };
}
describe('scene settings for selected script lines', () => {
  it('separates casting projects and explicit roles while allowing unassigned named lines', () => {
    const { script } = fixture();
    expect(sceneSettingLines(script, '物語', '案内人').map((line) => line.id)).toEqual(
      [0, 1, 4].map((index) => script.lines[index].id),
    );
    expect(sceneSettingLines(script, '別の物語', '案内人').map((line) => line.id)).toEqual(
      [3, 4].map((index) => script.lines[index].id),
    );
    expect(sceneSettingLines(script, '物語', '語り手').map((line) => line.id)).toEqual([
      script.lines[5].id,
    ]);
  });
  it('changes selected lines only, preserves readings and independent snapshots, and supports undo', () => {
    const { script, scene } = fixture();
    const before = structuredClone(script);
    const plan = planScriptScene(script, scene, [script.lines[4].id, script.lines[0].id]);
    expect(plan.targetedIds).toEqual([script.lines[0].id, script.lines[4].id]);
    expect(plan.changedIds).toEqual(plan.targetedIds);
    expect(plan.audioChangedIds).toEqual(plan.targetedIds);
    expect(plan.script.lines[0].spokenText).toBe(script.lines[0].spokenText);
    expect(plan.script.lines[0].readingSource).toBe('manual');
    expect(plan.script.lines.map((line) => [line.id, line.text])).toEqual(
      script.lines.map((line) => [line.id, line.text]),
    );
    expect(plan.script.gapMs).toBe(420);
    for (const index of [1, 2, 3, 5]) expect(plan.script.lines[index]).toEqual(script.lines[index]);
    expect(undoScriptRecast(plan.script, makeRecastSnapshot(script, plan))).toEqual(before);
    plan.script.lines[0].assignment!.scene = '編集';
    expect(plan.script.lines[4].assignment!.scene).toBe('緊迫');
    expect(scene.scene).toBe('緊迫');
    expect(script).toEqual(before);
  });
  it('retains audio for the same voice and tuning and rejects stale, duplicate or unrelated selections', () => {
    const { base, script, scene } = fixture();
    const same = { ...base.assignments[0], id: crypto.randomUUID(), scene: '通常' };
    const plan = planScriptScene(script, same, [script.lines[0].id]);
    expect(plan.audioChangedIds).toEqual([]);
    expect(plan.changedIds).toEqual([script.lines[0].id]);
    expect(scriptAudioKey(plan.script.lines[0])).toBe(scriptAudioKey(script.lines[0]));
    expect(planScriptScene(script, base.assignments[0], [script.lines[0].id]).changedIds).toEqual(
      [],
    );
    for (const ids of [
      [],
      [script.lines[0].id, script.lines[0].id],
      [crypto.randomUUID()],
      [script.lines[2].id],
      [script.lines[3].id],
      [script.lines[5].id],
    ]) {
      expect(() => planScriptScene(script, scene, ids)).toThrow();
    }
    const invalid = structuredClone(scene);
    invalid.comparison.selectedId = crypto.randomUUID();
    expect(() => planScriptScene(script, invalid, [script.lines[0].id])).toThrow();
  });
});
