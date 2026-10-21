import { describe, expect, it } from 'vitest';
import { catalogRevision, catalogReviewedAt, voices } from '../shared/catalog';
import { recommendationRevision, makeRecipe } from '../shared/recommend';
import { captureEvaluationEvidence, type EngineInfo } from '../shared/evaluation-evidence';
import { evaluationSchema, parseSavedRecipe, type Evaluation } from '../shared/saved-recipe';
import {
  analyzeEvaluation,
  makeEvaluationDataset,
  parseEvaluationFile,
  mergeEvaluationRecords,
  evaluationsCsv,
  summarizeEvaluations,
  type EvaluationRecord,
} from '../shared/evaluation-dataset';

const metan = voices.find((voice) => voice.id === 'vv-metan')!;
const ryusei = voices.find((voice) => voice.id === 'vv-ryusei')!;
const profile = { ...metan.profile };
const info: EngineInfo = {
  engine: 'VOICEVOX',
  version: '0.25.0-test',
  checkedAt: '2026-10-21T00:00:00Z',
};
function evaluation(): Evaluation {
  return {
    recordedAt: '2026-10-21T00:01:00Z',
    profile: { ...profile },
    sampleText: '保存した推薦を比較します。',
    outcome: 'a',
    reason: '役柄に合う。',
    candidates: [metan, ryusei].map((voice) => ({
      voiceId: voice.id,
      parameters: makeRecipe(profile, voice),
    })) as Evaluation['candidates'],
    evidence: captureEvaluationEvidence(profile, [metan.id, ryusei.id], [info, null]),
  };
}
function record(item = evaluation()): EvaluationRecord {
  return { evaluation: item, sourceCatalogDates: [catalogReviewedAt] };
}
function recipe() {
  const item = evaluation();
  return {
    format: 'voice-atlas-recipe',
    version: 3,
    createdAt: item.recordedAt,
    source: 'manual',
    manuallyAdjusted: false,
    voice: metan,
    profile,
    parameters: item.candidates[0].parameters,
    sampleText: item.sampleText,
    catalogReviewedAt,
    preferences: { engine: 'VOICEVOX', budget: 'free' },
    candidates: item.candidates,
    comparisonIds: [metan.id, ryusei.id],
    evaluations: [item],
  };
}

