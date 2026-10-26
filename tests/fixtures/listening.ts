import { createHash } from 'node:crypto';
import { listeningSentences, listeningSentenceRevision } from '../../shared/listening-evaluation';
import { listeningRunSchema } from '../../shared/listening-review';
import { makeCastingEvaluation } from './casting';
import { pcmWav } from './wav';
export const listeningWav = Buffer.from(pcmWav([100, -100, 200]));
export function listeningRun(id = '10000000-0000-4000-8000-000000000001') {
  const candidate = makeCastingEvaluation().candidates[1];
  return listeningRunSchema.parse({
    format: 'voice-atlas-listening-run',
    version: 1,
    id,
    createdAt: '2026-10-26T00:00:00Z',
    finishedAt: '2026-10-26T00:01:00Z',
    status: 'completed',
    sentenceRevision: listeningSentenceRevision,
    catalogRevision: 'test',
    recommendationRevision: 'test',
    machine: {
      platform: 'test',
      release: 'test',
      arch: 'arm64',
      cpu: 'test CPU',
      logicalCpus: 8,
      memoryBytes: 16 * 1024 ** 3,
      note: '合成PCMによるテスト',
    },
    candidate,
    samples: listeningSentences.map((sentence, index) => ({
      ...sentence,
      file: `${sentence.id}.wav`,
      elapsedMs: index ? 100 : 1000,
      bytes: listeningWav.length,
      sha256: createHash('sha256').update(listeningWav).digest('hex'),
      generation: {
        engine: candidate.voice.engine,
        engineVersion: 'test',
        checkedAt: '2026-10-26T00:00:00Z',
      },
    })),
    failedSentenceId: null,
    error: null,
  });
}
