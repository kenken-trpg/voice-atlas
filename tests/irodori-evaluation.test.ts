import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { makeIrodoriPlan, irodoriEvaluationSchema } from '../shared/irodori-evaluation';

const config = {
  format: 'voice-atlas-irodori-config',
  version: 1,
  mode: 'voice-design',
  checkpoint: '/unused/model.safetensors',
  codecPath: '/unused/weights.pth',
  device: 'cpu',
  captions: ['落ち着いた声', '明るい声'],
  seeds: [17, 29],
  steps: [20, 40],
  sentenceIds: ['greeting', 'question'],
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function start(command: string, args: string[], input = '', env: NodeJS.ProcessEnv = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', ...env },
  });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (done, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => done({ code, stdout, stderr }));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    },
  );
  return { child, result };
}
function python(args: string[], input = '', env: NodeJS.ProcessEnv = {}) {
  return start('python3', [resolve('server/irodori-evaluate.py'), ...args], input, env).result;
}
function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return start(
    process.execPath,
    ['--import', 'tsx', resolve('server/irodori-probe.ts'), ...args],
    '',
    env,
  );
}

// Implements the upstream dataclass/runtime contract with tiny PCM. No torch,
// model, network or engine installation is used in these integration tests.
async function fixture(mode = 'voice-design') {
  const dir = await mkdtemp(join(tmpdir(), 'voice-atlas-irodori-'));
  directories.push(dir);
  const repo = join(dir, 'repo with spaces');
  await mkdir(join(repo, 'irodori_tts'), { recursive: true });
  await writeFile(join(repo, 'irodori_tts/__init__.py'), '');
  await writeFile(join(repo, 'torch.py'), '');
  await writeFile(
    join(repo, 'irodori_tts/inference_runtime.py'),
    `from dataclasses import dataclass, field
from types import SimpleNamespace
import os, wave, struct, socket, time
@dataclass
class RuntimeKey:
    checkpoint: str
    model_device: str
    codec_repo: str
    model_precision: str
    codec_precision: str
    codec_device: str
    codec_deterministic_encode: bool
    codec_deterministic_decode: bool
    enable_watermark: bool
    compile_model: bool
    compile_dynamic: bool
@dataclass(init=False)
class SamplingRequest:
    values: dict = field(default_factory=dict)
    def __init__(self, **kwargs): self.values = kwargs; self.__dict__.update(kwargs)
class InferenceRuntime:
    calls = 0
    @classmethod
    def from_key(cls, key):
        assert os.environ['HF_HUB_OFFLINE'] == '1'
        assert os.environ['TRANSFORMERS_OFFLINE'] == '1'
        if os.environ.get('MOCK_LOAD_ERROR'): raise RuntimeError('synthetic load failure')
        if os.environ.get('MOCK_NETWORK'): socket.create_connection(('127.0.0.1', 1))
        instance = cls(); instance.key = key
        caption = os.environ.get('MOCK_MODE', 'voice-design') == 'voice-design'
        instance.model_cfg = SimpleNamespace(use_caption_condition=caption, use_speaker_condition=not caption)
        return instance
    def synthesize(self, req):
        self.calls += 1
        if os.environ.get('MOCK_INTERRUPT') and self.calls == 2: raise KeyboardInterrupt('synthetic interrupt')
        if os.environ.get('MOCK_FAIL') and self.calls == 2: raise RuntimeError('synthetic generation failure')
        if os.environ.get('MOCK_WAIT') and self.calls == 2:
            print('ready-for-interrupt', flush=True)
            time.sleep(30)
        audio = SimpleNamespace(shape=[1, 80], seed=req.seed)
        return SimpleNamespace(audio=audio, sample_rate=8000, used_seed=req.seed,
            stage_timings=[('synthetic', 0.001)], total_to_decode=0.001, messages=['synthetic PCM only'])
def save_wav(path, audio, rate):
    with wave.open(str(path), 'wb') as wav:
        wav.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        wav.writeframes(struct.pack('<80h', *([audio.seed] * 80)))
`,
  );
  const checkpoint = join(dir, 'model.safetensors');
  const codecPath = join(dir, 'weights.pth');
  const referenceWav = join(dir, 'reference.wav');
  await Promise.all([
    writeFile(checkpoint, 'synthetic checkpoint'),
    writeFile(codecPath, 'synthetic codec'),
    writeFile(referenceWav, 'synthetic reference'),
  ]);
  const raw = { ...config, checkpoint, codecPath, captions: ['落ち着いた声'], steps: [20] };
  const { captions: _captions, ...reference } = raw;
  const plan = makeIrodoriPlan(
    mode === 'reference' ? { ...reference, mode, referenceWav, referenceNote: 'test only' } : raw,
  );
  const output = join(dir, 'output');
  return {
    dir,
    repo,
    plan,
    output,
    run: (env = {}) =>
      python(['--repo', repo, '--output', output], JSON.stringify(plan), {
        MOCK_MODE: mode,
        ...env,
      }),
    manifest: async () => JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')),
  };
}

