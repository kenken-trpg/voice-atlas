import { describe, expect, it } from 'vitest';
import { voices } from '../shared/catalog';
import { makeRecipe } from '../shared/recommend';
import type { Evaluation } from '../shared/saved-recipe';
import { axes } from '../shared/schema';
import {
  analyzeEvaluation,
  evaluationKey,
  evaluationsCsv,
  evaluationVoiceLabel,
  makeEvaluationDataset,
  maxEvaluationRecords,
  mergeEvaluationRecords,
  parseEvaluationFile,
  summarizeEvaluations,
  type EvaluationRecord,
} from '../shared/evaluation-dataset';

const metan = voices.find((voice) => voice.id === 'vv-metan')!;
const ryusei = voices.find((voice) => voice.id === 'vv-ryusei')!;
function evaluation(overrides: Partial<Evaluation> = {}): Evaluation {
  return {
    recordedAt: '2026-10-21T00:00:00.000Z',
    profile: { ...metan.profile },
    sampleText: '同じセリフで比較します。',
    outcome: 'a',
    reason: '役柄に合う。',
    candidates: [metan, ryusei].map((voice) => ({
      voiceId: voice.id,
      parameters: makeRecipe(metan.profile, voice),
    })) as Evaluation['candidates'],
    ...overrides,
  };
}
const record = (overrides: Partial<Evaluation> = {}): EvaluationRecord => ({
  evaluation: evaluation(overrides),
  sourceCatalogDates: ['2026-10-20'],
});

