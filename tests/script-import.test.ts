import { describe, expect, it } from 'vitest';
import {
  parseScriptImport,
  resolveScriptImport,
  makeImportedScript,
  maxScriptImportBytes,
} from '../shared/script-import';
import { scriptFixture } from './fixtures/script';
import { parseScript, serializeScript } from '../shared/script';
const scope = { project: '', scene: '' };
describe('script text and CSV import', () => {
  it('parses Japanese and ASCII colons, BOM and blank lines while preserving dialogue colons', () => {
    expect(
      parseScriptImport('\uFEFF案内人：ようこそ。\r\n\r\n 騎士 : 時刻は12:00：出発だ。\r', 'text'),
    ).toEqual([
      { character: '案内人', text: 'ようこそ。' },
      { character: '騎士', text: '時刻は12:00：出発だ。' },
    ]);
    expect(() => parseScriptImport('案内人 セリフ', 'text')).toThrow('第1行');
    expect(() => parseScriptImport('\n \n', 'text')).toThrow('1行以上');
  });
  it('reads reordered CSV headers, escaped quotes, embedded commas/newlines and trailing newlines', () => {
    expect(
      parseScriptImport(
        '\uFEFFセリフ,キャラクター名\r\n"ようこそ、\r\n\"\"旅人\"\"。",案内人\r\n"先頭と末尾の空白 ",騎士\r\n',
        'csv',
      ),
    ).toEqual([
      { character: '案内人', text: 'ようこそ、\n"旅人"。' },
      { character: '騎士', text: '先頭と末尾の空白 ' },
    ]);
    expect(parseScriptImport('キャラクター名,セリフ\n\n案内人,""\n', 'csv')).toEqual([
      { character: '案内人', text: '' },
    ]);
  });
  it('rejects malformed CSV and never silently discards extra fields or records', () => {
    for (const text of [
      '名前,セリフ\n案内人,声',
      'キャラクター名,キャラクター名\n案内人,声',
      'キャラクター名,セリフ\n案内人,声,余分',
      'キャラクター名,セリフ\n案内人,"閉じない',
      'キャラクター名,セリフ\n案内人,無"効',
      'キャラクター名,セリフ\n案内人,"閉じた"文字',
    ])
      expect(() => parseScriptImport(text, 'csv')).toThrow();
    const text = Array(20).fill('案内人：声').join('\n');
    expect(parseScriptImport(text, 'text')).toHaveLength(20);
    expect(() => parseScriptImport(text + '\n案内人：超過', 'text')).toThrow('20行');
    expect(() =>
      parseScriptImport('キャラクター名,セリフ\n' + Array(21).fill('案内人,声').join('\n'), 'csv'),
    ).toThrow('20行');
    expect(() =>
      parseScriptImport('あ'.repeat(Math.ceil(maxScriptImportBytes / 3) + 1), 'text'),
    ).toThrow('64KiB');
    expect(() => parseScriptImport('案内人：\0', 'text')).toThrow('文字');
  });
  it('auto-matches only unique exact names inside the selected scope, requiring choices for ambiguity', () => {
    const { assignments } = scriptFixture();
    const alternate = { ...assignments[0], id: crypto.randomUUID(), scene: '再会' };
    const differentProject = { ...assignments[0], id: crypto.randomUUID(), project: '別作品' };
    const all = [...assignments, alternate, differentProject];
    const rows = parseScriptImport(
      '案内人：ようこそ。\n騎士：頼む。\nナレーター：昔の話。',
      'text',
    );
    const unresolved = resolveScriptImport(rows, all, scope, new Map());
    expect(unresolved.map((row) => row.selected?.id)).toEqual([
      undefined,
      assignments[1].id,
      undefined,
    ]);
    const filtered = resolveScriptImport(rows, all, { project: '物語', scene: '導入' }, new Map());
    expect(filtered[0].selected?.id).toBe(assignments[0].id);
    expect(filtered[2].selected).toBeNull();
    expect(() => makeImportedScript('台本', 300, rows, all, scope, new Map())).toThrow(
      '未割り当て',
    );
    expect(
      resolveScriptImport([{ character: '案内 人', text: '声' }], all, scope, new Map())[0]
        .selected,
    ).toBeNull();
  });
  it('supports explicit aliases and safe name keys, but rejects mappings outside the selected scope', () => {
    const { assignments } = scriptFixture();
    const rows = [
      { character: '__proto__', text: '声' },
      { character: '案内人', text: '声' },
    ];
    const mapping = new Map([
      ['__proto__', assignments[0].id],
      ['案内人', ''],
    ]);
    const resolved = resolveScriptImport(rows, assignments, scope, mapping);
    expect(resolved[0].selected?.id).toBe(assignments[0].id);
    expect(resolved[1].selected).toBeNull();
    expect(
      resolveScriptImport(rows, assignments, { project: '別作品', scene: '' }, mapping)[0].selected,
    ).toBeNull();
  });
  it('copies assignments and native recipes into new row IDs without changing the catalog or previous script', () => {
    const { assignments, script: original } = scriptFixture();
    const rows = parseScriptImport('案内人：初めの言葉\n騎士：二番目\n案内人：最後', 'text');
    const script = makeImportedScript(' 新しい台本 ', 750, rows, assignments, scope, new Map());
    expect(script.title).toBe('新しい台本');
    expect(parseScript(serializeScript(script)).lines.map((line) => line.character)).toEqual([
      '案内人',
      '騎士',
      '案内人',
    ]);
    expect(script.gapMs).toBe(750);
    expect(new Set(script.lines.map((line) => line.id)).size).toBe(3);
    expect(
      script.lines[1].assignment!.comparison.entries[1].evaluation.candidates[1].recipe.speedScale,
    ).toBe(0.85);
    assignments[0].character = '後から変更';
    rows[0].text = '入力変更';
    expect(script.lines[0].assignment!.character).toBe('案内人');
    expect(script.lines[0].text).toBe('初めの言葉');
    script.lines[0].assignment!.character = '片側変更';
    expect(script.lines[2].assignment!.character).toBe('案内人');
    expect(original.lines[0].text).toBe('ようこそ。');
  });
  it('keeps oversized and empty fields editable for preview but refuses invalid application', () => {
    const { assignments } = scriptFixture();
    const rows = parseScriptImport(
      `案内人：${'あ'.repeat(301)}\n：\n${'長'.repeat(101)}：声`,
      'text',
    );
    const result = resolveScriptImport(rows, assignments, scope, new Map());
    expect(result[0].issues).toContain('セリフは300文字以下にしてください。');
    expect(result[1].issues).toContain('キャラクター名を入力してください。');
    expect(result[2].issues).toContain('キャラクター名は100文字以下にしてください。');
    expect(() => makeImportedScript('台本', 300, rows, assignments, scope, new Map())).toThrow();
    expect(() =>
      makeImportedScript(
        '',
        300,
        [{ character: '案内人', text: '声' }],
        assignments,
        scope,
        new Map(),
      ),
    ).toThrow();
  });
});
