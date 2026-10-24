import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runListeningEvaluation } from '../server/listening-evaluation';
import { castingSynthesize } from '../server/tts/casting';
import { listeningSentences } from '../shared/listening-evaluation';
import { makeCastingEvaluation } from './fixtures/casting';
import { pcmWav } from './fixtures/wav';
import type { Config } from '../server/config';

const config: Config = {
  port: 3210,
  ollamaUrl: 'http://127.0.0.1:1',
  ollamaModel: 'unused',
  openaiKey: 'secret-not-to-save',
  openaiModel: 'unused',
  anthropicKey: '',
  anthropicModel: 'unused',
  geminiKey: '',
  geminiModel: 'unused',
  deepseekKey: '',
  deepseekModel: 'unused',
  voicevoxUrl: 'http://127.0.0.1:1',
};
const candidate = makeCastingEvaluation().candidates[1];
const result = {
  wav: Buffer.from(pcmWav([100, -100, 200])),
  generation: {
    engine: 'VOICEVOX' as const,
    engineVersion: 'mock-only',
    checkedAt: '2026-10-22T00:00:00Z',
  },
};
const directories: string[] = [];
async function output() {
  const directory = await mkdtemp(join(tmpdir(), 'voice-atlas-listening-'));
  directories.push(directory);
  return join(directory, 'run');
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe('repeatable listening runs (synthetic audio only)', () => {
  it('records every sentence in order with hashes, timing and actual generation evidence, without claiming a listening review', async () => {
    const directory = await output();
    const synthesize = vi.fn<typeof castingSynthesize>().mockResolvedValue(result);
    const manifest = await runListeningEvaluation(
      config,
      { candidate, output: directory, machineNote: 'モック検証' },
      synthesize,
    );
    expect(manifest.status).toBe('completed');
    expect(manifest.listening.status).toBe('not-reviewed');
    expect(manifest.samples.map((item) => item.id)).toEqual(
      listeningSentences.map((item) => item.id),
    );
    expect(synthesize.mock.calls.map((args) => args[2])).toEqual(
      listeningSentences.map((item) => item.text),
    );
    expect(manifest.samples[0]).toMatchObject({
      bytes: result.wav.length,
      generation: result.generation,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      elapsedMs: expect.any(Number),
    });
    expect(await readFile(join(directory, 'greeting.wav'))).toEqual(result.wav);
    const saved = await readFile(join(directory, 'manifest.json'), 'utf8');
    expect(JSON.parse(saved)).toEqual(manifest);
    expect(saved).not.toContain(config.openaiKey);
    expect(await readdir(directory)).toHaveLength(listeningSentences.length + 1);
    const before = synthesize.mock.calls.length;
    await expect(
      runListeningEvaluation(config, { candidate, output: directory }, synthesize),
    ).rejects.toThrow();
    expect(synthesize).toHaveBeenCalledTimes(before);
    expect(await readFile(join(directory, 'manifest.json'), 'utf8')).toBe(saved);
  });
  it('retains partial successes and identifies the failed sentence, without inventing successful generation information', async () => {
    const directory = await output();
    const synthesize = vi
      .fn<typeof castingSynthesize>()
      .mockResolvedValueOnce(result)
      .mockRejectedValue(new Error('モックの合成失敗'));
    await expect(
      runListeningEvaluation(config, { candidate, output: directory }, synthesize),
    ).rejects.toThrow('成功済み音声');
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    expect(manifest.status).toBe('failed');
    expect(manifest.samples).toHaveLength(1);
    expect(manifest.failedSentenceId).toBe(listeningSentences[1].id);
    expect(manifest.error).toBe('モックの合成失敗');
    expect(await readdir(directory)).toEqual(['greeting.wav', 'manifest.json']);
  });
  it('rejects mismatched native settings before creating output or contacting the engine', async () => {
    const directory = await output();
    const synthesize = vi.fn<typeof castingSynthesize>();
    const wrong = { ...candidate, recipe: makeCastingEvaluation().candidates[0].recipe };
    await expect(
      runListeningEvaluation(config, { candidate: wrong, output: directory }, synthesize),
    ).rejects.toThrow();
    expect(synthesize).not.toHaveBeenCalled();
    await expect(readdir(directory)).rejects.toThrow();
  });
});
