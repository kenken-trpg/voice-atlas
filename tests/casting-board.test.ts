import { describe, expect, it } from 'vitest';
import {
  assignmentEntry,
  makeCastingAssignment,
  parseCastingBoard,
  serializeCastingBoard,
  maxCastingBoardBytes,
} from '../shared/casting-board';
import { makeLibraryComparisonRecord } from '../shared/library-comparison';
import {
  libraryCandidate,
  libraryGeneration,
  libraryText,
  makeLibraryEntry,
  makeVoiceVariation,
  loadLibraryCandidate,
} from '../shared/voice-library';
import { evaluationWithModelInfo } from './fixtures/aivis-model-info';

function comparison() {
  const first = makeLibraryEntry(evaluationWithModelInfo(), '案内人', '通常', '');
  const second = makeLibraryEntry(evaluationWithModelInfo(), '案内人', '別案', '');
  return makeLibraryComparisonRecord({
    entries: [first, second],
    text: '今回の比較セリフ',
    scene: '導入',
    reason: '落ち着いた説明',
    selectedId: first.id,
    auditions: [{ generation: null }, { generation: null }],
  });
}
describe('casting board', () => {
  it('roundtrips a complete immutable decision snapshot and loads comparison text without stale provenance', () => {
    const record = comparison();
    const item = makeCastingAssignment(record, ' 作品 ', ' 案内役 ', ' 導入 ');
    record.entries[0].settingName = '後から変更';
    const restored = parseCastingBoard(serializeCastingBoard([item]))[0];
    const entry = assignmentEntry(restored);
    expect([restored.project, restored.character, restored.scene]).toEqual([
      '作品',
      '案内役',
      '導入',
    ]);
    expect(entry.settingName).toBe('通常');
    expect(libraryCandidate(entry).modelInfo).toBeUndefined();
    expect(libraryGeneration(entry)).toBeNull();
    expect(libraryText(entry)).toBe('今回の比較セリフ');
    expect(loadLibraryCandidate({}, null, entry, 0).text).toBe('今回の比較セリフ');
    entry.settingName = '読み込み後の変更';
    expect(restored.comparison.entries[0].settingName).toBe('通常');
  });
  it('keeps native variation parameters and current audition evidence', () => {
    const record = comparison();
    const parent = record.entries[0];
    const parentRecipe = libraryCandidate(parent).recipe;
    if (parentRecipe.engine === 'ElevenLabs') throw new Error('Expected local recipe');
    const variant = makeVoiceVariation(
      parent,
      {
        candidate: {
          ...libraryCandidate(parent),
          recipe: { ...parentRecipe, speedScale: 0.7 },
        },
        text: '旧セリフ',
        generation: null,
        profile: parent.evaluation.profile,
        characterInput: null,
        reason: '長文用',
      },
      '長文',
      '',
    );
    record.entries[0] = variant;
    record.selectedId = variant.id;
    const generation = {
      engine: 'AivisSpeech' as const,
      engineVersion: 'new',
      checkedAt: record.recordedAt,
    };
    record.auditions[0] = { generation, modelInfo: libraryCandidate(parent).modelInfo };
    const entry = assignmentEntry(makeCastingAssignment(record, '作品', '役', '説明'));
    expect(libraryCandidate(entry).recipe.speedScale).toBe(0.7);
    expect(libraryCandidate(entry).modelInfo).toEqual(record.auditions[0].modelInfo);
    expect(libraryGeneration(entry)).toEqual(generation);
    expect(libraryText(entry)).toBe(record.text);
  });
  it('rejects duplicate identifiers or slots, invalid selections, unsupported versions and invalid names', () => {
    const item = makeCastingAssignment(comparison(), '作品', '役', '場面');
    expect(() => serializeCastingBoard([item, { ...item, id: crypto.randomUUID() }])).toThrow();
    expect(() => serializeCastingBoard([item, { ...item, scene: '別場面' }])).toThrow();
    expect(() => makeCastingAssignment(comparison(), ' ', '役', '場面')).toThrow();
    const raw = JSON.parse(serializeCastingBoard([item]));
    expect(() => parseCastingBoard(JSON.stringify({ ...raw, version: 2 }))).toThrow();
    raw.assignments[0].comparison.selectedId = crypto.randomUUID();
    expect(() => parseCastingBoard(JSON.stringify(raw))).toThrow();
  });
  it('enforces 100 entries and UTF-8 size limits', () => {
    const item = makeCastingAssignment(comparison(), '作品', '役', '場面');
    const items = Array.from({ length: 100 }, (_, i) => ({
      ...item,
      id: crypto.randomUUID(),
      scene: String(i),
    }));
    expect(parseCastingBoard(serializeCastingBoard(items))).toHaveLength(100);
    expect(() =>
      serializeCastingBoard([...items, { ...item, id: crypto.randomUUID(), scene: '101' }]),
    ).toThrow();
    expect(() => parseCastingBoard('あ'.repeat(Math.ceil(maxCastingBoardBytes / 3) + 1))).toThrow();
  });
});
