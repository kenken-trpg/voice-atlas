import { z } from 'zod';
import { catalogReviewedAt, catalogRevision, voices } from './catalog';
import { recommendationRevision } from './recommend';
import { voicevoxRanking } from './evaluation-evidence';
import { evaluationSchema, type Evaluation } from './saved-recipe';
import { axes, recipeFields } from './schema';

export const maxEvaluationRecords = 1000;
export const maxEvaluationFileBytes = 16 * 1024 * 1024;
export const maxEvaluationBatchBytes = 32 * 1024 * 1024;
export const maxEvaluationFiles = 20;
export const outcomeLabels = {
  a: 'Aを採用',
  b: 'Bを採用',
  tie: '同程度',
  undecided: '判断できない',
};
const historicalEvaluationSchema = evaluationSchema.refine(
  (item) => item.candidates[0].voiceId !== item.candidates[1].voiceId,
);
const recordSchema = z.object({
  evaluation: historicalEvaluationSchema,
  // These dates belong to imported files or the current workspace, not necessarily to
  // the catalog or algorithm that was used when the listener evaluated it.
  sourceCatalogDates: z.array(z.iso.date()).max(100),
});
export type EvaluationRecord = z.infer<typeof recordSchema>;
const datasetSchema = z.object({
  format: z.literal('voice-atlas-evaluations'),
  version: z.union([z.literal(1), z.literal(2)]),
  createdAt: z.iso.datetime(),
  records: z.array(recordSchema).max(maxEvaluationRecords),
});
const recipeHistorySchema = z.discriminatedUnion('version', [
  z.object({ format: z.literal('voice-atlas-recipe'), version: z.literal(1) }),
  z.object({
    format: z.literal('voice-atlas-recipe'),
    version: z.union([z.literal(2), z.literal(3)]),
    catalogReviewedAt: z.iso.date(),
    evaluations: z.array(historicalEvaluationSchema).max(100),
  }),
]);

export function parseEvaluationFile(input: unknown): EvaluationRecord[] {
  if (
    input &&
    typeof input === 'object' &&
    'format' in input &&
    input.format === 'voice-atlas-evaluations'
  ) {
    const result = datasetSchema.safeParse(input);
    if (!result.success)
      throw new Error('評価JSONのバージョン・形式・件数・設定範囲を確認してください。');
    return result.data.records;
  }
  // Only the history is imported. Reopening a voice recipe is a separate action;
  // historic IDs may remain useful after a voice is removed from today's catalog.
  const result = recipeHistorySchema.safeParse(input);
  if (!result.success)
    throw new Error(
      '評価履歴を含むレシピJSON（v2・v3）または評価JSON（v1・v2）を指定してください。',
    );
  const saved = result.data;
  if (saved.version === 1) return [];
  return saved.evaluations.map((evaluation) => ({
    evaluation,
    sourceCatalogDates: [saved.catalogReviewedAt],
  }));
}

export function evaluationKey(evaluation: Evaluation) {
  // Parse again to canonicalize property order and strip unknown fields. A/B
  // order, the exact text, reason and tuning remain part of the experiment.
  const normalized = historicalEvaluationSchema.parse(evaluation);
  if (normalized.evidence) {
    normalized.evidence.engines.forEach((engine) => {
      if (engine) engine.checkedAt = new Date(engine.checkedAt).toISOString();
    });
  }
  return JSON.stringify({
    ...normalized,
    recordedAt: new Date(normalized.recordedAt).toISOString(),
  });
}

export function mergeEvaluationRecords(existing: EvaluationRecord[], incoming: EvaluationRecord[]) {
  const records = new Map<string, EvaluationRecord>();
  let duplicates = 0;
  const add = (record: EvaluationRecord, countDuplicate: boolean) => {
    const clean = recordSchema.parse(record);
    const key = evaluationKey(clean.evaluation);
    const previous = records.get(key);
    const sourceCatalogDates = [
      ...new Set([...(previous?.sourceCatalogDates ?? []), ...clean.sourceCatalogDates]),
    ].sort();
    if (sourceCatalogDates.length > 100)
      throw new Error('同じ評価の保存元の確認日が上限（100件）を超えました。');
    if (previous && countDuplicate) duplicates++;
    records.set(key, { evaluation: previous?.evaluation ?? clean.evaluation, sourceCatalogDates });
    if (records.size > maxEvaluationRecords)
      throw new Error(
        `集計できる評価は${maxEvaluationRecords}件までです。現在の集計は保持します。`,
      );
  };
  existing.forEach((record) => add(record, false));
  incoming.forEach((record) => add(record, true));
  return {
    records: [...records.values()].sort(
      (a, b) => Date.parse(b.evaluation.recordedAt) - Date.parse(a.evaluation.recordedAt),
    ),
    duplicates,
  };
}

export function makeEvaluationDataset(records: EvaluationRecord[]) {
  return datasetSchema.parse({
    format: 'voice-atlas-evaluations',
    version: 2,
    createdAt: new Date().toISOString(),
    records,
  });
}

export const relationLabels = {
  higher: '高スコアの候補を採用',
  lower: '低スコアの候補を採用',
  equal: 'スコア同点の候補を採用',
  tie: '同程度',
  undecided: '判断できない',
  unavailable: 'カタログ未収録',
};
export type ScoreRelation = keyof typeof relationLabels;
export const recordedRelationLabels = { ...relationLabels, unrecorded: '評価時の記録なし' };
export type RecordedScoreRelation = keyof typeof recordedRelationLabels;

