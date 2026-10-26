import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createElevenLabsClient } from '../server/tts/elevenlabs';
import { createApp } from '../server/app';
import type { Config } from '../server/config';
import { elevenLabsRecipeSchema } from '../shared/elevenlabs';
import { castingSessionSchema, castingEvaluationSchema, castingKey } from '../shared/casting';
import {
  castingEvaluationsCsv,
  filterCastingEvaluations,
  defaultCastingFilters,
  makeCastingDataset,
  parseCastingEvaluationFile,
} from '../shared/casting-dataset';
import { makeCastingEvaluation, makeCastingSession } from './fixtures/casting';
import { makeLibraryEntry, serializeLibrary, parseLibrary } from '../shared/voice-library';
import { libraryRecipeDifferences } from '../shared/library-comparison';
import { makeEmptyProject, validateProject } from '../shared/project';
import { readPcmWav } from '../shared/wav';

const key = 'elevenlabs-secret-test-key';
const recipe = elevenLabsRecipeSchema.parse({ engine: 'ElevenLabs', modelId: 'test-ja', seed: 42 });
const candidate = {
  voice: {
    engine: 'ElevenLabs' as const,
    voiceId: 'test_voice',
    name: '日本語の声',
    style: 'default',
  },
  recipe,
};
const upstreamModel = {
  model_id: 'test-ja',
  name: '日本語モデル',
  can_do_text_to_speech: true,
  can_use_style: true,
  can_use_speaker_boost: true,
  maximum_text_length_per_request: 300,
  languages: [{ language_id: 'ja', name: 'Japanese' }],
};
const pcm = Buffer.alloc(440, 0x12);
const audio = (body: Buffer = pcm, mime = 'application/octet-stream') =>
  new Response(new Uint8Array(body), { headers: { 'Content-Type': mime } });
const input = { voiceId: candidate.voice.voiceId, text: 'こんにちは。', recipe };
const mockFetch = () =>
  vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/v1/models') ? Response.json([upstreamModel]) : audio(),
  );

afterEach(() => vi.useRealTimers());

describe('ElevenLabs transport and synthesis', () => {
  it('never contacts ElevenLabs without a server key', async () => {
    const fetcher = mockFetch();
    const client = createElevenLabsClient('', fetcher);
    expect(await client.status()).toMatchObject({
      ready: false,
      detail: expect.stringContaining('未設定'),
    });
    await expect(client.listModels()).rejects.toThrow('APIキー');
    await expect(client.listVoices('', null)).rejects.toThrow('APIキー');
    await expect(client.synthesize(input)).rejects.toThrow('APIキー');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('coalesces metadata requests, expires its cache, and filters non-TTS models', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json([upstreamModel, { model_id: 'conversion', can_do_text_to_speech: false }]),
    );
    const client = createElevenLabsClient(key, fetcher);
    const [models, status] = await Promise.all([
      client.listModels(),
      client.status(),
      client.listModels(),
    ]);
    expect(models).toHaveLength(1);
    expect(status.ready).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 30_001);
    await client.listModels();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('sends only native settings to the fixed host and wraps 16-bit mono PCM in WAV', async () => {
    const fetcher = mockFetch();
    const result = await createElevenLabsClient(key, fetcher).synthesize(input);
    expect(result.wav.subarray(44)).toEqual(pcm);
    expect(result.wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(result.wav.readUInt16LE(22)).toBe(1);
    expect(result.wav.readUInt32LE(24)).toBe(22050);
    expect(result.wav.readUInt16LE(34)).toBe(16);
    expect(readPcmWav(result.wav)).toMatchObject({
      sampleRate: 22050,
      channels: 1,
      frames: pcm.length / 2,
    });
    expect(result.generation).toEqual({ modelId: 'test-ja', outputFormat: 'pcm_22050', seed: 42 });
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe('https://api.elevenlabs.io');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get('xi-api-key')).toBe(key);
    }
    const [url, init] = fetcher.mock.calls[1];
    expect(String(url)).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/test_voice?output_format=pcm_22050',
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      text: input.text,
      model_id: 'test-ja',
      seed: 42,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0,
        use_speaker_boost: false,
      },
    });
    expect(JSON.stringify(result.generation)).not.toContain(key);
  });
  it.each([
    { recipe: { ...recipe, modelId: 'unknown' } },
    { text: 'あ'.repeat(301) },
    { recipe: { ...recipe, speedScale: 1 } },
    { voiceId: '..' },
    { voiceId: 'voice?secret=1' },
  ])('rejects invalid identities or recipes before the charged POST: %j', async (override) => {
    const fetcher = mockFetch();
    await expect(
      createElevenLabsClient(key, fetcher).synthesize({ ...input, ...override }),
    ).rejects.toThrow();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it('checks model limits and unsupported style/boost before generation', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json([
        {
          ...upstreamModel,
          maximum_text_length_per_request: 3,
          can_use_style: false,
          can_use_speaker_boost: false,
        },
      ]),
    );
    const client = createElevenLabsClient(key, fetcher);
    await expect(client.synthesize(input)).rejects.toThrow('文字数');
    await expect(
      client.synthesize({ ...input, text: 'あ', recipe: { ...recipe, style: 0.2 } }),
    ).rejects.toThrow('対応していない');
    await expect(
      client.synthesize({ ...input, text: 'あ', recipe: { ...recipe, useSpeakerBoost: true } }),
    ).rejects.toThrow('対応していない');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    [401, '認証'],
    [403, '利用権限'],
    [404, '声またはモデル'],
    [422, '入力'],
    [429, '利用枠'],
    [500, '自動再試行'],
  ])('maps HTTP %s without exposing upstream bodies or retrying', async (status, message) => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/v1/models')
        ? Response.json([upstreamModel])
        : Response.json({ error: `${key}:${input.text}` }, { status }),
    );
    const client = createElevenLabsClient(key, fetcher);
    await expect(client.synthesize(input)).rejects.toThrow(message);
    expect(fetcher).toHaveBeenCalledTimes(2);
    try {
      await client.synthesize(input);
    } catch (error) {
      expect(String(error)).not.toContain(key);
      expect(String(error)).not.toContain(input.text);
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    [Buffer.alloc(0), 'audio/pcm'],
    [Buffer.alloc(3), 'audio/pcm'],
    [Buffer.from('ID3mp3data'), 'application/octet-stream'],
    [Buffer.from('<!DOCTYPE html>invalid'), 'application/octet-stream'],
    [Buffer.alloc(4), 'audio/mpeg'],
    [Buffer.alloc(4), 'text/html'],
  ])('rejects malformed or mislabeled audio (%s, %s)', async (bytes, mime) => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith('/v1/models') ? Response.json([upstreamModel]) : audio(bytes, mime),
    );
    await expect(createElevenLabsClient(key, fetcher).synthesize(input)).rejects.toThrow();
  });
  it('rejects oversized bodies and transport failures without exposing the exception', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/v1/models')) return Response.json([upstreamModel]);
      return new Response(new Uint8Array(pcm), {
        headers: { 'content-type': 'audio/pcm', 'content-length': String(21 * 1024 * 1024) },
      });
    });
    await expect(createElevenLabsClient(key, fetcher).synthesize(input)).rejects.toThrow(
      'サイズ上限',
    );
    fetcher.mockRejectedValue(new Error(`${key} timeout`));
    const status = await createElevenLabsClient(key, fetcher).status();
    expect(status.ready).toBe(false);
    expect(status.detail).toContain('応答を取得できません');
    expect(status.detail).not.toContain(key);
  });
});

