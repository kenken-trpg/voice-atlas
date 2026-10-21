import { z } from 'zod';
import { catalogReviewedAt, voices } from './catalog';
import { recommend } from './recommend';
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
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  records: z.array(recordSchema).max(maxEvaluationRecords),
});
const recipeHistorySchema = z.discriminatedUnion('version', [
  z.object({ format: z.literal('voice-atlas-recipe'), version: z.literal(1) }),
  z.object({
    format: z.literal('voice-atlas-recipe'),
    version: z.literal(2),
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
    throw new Error('評価履歴を含むレシピJSON（v2）または評価JSON（v1）を指定してください。');
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
    version: 1,
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
export function analyzeEvaluation(evaluation: Evaluation) {
  const ranked = recommend(evaluation.profile, { engine: 'all', budget: 'all' });
  const scores = evaluation.candidates.map(
    (candidate) => ranked.find((item) => item.voice.id === candidate.voiceId)?.score ?? null,
  ) as [number | null, number | null];
  let relation: ScoreRelation;
  if (evaluation.outcome === 'tie' || evaluation.outcome === 'undecided')
    relation = evaluation.outcome;
  else if (scores[0] === null || scores[1] === null) relation = 'unavailable';
  else {
    const difference = evaluation.outcome === 'a' ? scores[0] - scores[1] : scores[1] - scores[0];
    relation = difference === 0 ? 'equal' : difference > 0 ? 'higher' : 'lower';
  }
  return { scores, relation };
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
  for (const record of records) {
    outcomes[record.evaluation.outcome]++;
    relations[analyzeEvaluation(record.evaluation).relation]++;
  }
  return { total: records.length, outcomes, relations };
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
    ];
  });
  return (
    '\uFEFF' + [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
  );
}
