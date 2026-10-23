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
    join(repo, 'dacvae.py'),
    'class DACVAE:\n    @classmethod\n    def load(cls, *args): raise RuntimeError("must not load codec")\n',
  );
  await writeFile(join(repo, 'audiotools.py'), 'class AudioSignal: pass\n');
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
def resolve_runtime_device(device):
    if os.environ.get('MOCK_NETWORK'): socket.create_connection(('127.0.0.1', 1))
    if device != 'cpu': raise ValueError('synthetic device unavailable')
    return device
`,
  );
  await writeFile(
    join(repo, 'irodori_tts/config.py'),
    `from dataclasses import dataclass
@dataclass
class ModelConfig:
    use_caption_condition: bool = False
    text_tokenizer_repo: str = 'fixture-tokenizer'
    text_add_bos: bool = True
    text_vocab_size: int = 1
    @property
    def caption_tokenizer_repo_resolved(self): return self.text_tokenizer_repo
    @property
    def caption_add_bos_resolved(self): return self.text_add_bos
    @property
    def caption_vocab_size_resolved(self): return self.text_vocab_size
`,
  );
  await writeFile(
    join(repo, 'irodori_tts/tokenizer.py'),
    `from types import SimpleNamespace
import os
class PretrainedTextTokenizer:
    @classmethod
    def from_pretrained(cls, **kwargs):
        assert kwargs['local_files_only'] is True
        if os.environ.get('MOCK_TOKENIZER_MISSING'): raise ValueError('synthetic tokenizer cache missing')
        return SimpleNamespace(vocab_size=2 if os.environ.get('MOCK_VOCAB_MISMATCH') else 1)
