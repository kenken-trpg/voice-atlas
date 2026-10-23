import { describe, expect, it } from 'vitest';
import { scriptFixture } from './fixtures/script';
import { makeScriptLine } from '../shared/script';
import {
  startGenerationJob,
  updateGenerationRow,
  finishGenerationJob,
  generationRetryPlan,
} from '../shared/script-generation';

function fixture() {
  const base = scriptFixture();
  return {
    ...base.script,
    lines: [...base.script.lines, { ...makeScriptLine(base.assignments[0]), text: '続けます。' }],
  };
}
describe('script generation progress and retry scope', () => {
  it('records independent snapshots in script order and rejects missing or duplicate targets', () => {
    const script = fixture();
    const job = startGenerationJob(script, [script.lines[2], script.lines[0]]);
    expect(job.rows.map((row) => row.position)).toEqual([1, 3]);
    expect(job.rows.map((row) => row.status)).toEqual(['waiting', 'waiting']);
    script.lines[0].text = '変更';
    expect(job.rows[0].text).toBe('ようこそ。');
    expect(() => startGenerationJob(script, [])).toThrow();
    expect(() => startGenerationJob(script, [script.lines[0], script.lines[0]])).toThrow();
    expect(() => startGenerationJob(script, [makeScriptLine()])).toThrow();
  });
  it('separates failed-only retry from unfinished resume and follows the current script order', () => {
    const script = fixture();
    let job = startGenerationJob(script, script.lines);
    job = updateGenerationRow(job, script.lines[0].id, 'generating');
    job = updateGenerationRow(job, script.lines[0].id, 'succeeded');
    job = updateGenerationRow(job, script.lines[1].id, 'generating');
    job = updateGenerationRow(job, script.lines[1].id, 'failed', '生成に失敗');
    job = finishGenerationJob(job);
    expect(job.rows.map((row) => row.status)).toEqual(['succeeded', 'failed', 'waiting']);
    expect(generationRetryPlan(script, job, 'failed').lines.map((line) => line.id)).toEqual([
      script.lines[1].id,
    ]);
    const reordered = { ...script, lines: [...script.lines].reverse() };
    expect(generationRetryPlan(reordered, job, 'unfinished').lines.map((line) => line.id)).toEqual([
      script.lines[2].id,
      script.lines[1].id,
    ]);
    const retried = startGenerationJob(script, [script.lines[1]], job);
    expect(retried.id).toBe(job.id);
    expect(retried.rows[0]).toEqual(job.rows[0]);
    expect(updateGenerationRow(retried, script.lines[1].id, 'generating').rows[1].attempts).toBe(2);
    expect(retried.rows[1].error).toBeUndefined();
    expect(job.rows[1].error).toBe('生成に失敗');
    expect(() => startGenerationJob(script, [script.lines[0]], job)).toThrow();
  });
  it('detects changed readings, voices and deleted rows while accepting display-only edits', () => {
    const script = fixture();
    script.lines[0] = { ...script.lines[0], spokenText: 'よみ', readingSource: 'manual' };
    const job = startGenerationJob(script, [script.lines[0]]);
    const changed = structuredClone(script);
    changed.lines[0].text = '表記だけを変更';
    expect(generationRetryPlan(changed, job, 'unfinished').invalidIds).toEqual([]);
    changed.lines[0].spokenText = '別のよみ';
    expect(generationRetryPlan(changed, job, 'unfinished').invalidIds).toEqual([
      script.lines[0].id,
    ]);
    expect(() => startGenerationJob(changed, [changed.lines[0]], job)).toThrow();
    expect(
      generationRetryPlan({ ...script, lines: script.lines.slice(1) }, job, 'unfinished')
        .invalidIds,
    ).toEqual([script.lines[0].id]);
    changed.lines[0] = { ...script.lines[0], assignment: script.lines[1].assignment };
    expect(generationRetryPlan(changed, job, 'unfinished').invalidIds).toEqual([
      script.lines[0].id,
    ]);
  });
  it('marks only the in-flight row as stopped and retains successes and untouched queued rows', () => {
    const script = fixture();
    let job = startGenerationJob(script, script.lines);
    job = updateGenerationRow(job, script.lines[0].id, 'succeeded');
    job = updateGenerationRow(job, script.lines[1].id, 'generating');
    const finished = finishGenerationJob(job);
    expect(finished.rows.map((row) => row.status)).toEqual(['succeeded', 'stopped', 'waiting']);
    expect(job.rows[1].status).toBe('generating');
    expect(generationRetryPlan(script, finished, 'failed').lines).toEqual([]);
    expect(generationRetryPlan(script, finished, 'unfinished').lines).toHaveLength(2);
    expect(
      updateGenerationRow(job, script.lines[1].id, 'failed', 'あ'.repeat(500)).rows[1].error,
    ).toHaveLength(250);
  });
});