describe('evaluation-time recommendation evidence', () => {
  it('captures scores and ordinal positions in the whole VOICEVOX catalog with independent engine information', () => {
    const evidence = evaluation().evidence!;
    expect(evidence).toMatchObject({
      algorithmRevision: recommendationRevision,
      catalogRevision,
      catalogReviewedAt,
      rankingScope: 'voicevox-all',
      candidateCount: 20,
    });
    expect(evidence.candidates[0]).toMatchObject({ voiceId: metan.id, score: 100, rank: 1 });
    expect(evidence.candidates[1].rank).toBeGreaterThan(1);
    expect(evidence.engines).toEqual([info, null]);
    expect(evidence.engines[0]).not.toBe(info);
  });
  it('retains the original evidence after a catalog change while recalculating current scores and ranks', () => {
    const original = evaluation();
    const saved = JSON.stringify(makeEvaluationDataset([record(original)]));
    const previous = metan.profile;
    try {
      metan.profile = { pitch: 0, energy: 0, warmth: 0, airiness: 0 };
      const restored = parseEvaluationFile(JSON.parse(saved))[0].evaluation;
      const analysis = analyzeEvaluation(restored);
      expect(restored.evidence).toEqual(original.evidence);
      expect(analysis.scores[0]).toBeLessThan(100);
      expect(analysis.scoreDeltas[0]).toBe(analysis.scores[0]! - 100);
      expect(analysis.ranks[0]).toBeGreaterThan(1);
      expect(restored.evidence!.candidates[0].rank).toBe(1);
    } finally {
      metan.profile = previous;
    }
  });
  it('round-trips v3 recipes and v2 datasets alongside old v1/v2 files without inventing past evidence', () => {
    const original = recipe();
    const saved = parseSavedRecipe(JSON.parse(JSON.stringify(original)));
    if (saved.version !== 3) throw new Error('expected v3');
    expect(saved.evaluations[0].evidence).toEqual(original.evaluations[0].evidence);
    const old = evaluation();
    delete old.evidence;
    const records = [record(), record(old)];
    expect(makeEvaluationDataset(records).version).toBe(2);
    expect(parseEvaluationFile(makeEvaluationDataset(records))).toEqual(records);
    expect(
      parseEvaluationFile({
        format: 'voice-atlas-evaluations',
        version: 1,
        createdAt: old.recordedAt,
        records: [record(old)],
      }),
    ).toEqual([record(old)]);
    expect(
      parseEvaluationFile({
        format: 'voice-atlas-recipe',
        version: 2,
        catalogReviewedAt,
        evaluations: [old],
      })[0].evaluation,
    ).not.toHaveProperty('evidence');
    expect(parseEvaluationFile(original)[0].evaluation.evidence).toEqual(
      original.evaluations[0].evidence,
    );
    expect(parseSavedRecipe({ ...original, version: 2, evaluations: [old] }).version).toBe(2);
    const summary = summarizeEvaluations(records);
    expect(summary.recordedRelations.higher).toBe(1);
    expect(summary.recordedRelations.unrecorded).toBe(1);
  });
  it('distinguishes original and current preferences across historical revisions, ties and missing current candidates', () => {
    const item = evaluation();
    item.evidence!.algorithmRevision = 'old-ranking-v0';
    item.evidence!.catalogRevision = 'catalog-old';
    item.evidence!.candidates[0].score = 10;
    item.evidence!.candidates[1].score = 90;
    expect(analyzeEvaluation(item)).toMatchObject({
      relation: 'higher',
      recordedRelation: 'lower',
    });
    item.evidence!.candidates[0].score = 90;
    expect(analyzeEvaluation(item).recordedRelation).toBe('equal');
    item.candidates[0].voiceId = 'removed-voice';
    item.evidence!.candidates[0].voiceId = 'removed-voice';
    expect(analyzeEvaluation(item)).toMatchObject({
      relation: 'unavailable',
      recordedRelation: 'equal',
      scores: [null, expect.any(Number)],
      scoreDeltas: [null, expect.any(Number)],
    });
    item.outcome = 'tie';
    expect(analyzeEvaluation(item).recordedRelation).toBe('tie');
    item.outcome = 'undecided';
    expect(analyzeEvaluation(item).recordedRelation).toBe('undecided');
    delete item.evidence;
    expect(analyzeEvaluation(item).recordedRelation).toBe('unrecorded');
  });
  it('deduplicates only identical evidence and never overwrites conflicting historical revisions or old records', () => {
    const original = record();
    const changed = record();
    changed.evaluation.evidence!.catalogRevision = 'catalog-other';
    const old = record();
    delete old.evaluation.evidence;
    const merged = mergeEvaluationRecords([original], [record(), changed, old]);
    expect(merged.duplicates).toBe(1);
    expect(merged.records).toHaveLength(3);
    expect(original.evaluation.evidence!.catalogRevision).toBe(catalogRevision);
    const timestampVariant = record();
    timestampVariant.evaluation.evidence!.engines[0]!.checkedAt = '2026-10-21T00:00:00.000Z';
    expect(mergeEvaluationRecords([original], [timestampVariant]).duplicates).toBe(1);
  });
  it('rejects invalid recorded scores, bounds, identities, revisions and engine data atomically', () => {
    const mutate = [
      (item: Evaluation) => {
        item.evidence!.candidates[0].score = 101;
      },
      (item: Evaluation) => {
        item.evidence!.candidates[0].rank = 21;
      },
      (item: Evaluation) => {
        item.evidence!.candidates[0].rank = item.evidence!.candidates[1].rank;
      },
      (item: Evaluation) => {
        item.evidence!.candidates[0].voiceId = 'different';
      },
      (item: Evaluation) => {
        item.evidence!.algorithmRevision = '';
      },
      (item: Evaluation) => {
        item.evidence!.catalogReviewedAt = 'not-date';
      },
      (item: Evaluation) => {
        item.evidence!.engines[0]!.version = 'a\r\nInjected: value';
      },
      (item: Evaluation) => {
        item.evidence!.engines[0]!.version = 'a'.repeat(101);
      },
    ];
    for (const change of mutate) {
      const invalid = evaluation();
      change(invalid);
      expect(evaluationSchema.safeParse(invalid).success).toBe(false);
      expect(() =>
        parseEvaluationFile({ ...makeEvaluationDataset([]), records: [record(invalid)] }),
      ).toThrow('設定範囲');
      expect(() => parseSavedRecipe({ ...recipe(), evaluations: [invalid] })).toThrow('設定範囲');
      const existing = [record()];
      expect(() => mergeEvaluationRecords(existing, [record(invalid)])).toThrow();
      expect(existing[0].evaluation.evidence!.candidates[0].score).toBe(100);
    }
  });
  it('exports historical and current values with separate revision and engine columns and blank missing evidence', () => {
    const row = record();
    row.evaluation.evidence!.catalogRevision = 'catalog-historical';
    row.evaluation.evidence!.candidates[0].score = 5;
    const csv = evaluationsCsv([row]);
    expect(csv).toContain('"recorded_score_a"');
    expect(csv).toContain('"current_score_a"');
    expect(csv).toContain('"recorded_catalog_revision"');
    expect(csv).toContain('"catalog-historical"');
    expect(csv).toContain('"score_delta_a"');
    expect(csv).toContain('"95"');
    expect(csv).toContain('"0.25.0-test"');
    const old = evaluation();
    delete old.evidence;
    expect(evaluationsCsv([record(old)])).toContain('評価時の記録なし');
    expect(evaluationsCsv([record(old)])).not.toContain('0.25.0-test');
  });
});