describe('local evaluation datasets', () => {
  it('extracts only history from v2 recipes without restoring voice settings or requiring current catalog IDs', () => {
    const archived = evaluation();
    archived.candidates[0].voiceId = 'removed-voice';
    const records = parseEvaluationFile({
      format: 'voice-atlas-recipe',
      version: 2,
      catalogReviewedAt: '2026-10-20',
      evaluations: [archived],
      image: 'private',
      voice: { productUrl: 'javascript:alert(1)' },
    });
    expect(records).toEqual([{ evaluation: archived, sourceCatalogDates: ['2026-10-20'] }]);
    expect(evaluationVoiceLabel('removed-voice')).toBe('未収録：removed-voice');
    expect(analyzeEvaluation(archived)).toMatchObject({
      scores: [null, expect.any(Number)],
      relation: 'unavailable',
    });
    expect(parseEvaluationFile({ format: 'voice-atlas-recipe', version: 1 })).toEqual([]);
  });
  it('round-trips dataset snapshots without calculated scores or unrelated input data', () => {
    const original = [record()];
    const dataset = makeEvaluationDataset(original);
    expect(parseEvaluationFile(JSON.parse(JSON.stringify(dataset)))).toEqual(original);
    expect(dataset).not.toHaveProperty('scores');
    expect(dataset).not.toHaveProperty('image');
  });
  it('deduplicates repeated histories and combines source dates without altering the experiment', () => {
    const original = record();
    const copy = record({ recordedAt: '2026-10-21T00:00:00Z' });
    copy.sourceCatalogDates = ['2026-10-21'];
    const merged = mergeEvaluationRecords([original], [copy, copy]);
    expect(merged.duplicates).toBe(2);
    expect(merged.records).toHaveLength(1);
    expect(merged.records[0].sourceCatalogDates).toEqual(['2026-10-20', '2026-10-21']);
    expect(original.sourceCatalogDates).toEqual(['2026-10-20']);
    expect(merged.records[0].evaluation).toEqual(original.evaluation);
    expect(evaluationKey(original.evaluation)).toBe(evaluationKey(copy.evaluation));
  });
  it('preserves separate evaluations when conditions, reason, time or A/B placement differ', () => {
    const first = record();
    const changedRecipe = evaluation();
    changedRecipe.candidates[0].parameters.speedScale = 0.7;
    const incoming = [
      record({ reason: '別の理由' }),
      record({ sampleText: '別のセリフ' }),
      record({ profile: { ...metan.profile, energy: 0 } }),
      record({ recordedAt: '2026-10-21T01:00:00Z' }),
      record({ characterInput: { mode: 'text', text: '穏やかな司書。', direction: 'ゆっくり。' } }),
      record({
        candidates: [...evaluation().candidates].reverse() as Evaluation['candidates'],
        outcome: 'b',
      }),
      { evaluation: changedRecipe, sourceCatalogDates: [] },
    ];
    const merged = mergeEvaluationRecords([first], incoming);
    expect(merged.records).toHaveLength(8);
    expect(merged.records[0].evaluation.recordedAt).toBe('2026-10-21T01:00:00Z');
    expect(first.evaluation.candidates[0].parameters.speedScale).not.toBe(0.7);
  });
  it('counts forced choices separately from ties, undecided and unscorable choices', () => {
    const midpoint = { ...metan.profile };
    axes.forEach((axis) => {
      midpoint[axis] = (metan.profile[axis] + ryusei.profile[axis]) / 2;
    });
    const unknown = evaluation();
    unknown.candidates[0].voiceId = 'removed';
    const records = [
      record(),
      record({ outcome: 'b' }),
      record({ profile: midpoint }),
      record({ outcome: 'tie' }),
      record({ outcome: 'undecided' }),
      { evaluation: unknown, sourceCatalogDates: [] },
    ];
    expect(summarizeEvaluations(records)).toEqual({
      total: 6,
      outcomes: { a: 3, b: 1, tie: 1, undecided: 1 },
      relations: { higher: 1, lower: 1, equal: 1, tie: 1, undecided: 1, unavailable: 1 },
      recordedRelations: {
        higher: 0,
        lower: 0,
        equal: 0,
        tie: 0,
        undecided: 0,
        unavailable: 0,
        unrecorded: 6,
      },
    });
    const before = analyzeEvaluation(evaluation());
    const tuned = evaluation();
    tuned.candidates[0].parameters.speedScale = 0.5;
    expect(analyzeEvaluation(tuned)).toEqual(before);
  });
  it('rejects malformed snapshots, duplicate candidates, future versions and excessive record counts', () => {
    const archive = makeEvaluationDataset([record()]);
    expect(() => parseEvaluationFile({ ...archive, version: 9 })).toThrow('バージョン');
    expect(() =>
      parseEvaluationFile({ ...archive, records: [record({ reason: 'a'.repeat(1001) })] }),
    ).toThrow('設定範囲');
    const invalid = evaluation();
    invalid.candidates[1].voiceId = invalid.candidates[0].voiceId;
    expect(() =>
      parseEvaluationFile({
        ...archive,
        records: [{ evaluation: invalid, sourceCatalogDates: [] }],
      }),
    ).toThrow('形式');
    expect(() =>
      parseEvaluationFile({ ...archive, records: Array(maxEvaluationRecords + 1).fill(record()) }),
    ).toThrow('件数');
    const outOfRange = evaluation();
    outOfRange.candidates[0].parameters.pitchScale = 1;
    expect(() =>
      parseEvaluationFile({
        ...archive,
        records: [{ evaluation: outOfRange, sourceCatalogDates: [] }],
      }),
    ).toThrow('設定範囲');
  });
  it('fails capacity checks atomically while allowing duplicates at the limit', () => {
    const full = Array.from({ length: maxEvaluationRecords }, (_, i) =>
      record({ reason: String(i) }),
    );
    expect(mergeEvaluationRecords(full, [full[0]]).records).toHaveLength(maxEvaluationRecords);
    expect(() => mergeEvaluationRecords(full, [record({ reason: '追加' })])).toThrow('1000件');
    expect(full).toHaveLength(maxEvaluationRecords);
    expect(full[0].sourceCatalogDates).toEqual(['2026-10-20']);
  });
  it('exports CSV with exact conditions, multiline quoting and neutralized text formulas', () => {
    const input = record({
      reason: ' =SUM("1",2)\n次の行',
      sampleText: '@SUM(1)',
      characterInput: { mode: 'text', text: '=作者の設定', direction: '+演出指示' },
    });
    input.evaluation.candidates[0].parameters.pitchScale = -0.1;
    const csv = evaluationsCsv([input]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"\' =SUM(""1"",2)\n次の行"');
    expect(csv).toContain('"\'@SUM(1)"');
    expect(csv).toContain('"\'=作者の設定"');
    expect(csv).toContain('"\'+演出指示"');
    expect(csv).toContain('"-0.1"');
    expect(csv).toContain('"current_catalog_reviewed_at"');
    expect(csv).toContain('"a_speedScale"');
    expect(csv).toContain('"2026-10-20"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});