describe('voice search and opaque pagination', () => {
  it('deduplicates voices and preserves extra default voices before advancing upstream', async () => {
    const many = Array.from({ length: 55 }, (_, index) => ({
      voice_id: `v_${index}`,
      name: `声${index}`,
      category: null,
    }));
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      new URL(String(url)).searchParams.has('next_page_token')
        ? Response.json({ voices: [{ voice_id: 'last', name: '最後' }], has_more: false })
        : Response.json({
            voices: [...many, many[0]],
            has_more: true,
            next_page_token: 'private-upstream-token',
          }),
    );
    const client = createElevenLabsClient(key, fetcher);
    const first = await client.listVoices('日本語 & soft', null);
    expect(first.voices).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(JSON.stringify(first)).not.toContain('private-upstream-token');
    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get('search')).toBe(
      '日本語 & soft',
    );
    const second = await client.listVoices('日本語 & soft', first.nextCursor);
    expect(second.voices).toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const third = await client.listVoices('日本語 & soft', second.nextCursor);
    expect(third.voices[0].voiceId).toBe('last');
    expect(third.nextCursor).toBeNull();
    expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get('next_page_token')).toBe(
      'private-upstream-token',
    );
    await expect(client.listVoices('別の検索', first.nextCursor)).rejects.toThrow('ページ情報');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects missing/repeated continuation tokens and does not cache failed searches', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ voices: [], has_more: true, next_page_token: null }),
    );
    const client = createElevenLabsClient(key, fetcher);
    await expect(client.listVoices('', null)).rejects.toThrow('ページ情報');
    fetcher.mockResolvedValue(Response.json({ voices: [], has_more: false }));
    expect(await client.listVoices('', null)).toMatchObject({
      voices: [],
      hasMore: false,
      nextCursor: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('ElevenLabs saved comparisons', () => {
  it('round trips native settings through sessions, evaluation datasets, library and projects', () => {
    const old = makeCastingEvaluation();
    const evaluation = castingEvaluationSchema.parse({
      ...old,
      candidates: [candidate, old.candidates[1]],
      generations: [
        {
          engine: 'ElevenLabs',
          engineVersion: null,
          checkedAt: old.recordedAt,
          modelId: recipe.modelId,
          outputFormat: recipe.outputFormat,
          seed: recipe.seed,
        },
        null,
      ],
    });
    const session = castingSessionSchema.parse(makeCastingSession([evaluation]));
    expect(session.candidates[0]).toEqual(candidate);
    expect(parseCastingEvaluationFile(makeCastingDataset([evaluation]))).toEqual([evaluation]);
    const library = [makeLibraryEntry(evaluation, '案内役', '通常', '')];
    expect(parseLibrary(serializeLibrary(library))).toEqual(library);
    const project = makeEmptyProject('クラウド比較');
    project.documents.casting = { session, outcome: 'a', reason: '日本語が自然' };
    expect(
      validateProject(JSON.parse(JSON.stringify(project))).documents.casting?.session.candidates[0],
    ).toEqual(candidate);
    expect(
      filterCastingEvaluations([evaluation], {
        ...defaultCastingFilters,
        engine: 'ElevenLabs',
        query: 'test-ja',
      }),
    ).toHaveLength(1);
    const csv = castingEvaluationsCsv([evaluation]);
    expect(csv).toContain('a_elevenlabs_model_id');
    expect(csv).toContain('"test_voice"');
    expect(csv).toContain('"test-ja"');
    expect(csv).not.toContain('undefined');
    expect(JSON.stringify(project)).not.toContain(key);
    expect(castingKey(candidate.voice)).toContain('test_voice');
    const other = makeLibraryEntry({ ...evaluation, reason: '別案' }, '案内役', '安定', '');
    other.evaluation.candidates[0].recipe = { ...recipe, stability: 1 };
    expect(libraryRecipeDifferences([library[0], other])).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'stability', delta: 0.5 })]),
    );
  });
});

