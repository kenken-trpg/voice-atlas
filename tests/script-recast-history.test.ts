import { describe, expect, it } from 'vitest';
import { scriptFixture } from './fixtures/script';
import { makeScriptLine } from '../shared/script';
import { planScriptRecast } from '../shared/script-recast';
import {
  makeRecastSnapshot,
  recastUndoIssues,
  undoScriptRecast,
} from '../shared/script-recast-history';
function fixture() {
  const { script, assignments } = scriptFixture();
  const plan = planScriptRecast(script, '案内人', 'all', assignments[1]);
  return { script, plan, snapshot: makeRecastSnapshot(script, plan) };
}
describe('script recast undo', () => {
  it('restores the original nested settings including the implicit character', () => {
    const { script, plan, snapshot } = fixture();
    expect(snapshot.rows).toHaveLength(1);
    expect(undoScriptRecast(plan.script, snapshot)).toEqual(script);
    plan.script.lines[0].assignment!.character = '後から変更';
    script.lines[0].assignment!.character = '元も変更';
    expect(snapshot.rows[0].before.assignment!.character).toBe('案内人');
    expect(snapshot.rows[0].after.assignment!.character).toBe('騎士');
  });
  it('retains title, gap, additions, ordering and unrelated edits', () => {
    const { script, plan, snapshot } = fixture();
    const extra = makeScriptLine();
    const current = {
      ...plan.script,
      title: '新しい題',
      gapMs: 900,
      lines: [{ ...plan.script.lines[1], text: '別の編集' }, extra, plan.script.lines[0]],
    };
    const restored = undoScriptRecast(current, snapshot);
    expect(restored).toEqual({ ...current, lines: [current.lines[0], extra, script.lines[0]] });
    restored.lines[2].assignment!.character = '再編集';
    expect(snapshot.rows[0].before.assignment!.character).toBe('案内人');
  });
  it.each(['text', 'character', 'assignment'] as const)('blocks later changes to %s', (field) => {
    const { plan, snapshot } = fixture();
    const current = structuredClone(plan.script);
    if (field === 'assignment') current.lines[0].assignment = null;
    else current.lines[0][field] = '後から編集';
    expect(recastUndoIssues(current, snapshot)).toHaveLength(1);
    expect(() => undoScriptRecast(current, snapshot)).toThrow('対象行が変更または削除');
  });
  it('does not recreate a deleted row', () => {
    const { plan, snapshot } = fixture();
    const current = { ...plan.script, lines: plan.script.lines.slice(1) };
    expect(recastUndoIssues(current, snapshot)[0].reason).toContain('削除');
    expect(() => undoScriptRecast(current, snapshot)).toThrow();
  });
  it('rejects empty, duplicate or missing snapshot targets', () => {
    const { script, plan } = fixture();
    for (const changedIds of [[], [plan.changedIds[0], plan.changedIds[0]], [crypto.randomUUID()]])
      expect(() => makeRecastSnapshot(script, { ...plan, changedIds })).toThrow();
  });
});
