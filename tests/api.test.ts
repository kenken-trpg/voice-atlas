import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { createApp } from '../server/app';
import { createTtsAdapter } from '../server/tts';
import type { Config } from '../server/config';
import { makeRecipe } from '../shared/recommend';
import { voices } from '../shared/catalog';
import { neutralProfile } from '../shared/schema';
import { analyzeCharacter, capabilities, sanitizeImage } from '../server/services';

const config: Config = {
  port: 3210,
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'test-local-vision',
  openaiKey: 'test-key-not-real',
  openaiModel: 'test-vision',
  anthropicKey: 'test-anthropic-key-not-real',
  anthropicModel: 'test-claude-vision',
  geminiKey: 'test-gemini-key-not-real',
  geminiModel: 'test-gemini-vision',
  voicevoxUrl: 'http://127.0.0.1:50021',
};
const mockFetch = vi.fn<typeof fetch>();
const analysis = {
  subjectFound: true,
  summary: '落ち着いた案内役という演出案です。',
  cues: ['落ち着いた配色'],
  delivery: '丁寧な語り口で。',
  profile: neutralProfile,
};
const json = (data: unknown, status = 200) => Response.json(data, { status });
let server: Server, base: string, image: string;
beforeAll(async () => {
  image =
    'data:image/png;base64,' +
    (
      await sharp({ create: { width: 48, height: 64, channels: 3, background: '#95b6a7' } })
        .png()
        .toBuffer()
    ).toString('base64');
  server = await new Promise<Server>((resolve) => {
    const s = createApp(config, mockFetch).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  mockFetch.mockReset();
});
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
describe('local API boundaries', () => {
  it('serves health and keeps the API key out of capabilities', async () => {
    mockFetch.mockImplementation(async (url) =>
      String(url).endsWith('/api/show') ? json({ capabilities: ['vision'] }) : json([]),
    );
    expect((await fetch(base + '/api/health')).status).toBe(200);
    const response = await fetch(base + '/api/capabilities');
    const body = await response.json();
    expect(body.ollama.ready).toBe(true);
    expect(body.openai.ready).toBe(true);
    expect(body.anthropic).toEqual({ ready: true, model: config.anthropicModel });
    expect(body.gemini).toEqual({ ready: true, model: config.geminiModel });
    expect(JSON.stringify(body)).not.toContain(config.geminiKey);
    expect(JSON.stringify(body)).not.toContain(config.anthropicKey);
    expect(JSON.stringify(body)).not.toContain(config.openaiKey);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await fetch(base + '/API/health')).headers.get('cache-control')).toBe('no-store');
    expect((await fetch(base + '/API/analyze', { method: 'POST', body: '{}' })).status).toBe(415);
  });
  it('handles absent services without claiming successful analysis', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const body = await (await fetch(base + '/api/capabilities')).json();
    expect(body.ollama.ready).toBe(false);
    expect(body.voicevox.ready).toBe(false);
    expect(body.voicevox.availableVoiceIds).toEqual([]);
  });
  it('preflights exact talk styles from one inventory request without synthesizing', async () => {
    mockFetch.mockImplementation(async (url) =>
      String(url).endsWith('/api/show')
        ? json({ capabilities: ['vision'] })
        : json([
            {
              name: '四国めたん',
              speaker_uuid: 'metan',
              styles: [
                { name: 'ノーマル', id: 9000, type: 'talk' },
                { name: 'ささやき', id: 9001, type: 'sing' },
                { name: 'あまあま', id: 9002 },
              ],
            },
            {
              name: '青山龍星',
              speaker_uuid: 'ryusei',
              styles: [{ name: '囁き', id: 9010, type: 'talk' }],
            },
            {
              name: '未収録の話者',
              speaker_uuid: 'unknown',
              styles: [{ name: 'ノーマル', id: 9020 }],
            },
          ]),
    );
    const body = await (await fetch(base + '/api/capabilities')).json();
    expect(body.voicevox).toMatchObject({
      ready: true,
      availableVoiceIds: ['vv-metan', 'vv-metan-sweet', 'vv-ryusei-whisper'],
    });
    expect(Number.isFinite(Date.parse(body.voicevox.checkedAt))).toBe(true);
    expect(JSON.stringify(body)).not.toContain('未収録の話者');
    expect(
      mockFetch.mock.calls.map(([url]) => String(url)).filter((url) => url.endsWith('/speakers')),
    ).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // A singing style with a matching display name must fail before audio_query too.
    const voice = voices.find((item) => item.id === 'vv-metan-whisper')!;
    const response = await post('/api/preview', {
      voiceId: voice.id,
      text: 'テスト',
      recipe: makeRecipe(neutralProfile, voice),
    });
    expect(response.status).toBe(409);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
  it('distinguishes an empty connected engine from a failed inventory and refreshes installed styles', async () => {
    mockFetch.mockImplementation(async () => json([]));
    let body = await (await fetch(base + '/api/capabilities')).json();
    expect(body.voicevox).toMatchObject({ ready: true, availableVoiceIds: [] });
    mockFetch.mockImplementation(async () =>
      json([{ name: '青山龍星', speaker_uuid: 'ryusei', styles: [{ name: 'ノーマル', id: 1 }] }]),
    );
    body = await (await fetch(base + '/api/capabilities')).json();
    expect(body.voicevox).toMatchObject({ ready: true, availableVoiceIds: ['vv-ryusei'] });
    mockFetch.mockImplementation(async () => json([{ name: '青山龍星', styles: 'broken' }]));
    body = await (await fetch(base + '/api/capabilities')).json();
    expect(body.voicevox).toMatchObject({ ready: false, availableVoiceIds: [] });
    mockFetch.mockRejectedValue(new Error('offline'));
    body = await (await fetch(base + '/api/capabilities')).json();
    expect(body.voicevox).toMatchObject({ ready: false, availableVoiceIds: [] });
  });
  it('protects document routes as well as API routes', async () => {
    for (const path of ['/', '/assets/test.js', '/api/health']) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(base + path, { headers: { Host: 'attacker.example' } }, (response) => {
          response.resume();
          resolve(response.statusCode);
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(403);
      expect(
        (await fetch(base + path, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status,
      ).toBe(403);
    }
    const response = await fetch(base + '/api/health');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
  it('rejects large non-image bodies and compressed input before service calls', async () => {
    for (const path of ['/api/recommend', '/api/preview']) {
      const response = await post(path, { text: 'x'.repeat(17 * 1024) });
      expect(response.status).toBe(413);
    }
    const compressed = await fetch(base + '/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: gzipSync('{}'),
    });
    expect(compressed.status).toBe(415);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('shares pending capability checks and refreshes after completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockFetch.mockImplementation(async (url) => {
      await gate;
      return String(url).endsWith('/api/show') ? json({ capabilities: ['vision'] }) : json([]);
    });
    const first = fetch(base + '/api/capabilities');
    const second = fetch(base + '/api/capabilities');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    // A health response confirms both queued capability requests reached the server.
    await fetch(base + '/api/health');
    release();
    const responses = await Promise.all([first, second]);
    expect(await responses[0].json()).toEqual(await responses[1].json());
    expect(mockFetch).toHaveBeenCalledTimes(2);
    mockFetch.mockRejectedValue(new Error('offline'));
    const refreshed = await (await fetch(base + '/api/capabilities')).json();
    expect(refreshed.ollama.ready).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
  it('rejects requests from other websites before calling services', async () => {
    expect((await post('/api/analyze', {}, { Origin: 'https://untrusted.example' })).status).toBe(
      403,
    );
    expect((await post('/api/analyze', {}, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('rejects invalid input and returns JSON for invalid JSON and routes', async () => {
    expect(
      (
        await post('/api/recommend', {
          profile: { ...neutralProfile, pitch: 999 },
          preferences: {},
        })
      ).status,
    ).toBe(400);
    const malformed = await fetch(base + '/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken',
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBeTruthy();
    expect((await fetch(base + '/api/unknown')).status).toBe(404);
  });
  it('requires consent before any OpenAI call', async () => {
    const response = await post('/api/analyze', { provider: 'openai', image, consent: false });
    expect(response.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('rejects forged or oversized images without contacting the model', async () => {
    for (const badImage of [
      'data:image/png;base64,SGVsbG8=',
      'data:image/svg+xml;base64,PHN2Zy8+',
    ]) {
      expect((await post('/api/analyze', { provider: 'ollama', image: badImage })).status).toBe(
        400,
      );
    }
    await expect(
      sanitizeImage(
        'data:image/png;base64,' + Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'),
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('returns curated recommendations without making AI requests', async () => {
    const response = await post('/api/recommend', {
      profile: neutralProfile,
      preferences: { budget: 'free', engine: 'VOICEVOX' },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.recommendations).toHaveLength(20);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
describe('vision provider contracts (mocked, no paid requests)', () => {
  it.each(['ollama', 'openai', 'anthropic', 'gemini'] as const)(
    'creates a text-only direction via %s without any image payload',
    async (provider) => {
      const textAnalysis = {
        ...analysis,
        cues: ['旅人を案内する司書'],
        summary: '作者の設定から穏やかな司書という演出案です。',
      };
      const envelope =
        provider === 'ollama'
          ? { message: { content: JSON.stringify(textAnalysis) } }
          : provider === 'openai'
            ? {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    content: [{ type: 'output_text', text: JSON.stringify(textAnalysis) }],
                  },
                ],
              }
            : provider === 'anthropic'
              ? {
                  type: 'message',
                  stop_reason: 'end_turn',
                  content: [{ type: 'text', text: JSON.stringify(textAnalysis) }],
                }
              : {
                  candidates: [
                    {
                      finishReason: 'STOP',
                      content: { parts: [{ text: JSON.stringify(textAnalysis) }] },
                    },
                  ],
                };
      mockFetch.mockImplementation(async () => json(envelope));
      const response = await post('/api/analyze', {
        provider,
        inputMode: 'text',
        characterText: '旅人を案内する司書。穏やかだが芯が強い。',
        direction: '低めの声でゆっくり。',
        consent: provider !== 'ollama',
      });
      expect(response.status).toBe(200);
      expect((await response.json()).analysis).toEqual(textAnalysis);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
      const encoded = JSON.stringify(payload);
      expect(encoded).toContain('旅人を案内する司書');
      expect(encoded).toContain('低めの声でゆっくり');
      expect(encoded).toContain('画像は提供されていません');
      expect(encoded).toContain('作者が書いた設定のみ');
      for (const marker of [
        '"images"',
        '"input_image"',
        '"inlineData"',
        '"base64"',
        '"image_url"',
        '"source"',
      ])
        expect(encoded).not.toContain(marker);
      if (provider === 'openai') {
        expect(payload.input[0].content).toHaveLength(1);
        expect(payload.input[0].content[0].type).toBe('input_text');
        expect(payload.store).toBe(false);
        expect(payload.text.format.strict).toBe(true);
      }
    },
  );
  it('rejects empty text, unexpected images and oversized settings before model calls', async () => {
    for (const input of [
      { inputMode: 'text', characterText: '   ' },
      { inputMode: 'text', characterText: '司書', image },
      { inputMode: 'text', characterText: 'a'.repeat(2001) },
      { inputMode: 'image', characterText: '司書' },
      { inputMode: 'unknown', characterText: '司書' },
    ])
      expect((await post('/api/analyze', { provider: 'ollama', ...input })).status).toBe(400);
    for (const provider of ['openai', 'anthropic', 'gemini']) {
      const response = await post('/api/analyze', {
        provider,
        inputMode: 'text',
        characterText: '司書',
        consent: false,
      });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('キャラクター設定と補足');
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('prioritizes author settings when an image is also supplied', async () => {
    mockFetch.mockImplementation(async () =>
      json({ message: { content: JSON.stringify(analysis) } }),
    );
    const response = await post('/api/analyze', {
      provider: 'ollama',
      image,
      characterText: '見た目より落ち着いた声。',
      direction: '設定を優先。',
    });
    expect(response.status).toBe(200);
    const sent = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(sent.messages[0].content).toContain('作者の意図を優先');
    expect(sent.messages[1].content).toContain('見た目より落ち着いた声');
    expect(sent.messages[1].images).toHaveLength(1);
  });
  it('allows a local text-capable Ollama model without claiming image support', async () => {
    mockFetch.mockImplementation(async (url) =>
      String(url).endsWith('/api/show') ? json({ capabilities: ['completion'] }) : json([]),
    );
    expect((await capabilities(config, mockFetch)).ollama).toMatchObject({
      ready: false,
      textReady: true,
    });
    expect(
      (await capabilities({ ...config, ollamaModel: 'example-cloud' }, mockFetch)).ollama,
    ).toMatchObject({ ready: false, textReady: false });
  });
  it('sends re-encoded JPEG and schema to local Ollama', async () => {
    mockFetch.mockResolvedValue(json({ message: { content: JSON.stringify(analysis) } }));
    const response = await post('/api/analyze', {
      provider: 'ollama',
      image,
      direction: '静かな声',
    });
    expect(response.status).toBe(200);
    expect((await response.json()).analysis.summary).toBe(analysis.summary);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(config.ollamaUrl + '/api/chat');
    const sent = JSON.parse(String(init?.body));
    expect(sent.stream).toBe(false);
    expect(sent.format.type).toBe('object');
    const meta = await sharp(Buffer.from(sent.messages[1].images[0], 'base64')).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(init?.redirect).toBe('error');
  });
  it('uses Responses structured output, suppresses storage, and extracts text blocks', async () => {
    mockFetch.mockResolvedValue(
      json({
        status: 'completed',
        output: [
          { type: 'reasoning' },
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(analysis) }] },
        ],
      }),
    );
    const response = await post('/api/analyze', { provider: 'openai', image, consent: true });
    expect(response.status).toBe(200);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    const sent = JSON.parse(String(init?.body));
    expect(sent.store).toBe(false);
    expect(sent.text.format.strict).toBe(true);
    expect(sent.input[0].content[1].image_url).toMatch(/^data:image\/jpeg;base64,/);
  });
  it('does not invent a result when the model returns malformed output', async () => {
    mockFetch.mockResolvedValue(json({ message: { content: '{not json}' } }));
    const response = await post('/api/analyze', { provider: 'ollama', image });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain('形式');
  });
  it('releases the exclusive slot after an oversized upstream response', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response('', {
        headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) },
      }),
    );
    const failed = await post('/api/analyze', { provider: 'ollama', image });
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toContain('サイズ上限');
    mockFetch.mockResolvedValueOnce(json({ message: { content: JSON.stringify(analysis) } }));
    const recovered = await post('/api/analyze', { provider: 'ollama', image });
    expect(recovered.status).toBe(200);
  });
  it('reports provider errors without exposing raw provider responses', async () => {
    mockFetch.mockResolvedValue(json({ error: 'private-provider-detail' }, 401));
    const response = await post('/api/analyze', { provider: 'openai', image, consent: true });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain('401');
    expect(body).not.toContain('private-provider-detail');
  });
});
describe('speaker resolution and synthesis parameters', () => {
  it.each(['0.25.0-test', null, 'malformed', 'oversized', 'offline'])(
    'keeps optional engine provenance separate from audio success: %s',
    async (version) => {
      const wav = Buffer.alloc(44);
      wav.write('RIFF', 0);
      wav.write('WAVE', 8);
      mockFetch.mockImplementation(async (url, init) => {
        const path = String(url);
        if (path.endsWith('/speakers'))
          return json([
            { name: '四国めたん', speaker_uuid: 'test', styles: [{ name: 'ノーマル', id: 99 }] },
          ]);
        if (path.includes('/audio_query?')) return json({ accent_phrases: [] });
        if (path.endsWith('/version')) {
          expect(path).toBe(config.voicevoxUrl + '/version');
          expect(init?.redirect).toBe('error');
          if (version === 'offline') throw new Error('private upstream failure');
          if (version === 'malformed') return json({ version: '0.25.0' });
          if (version === 'oversized') return json('x'.repeat(1025));
          return json(version);
        }
        return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
      });
      const response = await post('/api/preview', {
        voiceId: 'vv-metan',
        text: '情報付きの音声です。',
        recipe: makeRecipe(neutralProfile, voices[0]),
      });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(wav);
      const header = response.headers.get('X-Voice-Atlas-Engine');
      if (version === '0.25.0-test') {
        const info = JSON.parse(decodeURIComponent(header!));
        expect(info).toMatchObject({ engine: 'VOICEVOX', version });
        expect(Number.isFinite(Date.parse(info.checkedAt))).toBe(true);
      } else expect(header).toBeNull();
      expect(mockFetch.mock.calls.map(([url]) => String(url))).toEqual([
        config.voicevoxUrl + '/speakers',
        expect.stringContaining('/audio_query?'),
        expect.stringContaining('/synthesis?speaker=99'),
        config.voicevoxUrl + '/version',
      ]);
    },
  );
  it.each([
    ['vv-metan-whisper', '四国めたん', 'ささやき'],
    ['vv-ryusei-whisper', '青山龍星', '囁き'],
    ['vv-nurse-t-private', 'ナースロボ＿タイプＴ', '内緒話'],
  ])(
    'resolves the installed style for %s without falling back to normal',
    async (voiceId, name, style) => {
      const voice = voices.find((item) => item.id === voiceId)!;
      const wav = Buffer.alloc(44);
      wav.write('RIFF', 0);
      wav.write('WAVE', 8);
      mockFetch.mockImplementation(async (url) => {
        if (String(url).endsWith('/speakers'))
          return json([
            {
              name,
              speaker_uuid: 'test-uuid',
              styles: [
                { name: 'ノーマル', id: 9000, type: 'talk' },
                { name: style, id: 9001, type: 'talk' },
              ],
            },
          ]);
        if (String(url).includes('/audio_query?')) return json({ accent_phrases: [] });
        return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
      });
      const response = await post('/api/preview', {
        voiceId,
        text: '比較テスト',
        recipe: makeRecipe(neutralProfile, voice),
      });
      expect(response.status).toBe(200);
      expect(mockFetch.mock.calls[1][0]).toContain('speaker=9001');
      expect(mockFetch.mock.calls[2][0]).toContain('speaker=9001');
    },
  );
  it('looks up installed style IDs and applies all six settings to an audio query', async () => {
    const voice = voices.find((v) => v.id === 'vv-ryusei')!;
    const recipe = makeRecipe(neutralProfile, voice);
    const wav = Buffer.alloc(44);
    wav.write('RIFF', 0);
    wav.write('WAVE', 8);
    mockFetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/speakers'))
        return json([
          {
            name: '青山龍星',
            speaker_uuid: 'test-uuid',
            styles: [{ name: 'ノーマル', id: 9876, type: 'talk' }],
          },
        ]);
      if (String(url).includes('/audio_query?'))
        return json({ accent_phrases: [], speedScale: 1, outputSamplingRate: 48000 });
      return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
    });
    const response = await post('/api/preview', {
      voiceId: voice.id,
      text: 'こんにちは。',
      recipe,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio/wav');
    expect(mockFetch.mock.calls[1][0]).toContain('speaker=9876');
    const params = JSON.parse(String(mockFetch.mock.calls[2][1]?.body));
    expect(params).toMatchObject({ ...recipe, outputSamplingRate: 24000, outputStereo: false });
  });
  it('fails explicitly for missing installed voices and unsupported engines', async () => {
    mockFetch.mockResolvedValue(json([]));
    const recipe = makeRecipe(neutralProfile, voices[0]);
    expect(
      (await post('/api/preview', { voiceId: 'vv-metan', text: 'テスト', recipe })).status,
    ).toBe(409);
    expect((await post('/api/preview', { voiceId: 'ai-aoi', text: 'テスト', recipe })).status).toBe(
      400,
    );
  });
});

describe('provider failures and image metadata', () => {
  it('reports malformed provider envelopes as upstream failures', async () => {
    mockFetch.mockImplementation(async () => json({ unexpected: true }));
    for (const provider of ['ollama', 'openai', 'anthropic', 'gemini']) {
      const response = await post('/api/analyze', { provider, image, consent: true });
      expect(response.status).toBe(502);
    }
  });
  it('rotates pixels and removes actual embedded EXIF before sending', async () => {
    const original = await sharp({
      create: { width: 20, height: 30, channels: 3, background: '#a8bc9a' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(original).metadata()).exif).toBeDefined();
    const clean = await sanitizeImage('data:image/jpeg;base64,' + original.toString('base64'));
    const meta = await sharp(Buffer.from(clean, 'base64')).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.width).toBe(30);
    expect(meta.height).toBe(20);
  });
  it('rejects overlapping heavy requests and releases the slot afterward', async () => {
    let release!: (response: Response) => void;
    mockFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const first = post('/api/analyze', { provider: 'ollama', image });
    try {
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
      const second = await post('/api/analyze', { provider: 'ollama', image });
      expect(second.status).toBe(429);
    } finally {
      release(json({ message: { content: JSON.stringify(analysis) } }));
    }
    expect((await first).status).toBe(200);
    mockFetch.mockImplementation(async () =>
      json({ message: { content: JSON.stringify(analysis) } }),
    );
    expect((await post('/api/analyze', { provider: 'ollama', image })).status).toBe(200);
  });
});

describe('Anthropic Claude vision (mocked, no paid requests)', () => {
  const message = (value: unknown = analysis, stopReason = 'end_turn') => ({
    type: 'message',
    stop_reason: stopReason,
    content: [
      { type: 'thinking', thinking: 'not user-facing' },
      { type: 'text', text: JSON.stringify(value) },
    ],
  });
  it('requires explicit consent before contacting Anthropic', async () => {
    const response = await post('/api/analyze', { provider: 'anthropic', image, consent: false });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Anthropic');
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('rejects missing API keys without making an external request', async () => {
    await expect(
      analyzeCharacter(
        { ...config, anthropicKey: '' },
        { provider: 'anthropic', image, direction: '', consent: true },
        mockFetch,
      ),
    ).rejects.toMatchObject({ status: 503, message: expect.stringContaining('ANTHROPIC_API_KEY') });
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('reports an unset key without pretending to have checked authentication', async () => {
    mockFetch.mockImplementation(async (url) =>
      String(url).endsWith('/api/show') ? json({ capabilities: ['vision'] }) : json([]),
    );
    const result = await capabilities({ ...config, anthropicKey: '' }, mockFetch);
    expect(result.anthropic).toEqual({ ready: false, model: config.anthropicModel });
    expect(mockFetch.mock.calls.every(([url]) => !String(url).includes('anthropic.com'))).toBe(
      true,
    );
  });
  it('sends JPEG, configured credentials, and a supported JSON schema to Messages', async () => {
    mockFetch.mockResolvedValue(json(message()));
    const response = await post('/api/analyze', {
      provider: 'anthropic',
      image,
      direction: '穏やかな案内役',
      consent: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ analysis, provider: 'anthropic' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.headers).toMatchObject({
      'x-api-key': config.anthropicKey,
      'anthropic-version': '2023-06-01',
    });
    expect(init?.redirect).toBe('error');
    const sent = JSON.parse(String(init?.body));
    expect(sent.model).toBe(config.anthropicModel);
    expect(sent.max_tokens).toBe(4096);
    expect(sent.messages[0].content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg' },
    });
    expect(
      (await sharp(Buffer.from(sent.messages[0].content[0].source.data, 'base64')).metadata())
        .format,
    ).toBe('jpeg');
    expect(sent.messages[0].content[1].text).toContain('穏やかな案内役');
    const schema = sent.output_config.format.schema;
    expect(sent.output_config.format.type).toBe('json_schema');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain('profile');
    expect(schema.properties.profile.properties.pitch.description).toContain('maximum: 100');
    expect(schema.properties.summary.description).toContain('maxLength: 500');
    const encoded = JSON.stringify(schema);
    for (const key of [
      '$schema',
      'minimum',
      'maximum',
      'minLength',
      'maxLength',
      'maxItems',
      'minItems',
    ])
      expect(encoded).not.toContain(`"${key}":`);
    expect(encoded).not.toContain(config.anthropicKey);
  });
  it.each(['refusal', 'max_tokens', 'pause_turn'])(
    'rejects incomplete or refused output: %s',
    async (stopReason) => {
      mockFetch.mockResolvedValue(json(message(analysis, stopReason)));
      const response = await post('/api/analyze', { provider: 'anthropic', image, consent: true });
      expect(response.status).toBe(502);
      expect((await response.json()).analysis).toBeUndefined();
    },
  );
  it('enforces application bounds even after removing Claude schema restrictions', async () => {
    for (const value of [
      { ...analysis, profile: { ...neutralProfile, pitch: 101 } },
      { ...analysis, summary: '' },
      { ...analysis, cues: ['a', 'b', 'c', 'd', 'e', 'f'] },
    ]) {
      mockFetch.mockResolvedValueOnce(json(message(value)));
      expect(
        (await post('/api/analyze', { provider: 'anthropic', image, consent: true })).status,
      ).toBe(502);
    }
  });
  it('reports authentication errors without leaking raw provider messages or credentials', async () => {
    mockFetch.mockResolvedValue(json({ error: { message: 'private-provider-error' } }, 401));
    const response = await post('/api/analyze', { provider: 'anthropic', image, consent: true });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain('401');
    expect(body).not.toContain('private-provider-error');
    expect(body).not.toContain(config.anthropicKey);
  });
});

describe('Google Gemini vision (mocked, no paid requests)', () => {
  const answer = (value: unknown = analysis, finishReason = 'STOP') => ({
    candidates: [
      {
        finishReason,
        content: {
          parts: [
            { thought: true, text: 'private thinking must not be parsed as output' },
            { text: JSON.stringify(value) },
          ],
        },
      },
    ],
  });
  it('requires consent before contacting Google', async () => {
    const response = await post('/api/analyze', { provider: 'gemini', image, consent: false });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('Gemini');
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('rejects missing Gemini keys without external requests', async () => {
    await expect(
      analyzeCharacter(
        { ...config, geminiKey: '' },
        { provider: 'gemini', image, direction: '', consent: true },
        mockFetch,
      ),
    ).rejects.toMatchObject({ status: 503, message: expect.stringContaining('GEMINI_API_KEY') });
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('reports missing keys without making a Google API call', async () => {
    mockFetch.mockImplementation(async (url) =>
      String(url).endsWith('/api/show') ? json({ capabilities: ['vision'] }) : json([]),
    );
    const result = await capabilities({ ...config, geminiKey: '' }, mockFetch);
    expect(result.gemini).toEqual({ ready: false, model: config.geminiModel });
    expect(mockFetch.mock.calls.every(([url]) => !String(url).includes('googleapis.com'))).toBe(
      true,
    );
  });
  it('sends sanitized JPEG and structured output settings with a header-only API key', async () => {
    mockFetch.mockResolvedValue(json(answer()));
    const response = await post('/api/analyze', {
      provider: 'gemini',
      image,
      direction: '穏やかな案内役',
      consent: true,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ analysis, provider: 'gemini' });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent`,
    );
    expect(String(url)).not.toContain(config.geminiKey);
    expect(new URL(String(url)).search).toBe('');
    expect(init?.headers).toMatchObject({ 'x-goog-api-key': config.geminiKey });
    expect(init?.redirect).toBe('error');
    const sent = JSON.parse(String(init?.body));
    expect(sent.store).toBe(false);
    expect(sent.contents[0].parts[0].inlineData.mimeType).toBe('image/jpeg');
    expect(
      (await sharp(Buffer.from(sent.contents[0].parts[0].inlineData.data, 'base64')).metadata())
        .format,
    ).toBe('jpeg');
    expect(sent.contents[0].parts[1].text).toContain('穏やかな案内役');
    expect(sent.systemInstruction.parts[0].text).toContain('音声キャスティング');
    expect(sent.generationConfig.responseFormat.text.mimeType).toBe('APPLICATION_JSON');
    const schema = sent.generationConfig.responseFormat.text.schema;
    expect(schema.properties.profile.properties.pitch).toMatchObject({ minimum: 0, maximum: 100 });
    expect(schema.properties.cues.maxItems).toBe(5);
    expect(schema.properties.summary.description).toContain('maxLength: 500');
    expect(schema.properties.summary.maxLength).toBeUndefined();
    expect(schema.$schema).toBeUndefined();
    expect(JSON.stringify(sent)).not.toContain(config.geminiKey);
  });
  it.each(['MAX_TOKENS', 'SAFETY', 'RECITATION'])(
    'rejects incomplete or blocked candidates: %s',
    async (reason) => {
      mockFetch.mockResolvedValue(json(answer(analysis, reason)));
      const response = await post('/api/analyze', { provider: 'gemini', image, consent: true });
      expect(response.status).toBe(502);
      expect((await response.json()).analysis).toBeUndefined();
    },
  );
  it('reports prompt blocking even when candidates are absent', async () => {
    mockFetch.mockResolvedValue(json({ promptFeedback: { blockReason: 'SAFETY' } }));
    const response = await post('/api/analyze', { provider: 'gemini', image, consent: true });
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain('応答できません');
  });
  it('validates returned JSON values and handles empty or malformed candidates', async () => {
    for (const payload of [
      answer({ ...analysis, profile: { ...neutralProfile, pitch: 101 } }),
      answer({ ...analysis, summary: '' }),
      { candidates: [] },
      { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{broken' }] } }] },
    ]) {
      mockFetch.mockResolvedValueOnce(json(payload));
      expect(
        (await post('/api/analyze', { provider: 'gemini', image, consent: true })).status,
      ).toBe(502);
    }
  });
  it.each([400, 401, 403, 429])('masks raw provider errors for HTTP %s', async (status) => {
    mockFetch.mockResolvedValue(json({ error: { message: 'private-google-detail' } }, status));
    const response = await post('/api/analyze', { provider: 'gemini', image, consent: true });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain(String(status));
    expect(body).not.toContain('private-google-detail');
    expect(body).not.toContain(config.geminiKey);
  });
});

describe('TTS adapter boundary', () => {
  it('rejects unsupported engines without making any upstream request', () => {
    const voice = voices.find((item) => item.engine !== 'VOICEVOX')!;
    expect(() => createTtsAdapter(config, voice.engine, mockFetch)).toThrow(
      'この話者はアプリ内試聴に対応していません',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('validates the engine, text and recipe before contacting the engine', async () => {
    const adapter = createTtsAdapter(config, 'VOICEVOX', mockFetch);
    const voice = voices.find((item) => item.engine === 'VOICEVOX')!;
    const recipe = makeRecipe(neutralProfile, voice);
    await expect(
      adapter.synthesize({
        voice: voices.find((item) => item.engine !== 'VOICEVOX')!,
        text: '比較するセリフです。',
        recipe,
      }),
    ).rejects.toThrow('このエンジンに対応していません');
    await expect(adapter.synthesize({ voice, text: '   ', recipe })).rejects.toThrow();
    await expect(
      adapter.synthesize({
        voice,
        text: '比較するセリフです。',
        recipe: { ...recipe, speedScale: 100 },
      }),
    ).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not request version metadata when synthesis fails', async () => {
    mockFetch.mockResolvedValue(json([]));
    const adapter = createTtsAdapter(config, 'VOICEVOX', mockFetch);
    const voice = voices.find((item) => item.engine === 'VOICEVOX')!;
    await expect(
      adapter.synthesize({
        voice,
        text: '比較するセリフです。',
        recipe: makeRecipe(neutralProfile, voice),
      }),
    ).rejects.toThrow('音声ライブラリを確認してください');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe(config.voicevoxUrl + '/speakers');
  });
});