describe('Irodori spike plans', () => {
  it('crosses native captions/seeds/steps/texts and repeats an identical condition after other samples', () => {
    const plan = makeIrodoriPlan(config);
    expect(plan.samples).toHaveLength(20);
    expect(new Set(plan.samples.map((sample) => sample.id)).size).toBe(20);
    for (const sample of plan.samples.filter((item) => item.repeatOf)) {
      const original = plan.samples.find((item) => item.id === sample.repeatOf)!;
      expect({ ...sample, id: original.id, repeatOf: null }).toEqual(original);
    }
    expect(plan.sampling).toMatchObject({ cfg_scale_caption: 3, cfg_scale_speaker: 0 });
  });
  it('keeps caption design and reference conditioning separate and bounds the matrix before generation', () => {
    const { captions: _captions, ...common } = config;
    const reference = { ...common, mode: 'reference', referenceWav: '/sample.wav' };
    expect(makeIrodoriPlan(reference).sampling).toMatchObject({
      cfg_scale_caption: 0,
      cfg_scale_speaker: 5,
    });
    for (const invalid of [
      { ...config, referenceWav: '/ignored.wav' },
      { ...reference, captions: ['ignored'] },
      { ...config, seeds: [17, 17] },
      { ...config, seeds: [17] },
      { ...config, seeds: [-1, 29] },
      { ...config, steps: [0] },
      { ...config, captions: [' '] },
      { ...config, sentenceIds: ['unknown'] },
      { ...config, version: 2 },
      { ...config, apiKey: 'must-not-be-used' },
    ])
      expect(irodoriEvaluationSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('Irodori subprocess contract (synthetic runtime only)', () => {
  it('diagnoses a missing runtime without importing torch, loading a model or writing output', async () => {
    const f = await fixture();
    await writeFile(join(f.repo, 'torch.py'), 'raise RuntimeError("must not import")');
    const result = await python(['--repo', f.repo, '--diagnose']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ modelLoaded: false, generated: false });
    const missing = await python(['--repo', join(f.dir, 'missing'), '--diagnose']);
    expect(JSON.parse(missing.stdout).runtimeSourcePresent).toBe(false);
    await expect(readdir(f.output)).rejects.toThrow();
  });
  it('loads once, records actual requests, PCM/hash repetition, timing, assets and unreviewed status', async () => {
    const f = await fixture();
    expect(await f.run()).toMatchObject({ code: 0, stderr: '' });
    const manifest = await f.manifest();
    expect(manifest).toMatchObject({
      status: 'completed',
      phase: 'finished',
      failedSampleId: null,
      listening: { status: 'not-reviewed' },
    });
    expect(manifest.samples).toHaveLength(5);
    expect(
      manifest.samples.filter((sample: { firstAfterLoad: boolean }) => sample.firstAfterLoad),
    ).toHaveLength(1);
    expect(manifest.samples[0]).toMatchObject({
      usedSeed: 17,
      durationSeconds: 0.01,
      sampleRate: 8000,
      request: {
        values: {
          no_ref: true,
          ref_wav: null,
          num_steps: 20,
          cfg_scale_caption: 3,
          cfg_scale_speaker: 0,
        },
      },
    });
    expect(manifest.samples.at(-1).repeatHashMatches).toBe(true);
    expect(manifest.samples[0].sha256).not.toBe(manifest.samples[2].sha256);
    for (const sample of manifest.samples) {
      const wav = await readFile(join(f.output, sample.file));
      expect(wav.subarray(0, 4).toString()).toBe('RIFF');
      expect(createHash('sha256').update(wav).digest('hex')).toBe(sample.sha256);
      expect(sample.memory.processMaxRssBytes).toBeGreaterThan(0);
      expect(sample.memory.mpsAllocatedBytes).toBeNull();
      expect(sample.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(manifest.assets.checkpoint.sha256).toMatch(/^[0-9a-f]{64}$/);
    const original = await readFile(join(f.output, 'manifest.json'), 'utf8');
    expect((await f.run()).code).toBe(1);
    expect(await readFile(join(f.output, 'manifest.json'), 'utf8')).toBe(original);
  });
  it('passes reference audio only to the speaker-conditioned model', async () => {
    const f = await fixture('reference');
    expect((await f.run()).code).toBe(0);
    const manifest = await f.manifest();
    expect(manifest.samples[0].request.values).toMatchObject({
      no_ref: false,
      caption: null,
      ref_wav: f.plan.config.mode === 'reference' ? f.plan.config.referenceWav : '',
      cfg_scale_caption: 0,
      cfg_scale_speaker: 5,
    });
    expect(manifest.assets.reference.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects the wrong checkpoint family before synthesis and records the load failure', async () => {
    const f = await fixture();
    expect((await f.run({ MOCK_MODE: 'reference' })).code).toBe(1);
    expect(await f.manifest()).toMatchObject({
      status: 'failed',
      phase: 'load',
      samples: [],
      error: expect.stringContaining('一致しません'),
    });
  });
  it.each([
    ['MOCK_FAIL', 1, 'failed'],
    ['MOCK_INTERRUPT', 130, 'interrupted'],
  ])('retains successful files and the exact failed sample on %s', async (key, code, status) => {
    const f = await fixture();
    expect((await f.run({ [key]: '1' })).code).toBe(code);
    const manifest = await f.manifest();
    expect(manifest).toMatchObject({
      status,
      failedSampleId: 'sample-002',
      samples: [expect.objectContaining({ id: 'sample-001' })],
    });
    expect(await readdir(f.output)).toEqual(['manifest.json', 'runtime.log', 'sample-001.wav']);
  });
  it('records import/load errors and blocks runtime network access even when offline env was overridden', async () => {
    const f = await fixture();
    expect((await f.run({ MOCK_NETWORK: '1', HF_HUB_OFFLINE: '0' })).code).toBe(1);
    expect(await f.manifest()).toMatchObject({
      status: 'failed',
      samples: [],
      phase: 'load',
      error: expect.stringContaining('ネットワーク'),
    });
  });
  it('rejects missing assets before reserving output or loading a runtime', async () => {
    const f = await fixture();
    await rm(f.plan.config.codecPath);
    expect((await f.run()).code).toBe(1);
    await expect(readdir(f.output)).rejects.toThrow();
  });
  it('retains a diagnostic manifest when imports fail before any model can load', async () => {
    const f = await fixture();
    await writeFile(join(f.repo, 'torch.py'), 'raise ImportError("synthetic missing dependency")');
    expect((await f.run()).code).toBe(1);
    expect(await f.manifest()).toMatchObject({
      status: 'failed',
      phase: 'load',
      loadMs: null,
      samples: [],
      error: 'synthetic missing dependency',
    });
  });
  it('resolves config-relative paths in a plan without launching the specified Python or creating files', async () => {
    const f = await fixture();
    const file = join(f.dir, 'plan.json');
    await writeFile(
      file,
      JSON.stringify({ ...config, checkpoint: './model.safetensors', codecPath: './weights.pth' }),
    );
    const result = await cli(['--config', file, '--python', '/missing/python', '--plan']).result;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).config).toMatchObject({
      checkpoint: join(f.dir, 'model.safetensors'),
      codecPath: join(f.dir, 'weights.pth'),
    });
    await expect(readdir(f.output)).rejects.toThrow();
    await writeFile(file, ' '.repeat(65537));
    expect(await cli(['--config', file, '--plan']).result).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('64KiB'),
    });
    expect((await cli(['--output', f.output]).result).code).toBe(1);
  });
  it('forwards a real CLI interrupt to Python and preserves completed audio and stop position', async () => {
    const f = await fixture();
    const file = join(f.dir, 'run.json');
    await writeFile(file, JSON.stringify(f.plan.config));
    const running = cli(
      ['--repo', f.repo, '--python', 'python3', '--config', file, '--output', f.output],
      { MOCK_WAIT: '1' },
    );
    try {
      await expect
        .poll(async () => readFile(join(f.output, 'runtime.log'), 'utf8').catch(() => ''), {
          timeout: 5000,
        })
        .toContain('ready-for-interrupt');
      running.child.kill('SIGINT');
      expect((await running.result).code).toBe(130);
      expect(await f.manifest()).toMatchObject({
        status: 'interrupted',
        failedSampleId: 'sample-002',
        samples: [expect.objectContaining({ id: 'sample-001' })],
      });
    } finally {
      if (running.child.exitCode === null) running.child.kill('SIGTERM');
      await running.result;
    }
  });
});
