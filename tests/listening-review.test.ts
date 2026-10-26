import { describe, it, expect } from 'vitest';
import {
  listeningRunSchema,
  listeningComparisonSchema,
  timingSummary,
  emptyReviews,
} from '../shared/listening-review';
import { listeningRun } from './fixtures/listening';

describe('listening comparison validation', () => {
  it('separates first sample and later timings and accepts partial failed runs', () => {
    const run = listeningRun();
    expect(timingSummary(run)).toEqual({ first: 1000, laterMean: 100, laterCount: 5 });
    run.status = 'failed';
    run.failedSentenceId = 'narration';
    run.samples = run.samples.slice(0, 1);
    expect(listeningRunSchema.safeParse(run).success).toBe(true);
    expect(timingSummary(run)).toEqual({ first: 1000, laterMean: null, laterCount: 0 });
  });
  it('rejects duplicate sentences, altered common text, paths, incompatible revisions and incomplete completed runs', () => {
    for (const mutate of [
      (run: ReturnType<typeof listeningRun>) => {
        run.samples[1] = run.samples[0];
      },
      (run: ReturnType<typeof listeningRun>) => {
        run.samples[0].text = '違う文章';
      },
      (run: ReturnType<typeof listeningRun>) => {
        run.samples[0].file = '../greeting.wav';
      },
      (run: ReturnType<typeof listeningRun>) => {
        Object.assign(run, { sentenceRevision: 'future' });
      },
      (run: ReturnType<typeof listeningRun>) => {
        run.samples.pop();
      },
    ]) {
      const run = listeningRun();
      mutate(run);
      expect(listeningRunSchema.safeParse(run).success).toBe(false);
    }
  });
  it('roundtrips explicit unreviewed values and rejects duplicate runs and out of range ratings', () => {
    const value = {
      format: 'voice-atlas-listening-comparison',
      version: 1,
      reviewer: '',
      environment: '',
      characterBrief: '',
      runs: [{ manifest: listeningRun(), notes: '理由', reviews: emptyReviews() }],
    };
    expect(listeningComparisonSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
    value.runs.push(value.runs[0]);
    expect(listeningComparisonSchema.safeParse(value).success).toBe(false);
    value.runs.pop();
    value.runs[0].reviews.greeting.naturalness = 6;
    expect(listeningComparisonSchema.safeParse(value).success).toBe(false);
  });
});
