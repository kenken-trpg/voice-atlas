import { z } from 'zod';
import { catalogRevision, catalogReviewedAt } from './catalog';
import { recommend, recommendationRevision } from './recommend';
import type { Profile } from './schema';

const revision = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._-]+$/);
export const engineInfoSchema = z.object({
  engine: z.literal('VOICEVOX'),
  version: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  checkedAt: z.iso.datetime(),
});
export type EngineInfo = z.infer<typeof engineInfoSchema>;
const rankedCandidateSchema = z.object({
  voiceId: z.string().min(1).max(100),
  score: z.number().int().min(0).max(100),
  rank: z.number().int().min(1).max(10000),
});
export const evaluationEvidenceSchema = z
  .object({
    algorithmRevision: revision,
    catalogRevision: revision,
    catalogReviewedAt: z.iso.date(),
    rankingScope: z.literal('voicevox-all'),
    candidateCount: z.number().int().min(2).max(10000),
    candidates: z.tuple([rankedCandidateSchema, rankedCandidateSchema]),
    engines: z.tuple([engineInfoSchema.nullable(), engineInfoSchema.nullable()]),
  })
  .refine(
    (item) =>
      item.candidates.every((candidate) => candidate.rank <= item.candidateCount) &&
      item.candidates[0].rank !== item.candidates[1].rank &&
      item.candidates[0].voiceId !== item.candidates[1].voiceId,
    { message: '評価時の候補・順位が一致しません。' },
  );
export type EvaluationEvidence = z.infer<typeof evaluationEvidenceSchema>;

export function voicevoxRanking(profile: Profile) {
  return recommend(profile, { engine: 'VOICEVOX', budget: 'all' });
}

export function captureEvaluationEvidence(
  profile: Profile,
  ids: [string, string],
  engines: [EngineInfo | null, EngineInfo | null],
): EvaluationEvidence {
  const ranked = voicevoxRanking(profile);
  return evaluationEvidenceSchema.parse({
    algorithmRevision: recommendationRevision,
    catalogRevision,
    catalogReviewedAt,
    rankingScope: 'voicevox-all',
    candidateCount: ranked.length,
    candidates: ids.map((voiceId) => {
      const index = ranked.findIndex((item) => item.voice.id === voiceId);
      return { voiceId, score: ranked[index]?.score, rank: index + 1 };
    }),
    engines,
  });
}
