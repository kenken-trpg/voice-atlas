import { describe, expect, it } from 'vitest';
import {
  castingEvaluationKey,
  parseCastingEvaluationFile,
  mergeCastingEvaluations,
  makeCastingDataset,
  filterCastingEvaluations,
  defaultCastingFilters,
  castingEvaluationsCsv,
  resumeCastingEvaluation,
} from '../shared/casting-dataset';
import { castingKey, castingSessionSchema } from '../shared/casting';
import { makeCastingEvaluation, makeCastingSession } from './fixtures/casting';

describe('cross-product evaluation archive and reuse', () => {
  it('extracts session histories and round trips a standalone archive without filling scores', () => {
    const item = makeCastingEvaluation();
    const imported = parseCastingEvaluationFile(makeCastingSession([item]));
    expect(imported).toEqual([item]);
    expect(
      parseCastingEvaluationFile(JSON.parse(JSON.stringify(makeCastingDataset(imported)))),
    ).toEqual(imported);
    expect(parseCastingEvaluationFile(makeCastingSession([]))).toEqual([]);
    expect(imported[0]).not.toHaveProperty('score');
  });
  it('validates formats, versions, limits and native settings before accepting history', () => {
    const item = makeCastingEvaluation(),
      session = makeCastingSession([item]);
    expect(() => parseCastingEvaluationFile({ ...session, version: 2 })).toThrow();
    expect(() =>
      parseCastingEvaluationFile({ ...session, evaluations: Array(101).fill(item) }),
    ).toThrow();
    const invalid = structuredClone(item);
    invalid.candidates[0].recipe.intonationScale = 9;
    expect(() => parseCastingEvaluationFile(makeCastingSession([invalid]))).toThrow();
    expect(() =>
      parseCastingEvaluationFile({ ...makeCastingDataset([item]), version: 2 }),
    ).toThrow();
    expect(() =>
      parseCastingEvaluationFile({ format: 'voice-atlas-evaluations', version: 2, records: [] }),
    ).toThrow();
  });
  it('deduplicates schema/property order, UUID case and equivalent timestamp precision', () => {
    const item = makeCastingEvaluation(),
      other = structuredClone(item);
    other.recordedAt = '2026-10-21T12:00:00Z';
    other.generations[0]!.checkedAt = '2026-10-21T12:00:00Z';
    if (other.candidates[0].voice.engine === 'AivisSpeech')
      other.candidates[0].voice.speakerUuid = other.candidates[0].voice.speakerUuid.toUpperCase();
    const reordered = Object.fromEntries(Object.entries(other).reverse()) as typeof item;
    expect(castingEvaluationKey(item)).toBe(castingEvaluationKey(reordered));
    const result = mergeCastingEvaluations([item], [other, reordered]);
    expect(result.duplicates).toBe(2);
    expect(result.records).toEqual([item]);
    expect(other.recordedAt).toBe('2026-10-21T12:00:00Z');
  });
  it('keeps conflicting reasons, recipes, generation metadata and character context distinct', () => {
    const item = makeCastingEvaluation();
    const changedRecipe = structuredClone(item);
    changedRecipe.candidates[0].recipe.intonationScale = 0.8;
    const changedMetadata = structuredClone(item);
    changedMetadata.generations[0]!.engineVersion = 'another-version';
    const records = [
      item,
      { ...item, reason: '別の判断' },
      changedRecipe,
      changedMetadata,
      { ...item, characterInput: null },
      { ...item, generations: [null, null] as [null, null] },
    ];
    expect(mergeCastingEvaluations([], records).records).toHaveLength(6);
  });
  it('preserves unknown historical VOICEVOX identities but refuses to restore them into working state', () => {
    const item = makeCastingEvaluation();
    item.candidates[1].voice = {
      engine: 'VOICEVOX',
      voiceId: 'removed',
      name: '過去の話者',
      style: '通常',
    };
    const parsed = parseCastingEvaluationFile(makeCastingSession([item]));
    expect(parsed[0].candidates[1].voice.name).toBe('過去の話者');
    expect(() => resumeCastingEvaluation({}, parsed[0])).toThrow('現在のカタログと照合できない');
    expect(makeCastingDataset(parsed).records[0]).toEqual(item);
  });
  it('filters participating/adopted engines, outcomes, pair type, identity and text independently', () => {
    const item = makeCastingEvaluation();
    const same = structuredClone(item);
    same.candidates[1] = structuredClone(item.candidates[0]);
    same.candidates[1].voice.style = 'ささやき';
    same.generations[1] = null;
    const records = [
      item,
      { ...item, outcome: 'b' as const },
      { ...item, outcome: 'tie' as const },
      same,
    ];
    expect(
      filterCastingEvaluations(records, { ...defaultCastingFilters, adoptedEngine: 'AivisSpeech' }),
    ).toHaveLength(2);
    expect(
      filterCastingEvaluations(records, { ...defaultCastingFilters, adoptedEngine: 'VOICEVOX' }),
    ).toHaveLength(1);
    expect(
      filterCastingEvaluations(records, { ...defaultCastingFilters, pair: 'cross' }),
    ).toHaveLength(3);
    expect(
      filterCastingEvaluations(records, {
        ...defaultCastingFilters,
        engine: 'VOICEVOX',
        outcome: 'tie',
      }),
    ).toHaveLength(1);
    expect(
      filterCastingEvaluations(records, {
        ...defaultCastingFilters,
        pair: 'same',
        voice: castingKey(item.candidates[1].voice),
      }),
    ).toHaveLength(0);
    expect(
      filterCastingEvaluations(records, { ...defaultCastingFilters, query: '静かな案内役' }),
    ).toHaveLength(4);
    expect(
      filterCastingEvaluations(records, { ...defaultCastingFilters, query: 'VV-TEST' }),
    ).toHaveLength(3);
  });
  it('sorts newest first, counts duplicates and enforces the unique record limit atomically', () => {
    const item = makeCastingEvaluation();
    const records = Array.from({ length: 1000 }, (_, i) => ({ ...item, reason: `評価${i}` }));
    expect(mergeCastingEvaluations(records, [records[0]]).records).toHaveLength(1000);
    expect(() => mergeCastingEvaluations(records, [{ ...item, reason: '上限外' }])).toThrow(
      '1000件',
    );
    expect(records).toHaveLength(1000);
    expect(
      mergeCastingEvaluations([item], [{ ...item, recordedAt: '2026-10-22T12:00:00.000Z' }])
        .records[0].recordedAt,
    ).toBe('2026-10-22T12:00:00.000Z');
  });
  it('exports both native recipes and provenance as quoted formula-safe CSV', () => {
    const item = makeCastingEvaluation({ reason: '=HYPERLINK("test")\n次の行', text: '@セリフ' });
    item.characterInput!.text = '\t+設定';
    const csv = castingEvaluationsCsv([item]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    const cells = [...csv.matchAll(/"((?:[^"]|"")*)"(?=,|\r\n|$)/g)].map((match) =>
      match[1].replaceAll('""', '"'),
    );
    const width = cells.length / 2,
      headers = cells.slice(0, width),
      row = cells.slice(width);
    const data = Object.fromEntries(headers.map((name, i) => [name, row[i]]));
    expect(data).toMatchObject({
      reason: '\'=HYPERLINK("test")\n次の行',
      sample_text: "'@セリフ",
      character_text: "'\t+設定",
      adopted_engine: 'AivisSpeech',
      a_tempoDynamicsScale: '0.72',
      b_tempoDynamicsScale: '',
      a_observed_style_id: '-12',
      a_engine_version: 'aivis-test',
      b_engine_version: 'vv-test',
    });
  });
  it('resumes the adopted pair and context without mutating history or unrelated candidates', () => {
    const item = makeCastingEvaluation({ outcome: 'b' });
    const unrelated = structuredClone(item.candidates[0]);
    unrelated.voice.style = '別スタイル';
    const old = structuredClone(item.candidates[0]);
    old.recipe.intonationScale = 0.1;
    const existing = { [castingKey(old.voice)]: old, [castingKey(unrelated.voice)]: unrelated };
    const resumed = resumeCastingEvaluation(existing, item);
    expect(resumed.selected).toBe(castingKey(item.candidates[1].voice));
    expect(resumed.context).toEqual({ profile: item.profile, characterInput: item.characterInput });
    expect(resumed.candidates[castingKey(unrelated.voice)]).toEqual(unrelated);
    resumed.candidates[castingKey(item.candidates[0].voice)].recipe.intonationScale = 0.9;
    expect(item.candidates[0].recipe.intonationScale).toBe(1.2);
    expect(existing[castingKey(old.voice)].recipe.intonationScale).toBe(0.1);
  });
  it('refuses reuse without an adopted voice or beyond candidate capacity', () => {
    const item = makeCastingEvaluation();
    expect(() => resumeCastingEvaluation({}, { ...item, outcome: 'tie' })).toThrow(
      '採用した声のない',
    );
    const existing = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => {
        const candidate = structuredClone(item.candidates[0]);
        candidate.voice.style = `別${i}`;
        return [castingKey(candidate.voice), candidate];
      }),
    );
    expect(() => resumeCastingEvaluation(existing, item)).toThrow('上限200件');
    expect(Object.keys(existing)).toHaveLength(200);
  });
  it('persists resumed context while accepting sessions created before context was added', () => {
    const item = makeCastingEvaluation();
    expect(
      castingSessionSchema.parse(makeCastingSession([item])).comparisonContext,
    ).toBeUndefined();
    const saved = castingSessionSchema.parse({
      ...makeCastingSession([item]),
      comparisonContext: { profile: item.profile, characterInput: item.characterInput },
    });
    expect(JSON.parse(JSON.stringify(saved)).comparisonContext).toEqual({
      profile: item.profile,
      characterInput: item.characterInput,
    });
  });
});
