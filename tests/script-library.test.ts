import { describe, expect, it } from 'vitest';
import {
  duplicateScriptEntry,
  makeScriptLibraryEntry,
  maxScriptLibraryBytes,
  mergeScriptLibrary,
  parseScriptLibrary,
  serializeScriptLibrary,
} from '../shared/script-library';
import { scriptFixture } from './fixtures/script';

describe('script library', () => {
  it('roundtrips named snapshots, native voice settings, dialogue and gaps independently of the editor', () => {
    const { script } = scriptFixture();
    script.gapMs = 725;
    const entry = makeScriptLibraryEntry(script, ' 作品 ', ' 導入 ');
    script.lines[0].text = '後から編集';
    script.lines[0].assignment!.character = '後から変更';
    const loaded = parseScriptLibrary(serializeScriptLibrary([entry]))[0];
    expect([loaded.project, loaded.scene]).toEqual(['作品', '導入']);
    expect(loaded.script.lines[0].text).toBe('ようこそ。');
    expect(loaded.script.lines[0].assignment!.character).toBe('案内人');
    expect(loaded.script.gapMs).toBe(725);
    expect(
      loaded.script.lines[1].assignment!.comparison.entries[1].evaluation.candidates[1].recipe
        .speedScale,
    ).toBe(0.85);
  });
  it('updates only the specified registration and preserves identity and creation time', () => {
    const { script } = scriptFixture();
    const entry = makeScriptLibraryEntry(script, '作品', '導入');
    const updated = makeScriptLibraryEntry({ ...script, title: '改稿版' }, '作品', '再会', entry);
    expect(updated.id).toBe(entry.id);
    expect(updated.createdAt).toBe(entry.createdAt);
    expect(updated.scene).toBe('再会');
    expect(entry.scene).toBe('導入');
    expect(entry.script.title).toBe('導入の会話');
  });
  it('duplicates into a new registration and fresh row IDs without changing source snapshots', () => {
    const entry = makeScriptLibraryEntry(scriptFixture().script, '作品', '導入');
    const copy = duplicateScriptEntry(entry);
    expect(copy.id).not.toBe(entry.id);
    expect(copy.script.title).toBe('導入の会話（コピー）');
    expect(copy.script.lines[0].id).not.toBe(entry.script.lines[0].id);
    copy.script.lines[0].text = '複製だけを編集';
    expect(entry.script.lines[0].text).toBe('ようこそ。');
  });
  it('merges identical IDs once, allows duplicate names, rejects a conflicting batch atomically', () => {
    const entry = makeScriptLibraryEntry(scriptFixture().script, '作品', '導入');
    expect(mergeScriptLibrary([entry], [entry])).toEqual([entry]);
    const other = { ...entry, id: crypto.randomUUID() };
    expect(mergeScriptLibrary([entry], [other])).toHaveLength(2);
    expect(() => mergeScriptLibrary([entry], [other, { ...entry, scene: '競合' }])).toThrow(
      '同じ登録ID',
    );
    expect(entry.scene).toBe('導入');
  });
  it('enforces registration IDs, required names, 30 entries, per-script validity and UTF-8 bounds', () => {
    const entry = makeScriptLibraryEntry(scriptFixture().script, '作品', '導入');
    const entries = Array.from({ length: 30 }, () => ({ ...entry, id: crypto.randomUUID() }));
    expect(parseScriptLibrary(serializeScriptLibrary(entries))).toHaveLength(30);
    expect(() =>
      serializeScriptLibrary([...entries, { ...entry, id: crypto.randomUUID() }]),
    ).toThrow();
    expect(() => serializeScriptLibrary([entry, entry])).toThrow();
    expect(() => makeScriptLibraryEntry(entry.script, ' ', '場面')).toThrow();
    expect(() => makeScriptLibraryEntry({ ...entry.script, title: ' ' }, '作品', '場面')).toThrow();
    expect(() =>
      parseScriptLibrary(
        JSON.stringify({ format: 'voice-atlas-script-library', version: 2, entries: [] }),
      ),
    ).toThrow();
    const invalid = structuredClone(entry);
    invalid.script.lines[0].assignment!.comparison.selectedId = crypto.randomUUID();
    expect(() => serializeScriptLibrary([invalid])).toThrow();
    expect(() =>
      parseScriptLibrary('あ'.repeat(Math.ceil(maxScriptLibraryBytes / 3) + 1)),
    ).toThrow();
  });
});
