import { type CastingAssignment } from './casting-board';
import { emptyScript, makeScriptLine, scriptSchema, serializeScript } from './script';
export const maxScriptImportBytes = 64 * 1024;
export type ScriptImportFormat = 'text' | 'csv';
export type ImportedDialogue = { character: string; text: string };
export type ImportScope = { project: string; scene: string };
function checkCount(rows: unknown[]) {
  if (rows.length > 20)
    throw new Error('一度に取り込める台本は20行までです。入力を分けてください。');
}
function csvRecords(source: string) {
  const rows: string[][] = [];
  let cells: string[] = [],
    value = '',
    state: 'start' | 'plain' | 'quoted' | 'closed' = 'start',
    touched = false;
  function field() {
    cells.push(value);
    value = '';
    state = 'start';
  }
  function row() {
    field();
    if (touched) rows.push(cells);
    if (rows.length > 21) throw new Error('CSVはヘッダーと20行までです。入力を分けてください。');
    cells = [];
    touched = false;
  }
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (state === 'quoted') {
      if (c === '"') {
        if (source[i + 1] === '"') {
          value += '"';
          i++;
        } else state = 'closed';
      } else value += c;
      continue;
    }
    if (c === ',') {
      touched = true;
      field();
    } else if (c === '\n') row();
    else if (c === '"' && state === 'start') {
      touched = true;
      state = 'quoted';
    } else if (c === '"' || state === 'closed')
      throw new Error(
        'CSVの引用符が不正です。セル全体を二重引用符で囲み、セル内の引用符は二重にしてください。',
      );
    else {
      touched = true;
      value += c;
      state = 'plain';
    }
  }
  if (state === 'quoted') throw new Error('CSVの引用符が閉じられていません。');
  if (touched || cells.length || value) row();
  return rows;
}
export function parseScriptImport(source: string, format: ScriptImportFormat): ImportedDialogue[] {
  if (new TextEncoder().encode(source).length > maxScriptImportBytes)
    throw new Error('取り込み入力は64KiB以下にしてください。');
  if (source.includes('\0'))
    throw new Error('入力に使用できない文字があります。UTF-8のテキストを使用してください。');
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  let rows: ImportedDialogue[];
  if (format === 'csv') {
    const records = csvRecords(text);
    const header = records.shift()?.map((cell) => cell.trim()) ?? [];
    if (header.length !== 2 || !header.includes('キャラクター名') || !header.includes('セリフ'))
      throw new Error(
        'CSVの先頭行は「キャラクター名,セリフ」の2列にしてください。列順は入れ替えできます。',
      );
    const character = header.indexOf('キャラクター名'),
      dialogue = header.indexOf('セリフ');
    rows = records.map((cells, index) => {
      if (cells.length !== 2)
        throw new Error(
          `CSVのデータ第${index + 1}行が2列ではありません。カンマや改行を含むセルは二重引用符で囲んでください。`,
        );
      return { character: cells[character].trim(), text: cells[dialogue] };
    });
  } else if (format === 'text') {
    rows = [];
    text.split('\n').forEach((line, index) => {
      if (!line.trim()) return;
      const separator = line.search(/[:：]/);
      if (separator < 0)
        throw new Error(
          `テキストの第${index + 1}行に「：」または「:」がありません。「名前：セリフ」の形式にしてください。`,
        );
      rows.push({
        character: line.slice(0, separator).trim(),
        text: line.slice(separator + 1).trim(),
      });
      checkCount(rows);
    });
  } else throw new Error('対応していない取り込み形式です。');
  checkCount(rows);
  if (!rows.length) throw new Error('取り込むセリフを1行以上入力してください。');
  return rows;
}
export function scopedImportAssignments(assignments: CastingAssignment[], scope: ImportScope) {
  return assignments.filter(
    (item) =>
      (!scope.project || item.project === scope.project) &&
      (!scope.scene || item.scene === scope.scene),
  );
}
export function resolveScriptImport(
  rows: ImportedDialogue[],
  assignments: CastingAssignment[],
  scope: ImportScope,
  mapping: ReadonlyMap<string, string>,
) {
  const options = scopedImportAssignments(assignments, scope);
  return rows.map((row) => {
    const name = row.character.trim();
    const matches = options.filter((item) => item.character === name);
    const selected = mapping.has(name)
      ? (options.find((item) => item.id === mapping.get(name)) ?? null)
      : matches.length === 1
        ? matches[0]
        : null;
    const issues: string[] = [];
    if (!name) issues.push('キャラクター名を入力してください。');
    if (name.length > 100) issues.push('キャラクター名は100文字以下にしてください。');
    if (!row.text.trim()) issues.push('セリフを入力してください。');
    if (row.text.length > 300) issues.push('セリフは300文字以下にしてください。');
    if (row.character.includes('\0') || row.text.includes('\0'))
      issues.push('使用できない文字があります。');
    if (!selected)
      issues.push(
        matches.length > 1
          ? '同名の確定設定が複数あります。声を選択してください。'
          : '声を選択してください。',
      );
    return { row, matches, selected, issues };
  });
}
export function makeImportedScript(
  title: string,
  gapMs: number,
  rows: ImportedDialogue[],
  assignments: CastingAssignment[],
  scope: ImportScope,
  mapping: ReadonlyMap<string, string>,
) {
  checkCount(rows);
  if (!title.trim() || title.length > 100 || !rows.length)
    throw new Error('台本名と1〜20行のセリフを入力してください。');
  const resolved = resolveScriptImport(rows, assignments, scope, mapping);
  if (resolved.some((row) => row.issues.length))
    throw new Error('取り込み内容のエラーと声の未割り当てを解消してください。');
  const script = scriptSchema.parse({
    ...emptyScript(),
    title: title.trim(),
    gapMs,
    lines: resolved.map(({ row, selected }) => ({
      ...makeScriptLine(selected),
      character: row.character.trim(),
      text: row.text,
    })),
  });
  serializeScript(script);
  return script;
}
