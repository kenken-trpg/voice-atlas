import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import sharp from 'sharp';
import { createApp } from '../server/app';
import type { Config } from '../server/config';
import { makeRecipe } from '../shared/recommend';
import { voices } from '../shared/catalog';
import { neutralProfile } from '../shared/schema';
import { sanitizeImage } from '../server/services';

const config: Config = { port: 3210, ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'test-local-vision',
  openaiKey: 'test-key-not-real', openaiModel: 'test-vision', voicevoxUrl: 'http://127.0.0.1:50021' };
const mockFetch = vi.fn<typeof fetch>();
const analysis = { subjectFound: true, summary: '落ち着いた案内役という演出案です。', cues: ['落ち着いた配色'], delivery: '丁寧な語り口で。', profile: neutralProfile };
const json = (data: unknown, status = 200) => Response.json(data, { status });
let server: Server, base: string, image: string;
beforeAll(async () => {
  image = 'data:image/png;base64,' + (await sharp({ create: { width: 48, height: 64, channels: 3, background: '#95b6a7' } }).png().toBuffer()).toString('base64');
  server = await new Promise<Server>(resolve => { const s = createApp(config, mockFetch).listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { mockFetch.mockReset(); });
async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
describe('local API boundaries', () => {
  it('serves health and keeps the API key out of capabilities', async () => {
    mockFetch.mockImplementation(async (url) => String(url).endsWith('/api/show') ? json({ capabilities: ['vision'] }) : json([]));
    expect((await fetch(base + '/api/health')).status).toBe(200);
    const response = await fetch(base + '/api/capabilities'); const body = await response.json();
    expect(body.ollama.ready).toBe(true); expect(body.openai.ready).toBe(true);
    expect(JSON.stringify(body)).not.toContain(config.openaiKey); expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('handles absent services without claiming successful analysis', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const body = await (await fetch(base + '/api/capabilities')).json();
    expect(body.ollama.ready).toBe(false); expect(body.voicevox.ready).toBe(false);
  });
  it('rejects requests from other websites before calling services', async () => {
    expect((await post('/api/analyze', {}, { Origin: 'https://untrusted.example' })).status).toBe(403);
    expect((await post('/api/analyze', {}, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('rejects invalid input and returns JSON for invalid JSON and routes', async () => {
    expect((await post('/api/recommend', { profile: { ...neutralProfile, pitch: 999 }, preferences: {} })).status).toBe(400);
    const malformed = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' });
    expect(malformed.status).toBe(400); expect((await malformed.json()).error).toBeTruthy();
    expect((await fetch(base + '/api/unknown')).status).toBe(404);
  });
  it('requires consent before any OpenAI call', async () => {
    const response = await post('/api/analyze', { provider: 'openai', image, consent: false });
    expect(response.status).toBe(400); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('rejects forged or oversized images without contacting the model', async () => {
    for (const badImage of ['data:image/png;base64,SGVsbG8=', 'data:image/svg+xml;base64,PHN2Zy8+']) {
      expect((await post('/api/analyze', { provider: 'ollama', image: badImage })).status).toBe(400);
    }
    await expect(sanitizeImage('data:image/png;base64,' + Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'))).rejects.toMatchObject({ status: 413 });
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('returns curated recommendations without making AI requests', async () => {
    const response = await post('/api/recommend', { profile: neutralProfile, preferences: { budget: 'free', engine: 'VOICEVOX' } });
    expect(response.status).toBe(200); const body = await response.json(); expect(body.recommendations).toHaveLength(6); expect(mockFetch).not.toHaveBeenCalled();
  });
});
describe('vision provider contracts (mocked, no paid requests)', () => {
  it('sends re-encoded JPEG and schema to local Ollama', async () => {
    mockFetch.mockResolvedValue(json({ message: { content: JSON.stringify(analysis) } }));
    const response = await post('/api/analyze', { provider: 'ollama', image, direction: '静かな声' });
    expect(response.status).toBe(200); expect((await response.json()).analysis.summary).toBe(analysis.summary);
    const [url, init] = mockFetch.mock.calls[0]; expect(url).toBe(config.ollamaUrl + '/api/chat');
    const sent = JSON.parse(String(init?.body)); expect(sent.stream).toBe(false); expect(sent.format.type).toBe('object');
    const meta = await sharp(Buffer.from(sent.messages[1].images[0], 'base64')).metadata();
    expect(meta.format).toBe('jpeg'); expect(meta.exif).toBeUndefined(); expect(init?.redirect).toBe('error');
  });
  it('uses Responses structured output, suppresses storage, and extracts text blocks', async () => {
    mockFetch.mockResolvedValue(json({ status: 'completed', output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(analysis) }] }] }));
    const response = await post('/api/analyze', { provider: 'openai', image, consent: true });
    expect(response.status).toBe(200);
    const [url, init] = mockFetch.mock.calls[0]; expect(url).toBe('https://api.openai.com/v1/responses');
    const sent = JSON.parse(String(init?.body)); expect(sent.store).toBe(false); expect(sent.text.format.strict).toBe(true);
    expect(sent.input[0].content[1].image_url).toMatch(/^data:image\/jpeg;base64,/);
  });
  it('does not invent a result when the model returns malformed output', async () => {
    mockFetch.mockResolvedValue(json({ message: { content: '{not json}' } }));
    const response = await post('/api/analyze', { provider: 'ollama', image });
    expect(response.status).toBe(502); expect((await response.json()).error).toContain('形式');
  });
  it('reports provider errors without exposing raw provider responses', async () => {
    mockFetch.mockResolvedValue(json({ error: 'private-provider-detail' }, 401));
    const response = await post('/api/analyze', { provider: 'openai', image, consent: true });
    expect(response.status).toBe(502); const body = await response.text(); expect(body).toContain('401'); expect(body).not.toContain('private-provider-detail');
  });
});
describe('real speaker resolution and synthesis parameters', () => {
  it('looks up installed style IDs and applies all six settings to an audio query', async () => {
    const voice = voices.find(v => v.id === 'vv-ryusei')!; const recipe = makeRecipe(neutralProfile, voice);
    const wav = Buffer.alloc(44); wav.write('RIFF', 0); wav.write('WAVE', 8);
    mockFetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/speakers')) return json([{ name: '青山龍星', speaker_uuid: 'test-uuid', styles: [{ name: 'ノーマル', id: 9876, type: 'talk' }] }]);
      if (String(url).includes('/audio_query?')) return json({ accent_phrases: [], speedScale: 1, outputSamplingRate: 48000 });
      return new Response(wav, { headers: { 'Content-Type': 'audio/wav' } });
    });
    const response = await post('/api/preview', { voiceId: voice.id, text: 'こんにちは。', recipe });
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('audio/wav');
    expect(mockFetch.mock.calls[1][0]).toContain('speaker=9876');
    const params = JSON.parse(String(mockFetch.mock.calls[2][1]?.body));
    expect(params).toMatchObject({ ...recipe, outputSamplingRate: 24000, outputStereo: false });
  });
  it('fails explicitly for missing installed voices and unsupported engines', async () => {
    mockFetch.mockResolvedValue(json([]));
    const recipe = makeRecipe(neutralProfile, voices[0]);
    expect((await post('/api/preview', { voiceId: 'vv-metan', text: 'テスト', recipe })).status).toBe(409);
    expect((await post('/api/preview', { voiceId: 'ai-aoi', text: 'テスト', recipe })).status).toBe(400);
  });
});