function scoreRelation(
  evaluation: Evaluation,
  scores: [number | null, number | null],
): ScoreRelation {
  if (evaluation.outcome === 'tie' || evaluation.outcome === 'undecided') return evaluation.outcome;
  if (scores[0] === null || scores[1] === null) return 'unavailable';
  const difference = evaluation.outcome === 'a' ? scores[0] - scores[1] : scores[1] - scores[0];
  return difference === 0 ? 'equal' : difference > 0 ? 'higher' : 'lower';
}
export function analyzeEvaluation(evaluation: Evaluation) {
  const ranked = voicevoxRanking(evaluation.profile);
  const scores = evaluation.candidates.map(
    (candidate) => ranked.find((item) => item.voice.id === candidate.voiceId)?.score ?? null,
  ) as [number | null, number | null];
  const ranks = evaluation.candidates.map((candidate) => {
    const index = ranked.findIndex((item) => item.voice.id === candidate.voiceId);
    return index < 0 ? null : index + 1;
  });
  const recordedScores = evaluation.evidence?.candidates.map((candidate) => candidate.score) as
    [number, number] | undefined;
  return {
    scores,
    ranks,
    candidateCount: ranked.length,
    relation: scoreRelation(evaluation, scores),
    recordedRelation: recordedScores
      ? scoreRelation(evaluation, recordedScores)
      : ('unrecorded' as RecordedScoreRelation),
    scoreDeltas: scores.map((score, index) =>
      score !== null && recordedScores ? score - recordedScores[index] : null,
    ),
  };
}

export function summarizeEvaluations(records: EvaluationRecord[]) {
  const outcomes: Record<Evaluation['outcome'], number> = { a: 0, b: 0, tie: 0, undecided: 0 };
  const relations: Record<ScoreRelation, number> = {
    higher: 0,
    lower: 0,
    equal: 0,
    tie: 0,
    undecided: 0,
    unavailable: 0,
  };
  const recordedRelations: Record<RecordedScoreRelation, number> = { ...relations, unrecorded: 0 };
  for (const record of records) {
    const analysis = analyzeEvaluation(record.evaluation);
    outcomes[record.evaluation.outcome]++;
    relations[analysis.relation]++;
    recordedRelations[analysis.recordedRelation]++;
  }
  return { total: records.length, outcomes, relations, recordedRelations };
}

export function evaluationVoiceLabel(id: string) {
  const voice = voices.find((item) => item.id === id);
  return voice ? `${voice.name} / ${voice.style}` : `未収録：${id}`;
}

function csvCell(value: string | number | null) {
  let text = value === null ? '' : String(value);
  // Quote CSV syntax, and neutralize spreadsheet formulas in user-authored text.
  if (
    typeof value === 'string' &&
    (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))
  )
    text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function evaluationsCsv(records: EvaluationRecord[]) {
  const headers = [
    'recorded_at',
    'outcome',
    'reason',
    'sample_text',
    'source_catalog_dates',
    ...axes.map((axis) => `profile_${axis}`),
    ...['a', 'b'].flatMap((label) => [
      `${label}_voice_id`,
      `${label}_voice`,
      ...recipeFields.map(({ key }) => `${label}_${key}`),
    ]),
    'current_catalog_reviewed_at',
    'current_score_a',
    'current_score_b',
    'current_score_relation',
    'current_algorithm_revision',
    'current_catalog_revision',
    'current_rank_a',
    'current_rank_b',
    'current_candidate_count',
    'recorded_algorithm_revision',
    'recorded_catalog_revision',
    'recorded_catalog_reviewed_at',
    'recorded_ranking_scope',
    'recorded_candidate_count',
    'recorded_score_a',
    'recorded_score_b',
    'recorded_rank_a',
    'recorded_rank_b',
    'recorded_score_relation',
    'score_delta_a',
    'score_delta_b',
    ...['a', 'b'].flatMap((label) => [
      `${label}_engine`,
      `${label}_engine_version`,
      `${label}_engine_checked_at`,
    ]),
  ];
  const rows = records.map(({ evaluation, sourceCatalogDates }) => {
    const analysis = analyzeEvaluation(evaluation);
    return [
      evaluation.recordedAt,
      outcomeLabels[evaluation.outcome],
      evaluation.reason,
      evaluation.sampleText,
      sourceCatalogDates.join(' / '),
      ...axes.map((axis) => evaluation.profile[axis]),
      ...evaluation.candidates.flatMap((candidate) => [
        candidate.voiceId,
        evaluationVoiceLabel(candidate.voiceId),
        ...recipeFields.map(({ key }) => candidate.parameters[key]),
      ]),
      catalogReviewedAt,
      ...analysis.scores,
      relationLabels[analysis.relation],
      recommendationRevision,
      catalogRevision,
      ...analysis.ranks,
      analysis.candidateCount,
      evaluation.evidence?.algorithmRevision ?? null,
      evaluation.evidence?.catalogRevision ?? null,
      evaluation.evidence?.catalogReviewedAt ?? null,
      evaluation.evidence?.rankingScope ?? null,
      evaluation.evidence?.candidateCount ?? null,
      ...(evaluation.evidence?.candidates.map((candidate) => candidate.score) ?? [null, null]),
      ...(evaluation.evidence?.candidates.map((candidate) => candidate.rank) ?? [null, null]),
      recordedRelationLabels[analysis.recordedRelation],
      ...analysis.scoreDeltas,
      ...(evaluation.evidence?.engines ?? [null, null]).flatMap((engine) => [
        engine?.engine ?? null,
        engine?.version ?? null,
        engine?.checkedAt ?? null,
      ]),
    ];
  });
  return (
    '\uFEFF' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
  );
}
