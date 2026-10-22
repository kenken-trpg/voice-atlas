import { describe, expect, it } from 'vitest';
import { scriptFixture } from './fixtures/script';
import {
  planPronunciations,
  pronunciationsSchema,
  replacePronunciations,
} from '../shared/pronunciations';
import { parseScript, serializeScript, scriptAudioKey, scriptSpokenText } from '../shared/script';
import { makeRecastSnapshot, undoScriptRecast } from '../shared/script-recast-history';
import { planScriptRecast } from '../shared/script-recast';
import { duplicateScriptEntry, makeScriptLibraryEntry } from '../shared/script-library';
const rule = (term: string, reading: string) => ({ id: crypto.randomUUID(), term, reading });
describe('script spoken text and project pronunciations', () => {
  it('keeps display text and native voice snapshots while the effective spoken text controls audio identity', () => {
    const { script } = scriptFixture(),
      line = {
        ...script.lines[0],
        text: '星詠みの塔',
        spokenText: 'ほしよみのとう',
        readingSource: 'manual' as const,
      };
    expect(scriptSpokenText(line)).toBe('ほしよみのとう');
    expect(scriptAudioKey({ ...line, text: '星詠みの塔へ' })).toBe(scriptAudioKey(line));
    expect(scriptAudioKey({ ...line, spokenText: 'とう' })).not.toBe(scriptAudioKey(line));
    const saved = { ...script, lines: [line] };
    expect(parseScript(serializeScript(saved))).toEqual(saved);
    const spaced = { ...saved, lines: [{ ...line, spokenText: ' ほしよみのとう ' }] };
    expect(parseScript(serializeScript(spaced))).toEqual(spaced);
    const copy = duplicateScriptEntry(makeScriptLibraryEntry(saved, '作品', '導入'));
    expect(copy.script.lines[0].spokenText).toBe(line.spokenText);
    expect(copy.script.lines[0].id).not.toBe(line.id);
    expect(() => serializeScript({ ...script, lines: [{ ...line, spokenText: '' }] })).toThrow();
    expect(() => serializeScript({ ...script, lines: [{ ...line, spokenText: '  ' }] })).toThrow();
    expect(() =>
      serializeScript({ ...script, lines: [{ ...line, spokenText: 'あ'.repeat(301) }] }),
    ).toThrow();
  });
  it('uses exact longest matches, handles punctuation and Unicode literally, and does not replace its own output', () => {
    const rules = [
      rule('塔', 'タワー'),
      rule('星詠みの塔', 'ほしよみの塔'),
      rule('A+B', 'えーぷらすびー'),
      rule('🦊', 'きつね'),
    ];
    expect(replacePronunciations('星詠みの塔、塔。A+B🦊', rules)).toBe(
      'ほしよみの塔、タワー。えーぷらすびーきつね',
    );
    expect(() => pronunciationsSchema.parse([rule('塔', 'とう'), rule('塔', 'タワー')])).toThrow();
    expect(() =>
      pronunciationsSchema.parse(Array.from({ length: 101 }, (_, i) => rule(String(i), 'よみ'))),
    ).toThrow();
  });
  it('previews only affected lines, preserves manual overrides and removes outdated dictionary readings', () => {
    const { script } = scriptFixture();
    script.lines[0].text = '星詠みの塔へ。';
    script.lines[1] = {
      ...script.lines[1],
      text: '塔へ。',
      spokenText: '手動のよみ',
      readingSource: 'manual',
    };
    const plan = planPronunciations(script, [rule('星詠みの塔', 'ほしよみのとう')]);
    expect(plan.changedIds).toEqual([script.lines[0].id]);
    expect(plan.script.lines[0].spokenText).toBe('ほしよみのとうへ。');
    expect(plan.script.lines[1]).toEqual(script.lines[1]);
    expect(script.lines[0].spokenText).toBeUndefined();
    const removed = planPronunciations(plan.script, []);
    expect(removed.script.lines[0].spokenText).toBeUndefined();
    expect(removed.audioChangedIds).toEqual([script.lines[0].id]);
    expect(() =>
      planPronunciations({ ...script, lines: [{ ...script.lines[0], text: '塔'.repeat(300) }] }, [
        rule('塔', 'とう'),
      ]),
    ).toThrow();
  });
  it('retains the spoken text during voice replacement and undo', () => {
    const { script, assignments } = scriptFixture();
    script.lines[0] = {
      ...script.lines[0],
      spokenText: 'ようこそ、とうへ。',
      readingSource: 'dictionary',
    };
    const plan = planScriptRecast(script, '案内人', 'all', assignments[1]);
    expect(plan.script.lines[0].spokenText).toBe(script.lines[0].spokenText);
    const restored = undoScriptRecast(plan.script, makeRecastSnapshot(script, plan));
    expect(restored).toEqual(script);
  });
});