const config: Config = {
  port: 3210,
  ollamaUrl: 'http://127.0.0.1:1',
  ollamaModel: 'test',
  openaiKey: '',
  openaiModel: 'test',
  anthropicKey: '',
  anthropicModel: 'test',
  geminiKey: '',
  geminiModel: 'test',
  deepseekKey: '',
  deepseekModel: 'test',
  voicevoxUrl: 'http://127.0.0.1:1',
  elevenLabsApiKey: key,
};
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
async function serve(fetcher: typeof fetch, overrides: Partial<Config> = {}) {
  const server = await new Promise<Server>((resolve) => {
    const server = createApp({ ...config, ...overrides }, fetcher).listen(0, '127.0.0.1', () =>
      resolve(server),
    );
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function preview(base: string) {
  return fetch(`${base}/api/casting/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidate, text: input.text }),
  });
}

describe('ElevenLabs local API', () => {
  it('returns unconfigured metadata without an external request', async () => {
    const fetcher = mockFetch();
    const base = await serve(fetcher, { elevenLabsApiKey: '' });
    const response = await fetch(`${base}/api/casting/elevenlabs/models`);
    expect(await response.json()).toMatchObject({
      ready: false,
      detail: expect.stringContaining('APIキー'),
      models: [],
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const voices = await fetch(`${base}/api/casting/elevenlabs/voices`);
    expect(voices.status).toBe(503);
    const audio = await preview(base);
    expect(audio.status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps cloud failures separate from the local engine inventory', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      String(url).startsWith('https://api.elevenlabs.io')
        ? Response.json({ secret: key }, { status: 403 })
        : Response.json([]),
    );
    const base = await serve(fetcher);
    const body = await (await fetch(`${base}/api/casting/voices`)).json();
    expect(body.engines).toMatchObject([
      { engine: 'VOICEVOX', ready: true },
      { engine: 'AivisSpeech', ready: true },
      { engine: 'ElevenLabs', ready: false, detail: expect.stringContaining('利用権限') },
    ]);
    expect(JSON.stringify(body)).not.toContain(key);
  });
  it('validates query strings locally and shares pending model reads', async () => {
    const fetcher = mockFetch();
    const base = await serve(fetcher);
    expect((await fetch(`${base}/api/casting/elevenlabs/voices?cursor=invalid`)).status).toBe(400);
    expect(
      (await fetch(`${base}/api/casting/elevenlabs/voices?search=${'a'.repeat(101)}`)).status,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const results = await Promise.all([
      fetch(`${base}/api/casting/elevenlabs/models`),
      fetch(`${base}/api/casting/elevenlabs/models`),
    ]);
    expect(await results[0].json()).toMatchObject({
      ready: true,
      models: [{ modelId: 'test-ja' }],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await preview(base)).headers.get('content-type')).toContain('audio/wav');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects duplicate cloud generation while allowing local work and releases the lock on failure', async () => {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/v1/models')) return Response.json([upstreamModel]);
      if (String(url).startsWith('https://api.elevenlabs.io') && init?.method === 'POST') {
        entered();
        await blocked;
        return Response.json({ error: key }, { status: 500 });
      }
      return Response.json([]);
    });
    const base = await serve(fetcher);
    const pending = preview(base);
    await started;
    try {
      expect((await preview(base)).status).toBe(429);
      const localCandidate = makeCastingEvaluation().candidates[1];
      const local = await fetch(`${base}/api/casting/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ candidate: localCandidate, text: input.text }),
      });
      expect(local.status).not.toBe(429);
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    } finally {
      release();
    }
    const failed = await pending;
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(key);
    const retry = await preview(base);
    expect(retry.status).toBe(502);
    expect(
      fetcher.mock.calls.filter(
        ([url, init]) =>
          String(url).startsWith('https://api.elevenlabs.io') && init?.method === 'POST',
      ),
    ).toHaveLength(2);
  });
});
