import { z } from 'zod';
import { historicalCastingCandidateSchema, generationSchema } from './casting';
import { listeningSentences, listeningSentenceRevision } from './listening-evaluation';

const sentenceId = z.enum(listeningSentences.map((item) => item.id));
const boundedText = z.string().max(2000);
export const listeningRunSchema = z
  .object({
    format: z.literal('voice-atlas-listening-run'),
    version: z.literal(1),
    id: z.string().uuid(),
    createdAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    status: z.enum(['running', 'completed', 'failed']),
    sentenceRevision: z.literal(listeningSentenceRevision),
    catalogRevision: z.string().max(200),
    recommendationRevision: z.string().max(200),
    machine: z.object({
      platform: z.string().max(200),
      release: z.string().max(200),
      arch: z.string().max(100),
      cpu: z.string().max(500).nullable(),
      logicalCpus: z.number().int().min(0).max(4096),
      memoryBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      note: z.string().max(500),
    }),
    candidate: historicalCastingCandidateSchema,
    samples: z
      .array(
        z.object({
          id: sentenceId,
          purpose: z.string().max(200),
          text: z.string().max(1000),
          file: z.string().regex(/^[a-z]+\.wav$/),
          elapsedMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
          bytes: z
            .number()
            .int()
            .min(44)
            .max(20 * 1024 * 1024),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          generation: generationSchema,
        }),
      )
      .max(6),
    failedSentenceId: sentenceId.nullable(),
    error: z.string().max(1000).nullable(),
  })
  .superRefine((run, ctx) => {
    const ids = new Set<string>();
    const files = new Set<string>();
    for (const sample of run.samples) {
      const reference = listeningSentences.find((item) => item.id === sample.id)!;
      if (
        ids.has(sample.id) ||
        files.has(sample.file) ||
        sample.text !== reference.text ||
        sample.generation.engine !== run.candidate.voice.engine
      )
        ctx.addIssue({ code: 'custom', message: '共通文・生成情報・重複を確認してください。' });
      ids.add(sample.id);
      files.add(sample.file);
    }
    if (run.status === 'completed' && run.samples.length !== 6)
      ctx.addIssue({ code: 'custom', message: '完了ランには6文が必要です。' });
  });
export type ListeningRun = z.infer<typeof listeningRunSchema>;
const rating = z.number().int().min(1).max(5).nullable();
export const sampleReviewSchema = z.object({
  listened: z.boolean(),
  naturalness: rating,
  intelligibility: rating,
  characterFit: rating,
  decision: z.enum(['undecided', 'adopt', 'reject']),
  notes: boundedText,
});
export type SampleReview = z.infer<typeof sampleReviewSchema>;
export const emptySampleReview = (): SampleReview => ({
  listened: false,
  naturalness: null,
  intelligibility: null,
  characterFit: null,
  decision: 'undecided',
  notes: '',
});
const reviewedRunSchema = z.object({
  manifest: listeningRunSchema,
  notes: boundedText,
  reviews: z.record(sentenceId, sampleReviewSchema),
});
export const listeningComparisonSchema = z
  .object({
    format: z.literal('voice-atlas-listening-comparison'),
    version: z.literal(1),
    reviewer: z.string().max(100),
    environment: z.string().max(500),
    characterBrief: boundedText,
    runs: z.array(reviewedRunSchema).max(4),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.runs.map((run) => run.manifest.id)).size !== value.runs.length)
      ctx.addIssue({ code: 'custom', message: '実行IDが重複しています。' });
  });
export type ReviewedRun = z.infer<typeof reviewedRunSchema>;
export type ListeningComparison = z.infer<typeof listeningComparisonSchema>;
export const emptyReviews = () =>
  Object.fromEntries(
    listeningSentences.map((s) => [s.id, emptySampleReview()]),
  ) as ReviewedRun['reviews'];
export function timingSummary(run: ListeningRun) {
  const first =
    run.samples.find((sample) => sample.id === listeningSentences[0].id)?.elapsedMs ?? null;
  const rest = run.samples.filter((sample) => sample.id !== listeningSentences[0].id);
  return {
    first,
    laterMean: rest.length
      ? rest.reduce((sum, sample) => sum + sample.elapsedMs, 0) / rest.length
      : null,
    laterCount: rest.length,
  };
}