`,
  );
  const checkpoint = join(dir, 'model.safetensors');
  const codecPath = join(dir, 'weights.pth');
  const referenceWav = join(dir, 'reference.wav');
  const header = Buffer.from(
    JSON.stringify({
      __metadata__: {
        config_json: JSON.stringify({
          use_caption_condition: mode === 'voice-design',
          text_tokenizer_repo: 'fixture-tokenizer',
          text_vocab_size: 1,
        }),
      },
      synthetic: { dtype: 'F32', shape: [1], data_offsets: [0, 4] },
    }),
  );
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64LE(BigInt(header.length));
  await Promise.all([
    writeFile(checkpoint, Buffer.concat([prefix, header, Buffer.alloc(4)])),
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
    preflight: (env = {}) =>
      python(['--repo', repo, '--output', output, '--preflight'], JSON.stringify(plan), env),
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
    expect(plan.sampling.seconds).toBe(30);
    expect(makeIrodoriPlan({ ...config, seconds: 10 }).sampling.seconds).toBe(10);
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
      { ...config, seconds: 0 },
      { ...config, seconds: 31 },
      { ...config, captions: [' '] },
      { ...config, sentenceIds: ['unknown'] },
      { ...config, version: 2 },
      { ...config, apiKey: 'must-not-be-used' },
    ])
      expect(irodoriEvaluationSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('read-only Irodori preflight', () => {
  it('checks metadata, dependencies, device, cached tokenizers and capacity without loading weights or creating output', async () => {
    const f = await fixture();
    const before = await readdir(f.dir);
    const result = await f.preflight({ MOCK_LOAD_ERROR: 'must not load model' });
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      status: 'passed',
      modelLoaded: false,
      generated: false,
      plannedSamples: 5,
    });
    expect(report.checks.every((check: { status: string }) => check.status === 'passed')).toBe(
      true,
    );
    expect(
      report.checks
        .find((check: { name: string }) => check.name === 'cached-tokenizers')
        .detail.map((item: { kind: string }) => item.kind),
    ).toEqual(['text', 'caption']);
    expect(await readdir(f.dir)).toEqual(before);
    await expect(readdir(f.output)).rejects.toThrow();
  });
  it('reports missing model, codec, runtime and output conflict together', async () => {
    const f = await fixture();
    await Promise.all([
      rm(f.plan.config.checkpoint),
      rm(f.plan.config.codecPath),
      rm(join(f.repo, 'irodori_tts/inference_runtime.py')),
      mkdir(f.output),
    ]);
    const result = await f.preflight();
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(
      report.checks
        .filter((check: { status: string }) => check.status === 'blocked')
        .map((check: { name: string }) => check.name),
    ).toEqual(
      expect.arrayContaining([
        'checkpoint',
        'codec',
        'runtime-source',
        'output',
        'runtime-import-and-device',
      ]),
    );
    expect(await readdir(f.output)).toEqual([]);
  });
  it.each(['MOCK_TOKENIZER_MISSING', 'MOCK_VOCAB_MISMATCH'])(
    'refuses a missing/incompatible offline tokenizer: %s',
    async (key) => {
      const f = await fixture('reference');
      const result = await f.preflight({ [key]: '1' });
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).checks).toContainEqual(
        expect.objectContaining({ name: 'cached-tokenizers', status: 'blocked' }),
      );
      await expect(readdir(f.output)).rejects.toThrow();
    },
  );
  it('reports a wrong checkpoint mode, unavailable device and blocked networking without synthesizing', async () => {
    const f = await fixture();
    const { captions: _captions, ...common } = config;
    f.plan.config = irodoriEvaluationSchema.parse({
      ...common,
      checkpoint: f.plan.config.checkpoint,
      codecPath: f.plan.config.codecPath,
      mode: 'reference',
      referenceWav: join(f.dir, 'reference.wav'),
      device: 'mps',
    });
    const result = await f.preflight();
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'checkpoint-mode', status: 'blocked' }),
        expect.objectContaining({ name: 'runtime-import-and-device', status: 'blocked' }),
      ]),
    );
    const network = await f.preflight({ MOCK_NETWORK: '1' });
    expect(JSON.parse(network.stdout).checks).toContainEqual(
      expect.objectContaining({
        name: 'runtime-import-and-device',
        status: 'blocked',
        detail: expect.stringContaining('ネットワーク'),
      }),
    );
  });
  it('bounds metadata reads and treats unsupported metadata as incomplete, not ready', async () => {
    const f = await fixture();
    const prefix = Buffer.alloc(8);
    prefix.writeBigUInt64LE(BigInt(1024 * 1024 + 1));
    await writeFile(f.plan.config.checkpoint, prefix);
    const result = await f.preflight();
    expect(JSON.parse(result.stdout).checks).toContainEqual(
      expect.objectContaining({
        name: 'checkpoint-metadata',
        status: 'blocked',
        detail: expect.stringContaining('1MiB'),
      }),
    );
    const old = join(f.dir, 'model.pt');
    await writeFile(old, 'synthetic unsupported checkpoint');
    f.plan.config.checkpoint = old;
    const unsupported = await f.preflight();
    expect(unsupported.code).toBe(1);
    expect(JSON.parse(unsupported.stdout).status).toBe('incomplete');
  });
  it('reports missing codec dependencies without loading codec weights', async () => {
    const f = await fixture('reference');
    await writeFile(
      join(f.repo, 'audiotools.py'),
      'raise ImportError("synthetic reference normalization dependency missing")',
    );
    const result = await f.preflight();
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).checks).toContainEqual(
      expect.objectContaining({
        name: 'codec-import',
        status: 'blocked',
        detail: expect.stringContaining('normalization dependency missing'),
      }),
    );
    await expect(readdir(f.output)).rejects.toThrow();
  });
  it('checks the actual output filesystem and blocks low space before creating any output or loading weights', async () => {
    const f = await fixture();
    const script = `import sys, importlib
from unittest.mock import patch
from types import SimpleNamespace
sys.path.insert(0, ${JSON.stringify(resolve('server'))})
bridge = importlib.import_module('irodori-evaluate')
sys.argv = ['bridge', '--repo', ${JSON.stringify(f.repo)}, '--output', ${JSON.stringify(f.output)}, '--preflight']
with patch('irodori_preflight.shutil.disk_usage', return_value=SimpleNamespace(free=1)):
    bridge.main()
