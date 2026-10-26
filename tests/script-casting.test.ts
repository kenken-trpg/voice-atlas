import { makeImportedScript, resolveScriptImport } from '../shared/script-import';
import { describe, it, expect } from 'vitest';
import { scriptFixture } from './fixtures/script';
import { makeScriptLine, scriptAudioKey } from '../shared/script';
import { planScriptCasting, unassignedSpeakers } from '../shared/script-casting';
import { makeRecastSnapshot, undoScriptRecast } from '../shared/script-recast-history';
function fixture() {
  const base = scriptFixture();
  return {
    ...base,
    script: {
      ...base.script,
      gapMs: 750,
      lines: [
        ...base.script.lines,
        {
          ...makeScriptLine(),
          character: '案内人',
          text: '名前を呼ぶ',
          spokenText: 'なまえをよぶ',
          readingSource: 'manual' as const,
        },
        { ...makeScriptLine(), character: '案内人', text: '続けて話す' },
        { ...makeScriptLine(), character: '店主', text: 'いらっしゃい' },
        { ...makeScriptLine(), text: '名前なし' },
      ],
    },
  };
}
describe('batch casting unassigned speakers', () => {
  it('groups only speakers with unassigned rows and counts assigned rows without grouping unnamed rows', () => {
    const { script } = fixture();
    expect(unassignedSpeakers(script)).toEqual([
      { character: '案内人', unassigned: 2, assigned: 1 },
      { character: '店主', unassigned: 1, assigned: 0 },
    ]);
  });
  it('applies multiple speakers in script order, preserves existing assignments, readings, names and source data', () => {
    const { script, assignments } = fixture();
    const before = structuredClone(script);
    const plan = planScriptCasting(script, assignments, [
      { character: '店主', assignmentId: assignments[0].id },
      { character: '案内人', assignmentId: assignments[1].id },
    ]);
    expect(plan.changedIds).toEqual(script.lines.slice(2, 5).map((line) => line.id));
    expect(plan.audioChangedIds).toEqual(plan.changedIds);
    expect(plan.script.lines.slice(0, 2)).toEqual(script.lines.slice(0, 2));
    expect(plan.script.lines[5]).toEqual(script.lines[5]);
    expect(
      plan.script.lines.map(({ id, text, spokenText, readingSource, character }) => ({
        id,
        text,
        spokenText,
        readingSource,
        character,
      })),
    ).toEqual(
      script.lines.map(({ id, text, spokenText, readingSource, character }) => ({
        id,
        text,
        spokenText,
        readingSource,
        character,
      })),
    );
    expect(plan.script.gapMs).toBe(750);
    expect(script).toEqual(before);
    const snapshot = makeRecastSnapshot(script, plan);
    expect(undoScriptRecast(plan.script, snapshot)).toEqual(script);
  });
  it('overwrites assigned rows only with explicit opt-in and only for selected speakers', () => {
    const { script, assignments } = fixture();
    const plan = planScriptCasting(
      script,
      assignments,
      [{ character: '案内人', assignmentId: assignments[1].id }],
      true,
    );
    expect(plan.targetedIds).toEqual([script.lines[0].id, script.lines[2].id, script.lines[3].id]);
    expect(plan.changedIds).toEqual(plan.targetedIds);
    expect(plan.script.lines[1]).toEqual(script.lines[1]);
    expect(plan.script.lines[4]).toEqual(script.lines[4]);
  });
  it('preserves the audio key for assigned rows with identical voice settings despite changed metadata', () => {
    const { script, assignments } = fixture();
    const target = { ...assignments[0], id: crypto.randomUUID(), scene: '別場面' };
    const plan = planScriptCasting(
      script,
      [...assignments, target],
      [{ character: '案内人', assignmentId: target.id }],
      true,
    );
    expect(plan.changedIds).toContain(script.lines[0].id);
    expect(plan.audioChangedIds).not.toContain(script.lines[0].id);
    expect(scriptAudioKey(plan.script.lines[0])).toBe(scriptAudioKey(script.lines[0]));
  });
  it('rejects empty, duplicate, obsolete or ambiguous choices atomically', () => {
    const { script, assignments } = fixture();
    const choice = { character: '案内人', assignmentId: assignments[0].id };
    for (const choices of [
      [],
      [choice, choice],
      [{ ...choice, character: '騎士' }],
      [{ ...choice, assignmentId: 'missing' }],
      [choice, { ...choice, character: 'missing' }],
    ])
      expect(() => planScriptCasting(script, assignments, choices)).toThrow();
    expect(() => planScriptCasting(script, [...assignments, assignments[0]], [choice])).toThrow();
    expect(script.lines[2].assignment).toBeNull();
  });
});

describe('explicit deferred casting on import', () => {
  it('imports unresolved names only with opt-in and then assigns all three speakers', () => {
    const { assignments } = scriptFixture();
    const names = ['役A', '役B', '役C'];
    const rows = Array.from({ length: 10 }, (_, index) => ({
      character: names[index % 3],
      text: `セリフ${index + 1}`,
    }));
    expect(() =>
      makeImportedScript('場面', 300, rows, assignments, { project: '', scene: '' }, new Map()),
    ).toThrow();
    const imported = makeImportedScript(
      '場面',
      300,
      rows,
      assignments,
      { project: '', scene: '' },
      new Map(),
      true,
    );
    expect(imported.lines.every((line) => line.assignment === null)).toBe(true);
    const plan = planScriptCasting(
      imported,
      assignments,
      names.map((character, index) => ({ character, assignmentId: assignments[index % 2].id })),
    );
    expect(plan.changedIds).toHaveLength(10);
    expect(plan.script.lines.every((line) => line.assignment)).toBe(true);
  });
  it('still rejects stale explicit selections and malformed dialogue with deferred casting enabled', () => {
    const { assignments } = scriptFixture();
    const rows = [{ character: '役A', text: '台詞' }];
    expect(
      resolveScriptImport(
        rows,
        assignments,
        { project: '', scene: '' },
        new Map([['役A', 'deleted']]),
        true,
      )[0].issues,
    ).not.toHaveLength(0);
    expect(() =>
      makeImportedScript(
        '場面',
        300,
        [{ character: '役A', text: '' }],
        assignments,
        { project: '', scene: '' },
        new Map(),
        true,
      ),
    ).toThrow();
  });
});
