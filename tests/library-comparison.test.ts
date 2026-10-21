import { describe, expect, it } from 'vitest';
import { makeLibraryEntry, makeVoiceVariation, libraryCandidate } from '../shared/voice-library';
import {
  libraryComparisonPairSchema,
  libraryRecipeDifferences,
  makeLibraryComparisonRecord,
  parseLibraryComparison,
  serializeLibraryComparison,
  type LibraryComparisonSession,
} from '../shared/library-comparison';
import { castingCandidateSchema } from '../shared/casting';
import { makeCastingEvaluation } from './fixtures/casting';
import { evaluationWithModelInfo, modelInfo } from './fixtures/aivis-model-info';

function pair() {
  const first = makeLibraryEntry(evaluationWithModelInfo(), '案内人', '通常', '');
  const candidate = structuredClone(libraryCandidate(first));
  candidate.recipe.speedScale = 0.7;
  const second = makeVoiceVariation(
    first,
    {
      candidate,
      text: '説明文',
      generation: null,
      profile: first.evaluation.profile,
      characterInput: null,
      reason: '長文用に遅く',
    },
    '長文',
    '',
  );
  return [first, second] as [typeof first, typeof first];
}
function session(): LibraryComparisonSession {
  const entries = pair();
  const record = makeLibraryComparisonRecord({
    entries,
    text: '同じセリフ',
    scene: '説明',
    reason: '聞き取りやすい',
    selectedId: entries[1].id,
    auditions: [{ generation: null, modelInfo: modelInfo() }, { generation: null }],
  });
  return {
    format: 'voice-atlas-library-comparison',
    version: 1,
    createdAt: record.recordedAt,
    entries,
    text: record.text,
    scene: record.scene,
    reason: record.reason,
    selectedId: record.selectedId,
    records: [record],
  };
}
describe('saved setting comparisons', () => {
  it('uses distinct registration IDs even when voice and style are identical', () => {
    const entries = pair();
    expect(libraryComparisonPairSchema.parse(entries)).toEqual(entries);
    expect(() => libraryComparisonPairSchema.parse([entries[0], entries[0]])).toThrow();
  });
  it('roundtrips settings, choice, scene and independent generation evidence as immutable copies', () => {
    const saved = session();
    const record = saved.records[0];
    saved.entries![0].settingName = '後で編集';
    expect(record.entries[0].settingName).toBe('通常');
    expect(record.auditions[1].generation).toBeNull();
    expect(record.auditions[1].modelInfo).toBeUndefined();
    expect(record.entries[1].variation?.candidate.modelInfo?.modelVersion).toBe('1.2.3');
    const decoded = parseLibraryComparison(serializeLibraryComparison(saved));
    expect(decoded).toEqual(saved);
    saved.records[0].reason = '後から変更';
    expect(decoded.records[0].reason).toBe('聞き取りやすい');
  });
  it('compares native values without equating VOICEVOX intonation and AivisSpeech emotion', () => {
    const entries = pair();
    expect(libraryRecipeDifferences(entries)).toEqual([
      { key: 'speedScale', a: '話速：1.00倍', b: '話速：0.70倍', delta: -0.3 },
    ]);
    expect(libraryRecipeDifferences([entries[0], { ...entries[0], id: entries[1].id }])).toEqual(
      [],
    );
    libraryCandidate(entries[1]).recipe.pitchScale = 0.0005;
    expect(libraryRecipeDifferences(entries).find((row) => row.key === 'pitchScale')).toMatchObject(
      { b: expect.stringContaining('0.0005'), delta: 0.0005 },
    );
    const vv = makeLibraryEntry(makeCastingEvaluation({ outcome: 'b' }), '騎士', '通常', '');
    const cross = libraryRecipeDifferences([entries[0], vv]);
    expect(cross.every((row) => row.delta === null)).toBe(true);
    expect(cross.find((row) => row.key === 'intonationScale')).toMatchObject({
      a: expect.stringContaining('感情表現の強さ'),
      b: expect.stringContaining('抑揚'),
    });
    expect(cross.find((row) => row.key === 'tempoDynamicsScale')?.b).toBe('対応項目なし');
  });
  it('rejects mismatched selection, native values and model/generation identity', () => {
    const saved = session();
    const invalid = structuredClone(saved);
    invalid.selectedId = crypto.randomUUID();
    expect(() => serializeLibraryComparison(invalid)).toThrow();
    const choice = structuredClone(saved);
    choice.records[0].selectedId = crypto.randomUUID();
    expect(() => serializeLibraryComparison(choice)).toThrow();
    const generation = structuredClone(saved);
    generation.records[0].auditions[0].generation = {
      engine: 'VOICEVOX',
      engineVersion: null,
      checkedAt: saved.createdAt,
    };
    expect(() => serializeLibraryComparison(generation)).toThrow();
    const model = structuredClone(saved);
    model.records[0].auditions[0].modelInfo!.speakerUuid = crypto.randomUUID();
    expect(() => serializeLibraryComparison(model)).toThrow();
    const link = structuredClone(saved);
    link.records[0].auditions[0].modelInfo!.links = ['javascript:alert(1)'];
    expect(() => serializeLibraryComparison(link)).toThrow();
    const native = structuredClone(saved);
    libraryCandidate(native.records[0].entries[1]).recipe.speedScale = 10;
    expect(() => serializeLibraryComparison(native)).toThrow();
  });
  it('limits records, bytes and versions and rejects duplicate record IDs', () => {
    const saved = session();
    const record = saved.records[0];
    saved.records = Array.from({ length: 100 }, () => ({ ...record, id: crypto.randomUUID() }));
    expect(parseLibraryComparison(serializeLibraryComparison(saved)).records).toHaveLength(100);
    saved.records.push({ ...record, id: crypto.randomUUID() });
    expect(() => serializeLibraryComparison(saved)).toThrow();
    saved.records = [record, record];
    expect(() => serializeLibraryComparison(saved)).toThrow();
    expect(() => parseLibraryComparison(' '.repeat(8 * 1024 * 1024 + 1))).toThrow('8MiB');
    expect(() => parseLibraryComparison(JSON.stringify({ ...session(), version: 99 }))).toThrow();
  });
  it('preserves removed voices as historical snapshots without making them operational', () => {
    const saved = session();
    const vv = makeLibraryEntry(makeCastingEvaluation({ outcome: 'b' }), '騎士', '通常', '');
    const voice = libraryCandidate(vv).voice;
    if (voice.engine === 'VOICEVOX') voice.voiceId = 'removed';
    saved.entries = [saved.entries![0], vv];
    saved.selectedId = vv.id;
    expect(parseLibraryComparison(serializeLibraryComparison(saved)).entries![1]).toEqual(vv);
    expect(castingCandidateSchema.safeParse(libraryCandidate(vv)).success).toBe(false);
  });
});