`;
    const result = await start('python3', ['-c', script], JSON.stringify(f.plan)).result;
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).checks).toContainEqual(
      expect.objectContaining({
        name: 'output',
        status: 'blocked',
        detail: expect.stringContaining('空き容量'),
      }),
    );
    const generation = script.replace(", '--preflight'", '');
    const failed = await start('python3', ['-c', generation], JSON.stringify(f.plan), {
      MOCK_LOAD_ERROR: 'must not load',
    }).result;
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('空き容量');
    expect(failed.stderr).not.toContain('synthetic load failure');
    await expect(readdir(f.output)).rejects.toThrow();
  });
  it('validates CLI preflight arguments and executes only preflight for a valid config', async () => {
    const f = await fixture();
    const file = join(f.dir, 'preflight.json');
    await writeFile(file, JSON.stringify(f.plan.config));
    const result = await cli(
      [
        '--repo',
        f.repo,
        '--python',
        'python3',
        '--config',
        file,
        '--output',
        f.output,
        '--preflight',
      ],
      { MOCK_LOAD_ERROR: 'must not load' },
    ).result;
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).status).toBe('passed');
    expect((await cli(['--preflight']).result).code).toBe(1);
    expect((await cli(['--preflight', '--config', file]).result).code).toBe(1);
    expect((await cli(['--preflight', '--config', file, '--plan']).result).code).toBe(1);
    await expect(readdir(f.output)).rejects.toThrow();
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
  it('inspects a stopped run and recovers it without changing saved audio or inventing a finish time', async () => {
    const f = await fixture();
    expect((await f.run()).code).toBe(0);
    const manifest = await f.manifest();
    manifest.status = 'running';
    manifest.phase = 'generate';
    manifest.failedSampleId = 'sample-002';
    manifest.finishedAt = null;
    manifest.runnerPid = 99999999;
    await writeFile(join(f.output, 'manifest.json'), JSON.stringify(manifest));
    const wav = await readFile(join(f.output, 'sample-001.wav'));
    const inspected = await cli(['--inspect-run', f.output, '--python', 'python3']).result;
    expect(inspected.code).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      status: 'running',
      runnerActive: false,
      recoverable: true,
      issues: [],
    });
    expect(
      (await readdir(f.output)).some((name) => name.startsWith('manifest.before-recovery-')),
    ).toBe(false);
    const recovered = await cli(['--recover-run', f.output, '--python', 'python3']).result;
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({ status: 'interrupted', savedSamples: 5 });
    expect(await f.manifest()).toMatchObject({
      status: 'interrupted',
      phase: 'generate',
      failedSampleId: 'sample-002',
      finishedAt: null,
      recovery: { reason: 'runner-not-active' },
    });
    const backup = (await readdir(f.output)).find((name) =>
      name.startsWith('manifest.before-recovery-'),
    )!;
    expect(JSON.parse(await readFile(join(f.output, backup), 'utf8'))).toEqual(manifest);
    expect(await readFile(join(f.output, 'sample-001.wav'))).toEqual(wav);
    expect((await cli(['--recover-run', f.output, '--python', 'python3']).result).code).toBe(1);
  });
  it('refuses recovery while a runner is alive or the recorded audio differs', async () => {
    const f = await fixture();
    expect((await f.run()).code).toBe(0);
    const manifest = await f.manifest();
    manifest.status = 'running';
    manifest.runnerPid = process.pid;
    await writeFile(join(f.output, 'manifest.json'), JSON.stringify(manifest));
    expect((await cli(['--recover-run', f.output, '--python', 'python3']).result).code).toBe(1);
    manifest.runnerPid = 99999999;
    await writeFile(join(f.output, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(f.output, 'sample-001.wav'), 'damaged');
    const inspected = await cli(['--inspect-run', f.output, '--python', 'python3']).result;
    expect(JSON.parse(inspected.stdout).issues).toEqual([
      expect.stringContaining('sample-001.wav'),
    ]);
    expect((await cli(['--recover-run', f.output, '--python', 'python3']).result).code).toBe(1);
    expect(
      (await readdir(f.output)).some((name) => name.startsWith('manifest.before-recovery-')),
    ).toBe(false);
  });
  it('requires an explicit override for an old run without a recorded PID', async () => {
    const f = await fixture();
    expect((await f.run()).code).toBe(0);
    const manifest = await f.manifest();
    manifest.status = 'running';
    delete manifest.runnerPid;
    await writeFile(join(f.output, 'manifest.json'), JSON.stringify(manifest));
    expect((await cli(['--recover-run', f.output, '--python', 'python3']).result).code).toBe(1);
    const recovered = await cli([
      '--recover-run',
      f.output,
      '--allow-legacy-run',
      '--python',
      'python3',
    ]).result;
    expect(recovered.code).toBe(0);
    expect((await f.manifest()).recovery.reason).toBe('legacy-run-manually-confirmed');
  });
});
