import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { castingCandidateSchema, type CastingCandidate } from '../shared/casting';
import { listeningSentences, listeningSentenceRevision } from '../shared/listening-evaluation';
import { catalogRevision } from '../shared/catalog';
import { recommendationRevision } from '../shared/recommend';
import { castingSynthesize } from './tts/casting';
import type { Config } from './config';

export async function runListeningEvaluation(
  config: Config,
  input: { candidate: CastingCandidate; output: string; machineNote?: string },
  synthesize: typeof castingSynthesize = castingSynthesize,
) {
  const candidate = castingCandidateSchema.parse(input.candidate);
  const output = resolve(input.output);
  if ((input.machineNote?.length ?? 0) > 500)
    throw new Error('機器の補足は500文字以下にしてください。');
  await mkdir(dirname(output), { recursive: true });
  // Reserve a fresh directory before generating. A previous run is never overwritten.
  await mkdir(output);
  const manifest = {
    format: 'voice-atlas-listening-run',
    version: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    finishedAt: null as string | null,
    status: 'running' as 'running' | 'completed' | 'failed',
    sentenceRevision: listeningSentenceRevision,
    catalogRevision,
    recommendationRevision,
    machine: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? null,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      note: input.machineNote ?? '',
    },
    candidate,
    listening: { status: 'not-reviewed', reviewer: '', notes: '', ratings: null },
    samples: [] as {
      id: string;
      purpose: string;
      text: string;
      file: string;
      elapsedMs: number;
      bytes: number;
      sha256: string;
      generation: Awaited<ReturnType<typeof castingSynthesize>>['generation'];
    }[],
    failedSentenceId: null as string | null,
    error: null as string | null,
  };
  const save = async () => {
    await writeFile(join(output, 'manifest.pending.json'), JSON.stringify(manifest, null, 2));
    await rename(join(output, 'manifest.pending.json'), join(output, 'manifest.json'));
  };
  await save();
  for (const sentence of listeningSentences) {
    try {
      const start = performance.now();
      const result = await synthesize(config, candidate, sentence.text, fetch);
      const elapsedMs = Math.round(performance.now() - start);
      const file = `${sentence.id}.wav`;
      await writeFile(join(output, file), result.wav, { flag: 'wx' });
      manifest.samples.push({
        ...sentence,
        file,
        elapsedMs,
        bytes: result.wav.byteLength,
        sha256: createHash('sha256').update(result.wav).digest('hex'),
        generation: result.generation,
      });
      await save();
    } catch (cause) {
      manifest.status = 'failed';
      manifest.finishedAt = new Date().toISOString();
      manifest.failedSentenceId = sentence.id;
      manifest.error =
        cause instanceof Error ? cause.message.slice(0, 300) : '音声生成に失敗しました。';
      await save();
      throw new Error(
        `評価音声の生成を停止しました。成功済み音声と失敗箇所は ${output} の manifest.json に記録しています。`,
      );
    }
  }
  manifest.status = 'completed';
  manifest.finishedAt = new Date().toISOString();
  await save();
  return manifest;
}
