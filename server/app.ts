import express, { type ErrorRequestHandler } from 'express';
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { voices, catalogReviewedAt } from '../shared/catalog';
import { analyzeRequestSchema, previewRequestSchema, recommendRequestSchema } from './validation';
import { recommend } from '../shared/recommend';
import type { Config } from './config';
import { analyzeCharacter, AppError, capabilities, type Fetcher } from './services';
import { createTtsAdapter } from './tts';
import { castingPreviewSchema, generationSchema } from '../shared/casting';
import { castingInventory, castingSynthesize } from './tts/casting';
import { getAivisModelInfo } from './tts/aivis-model-info';
import { elevenLabsClient } from './tts/elevenlabs';
import {
  elevenLabsModelsResponseSchema,
  elevenLabsVoicePageSchema,
  elevenLabsCursorSchema,
} from '../shared/elevenlabs';
import { irodoriCandidates } from '../shared/irodori-candidates';

const localIrodoriSamples = new Map<string, string>(
  (irodoriCandidates as readonly { samples: readonly { file: string; sha256: string }[] }[])
    .flatMap((voice) => [...voice.samples])
    .map((sample) => [sample.sha256, sample.file]),
);

export function createApp(config: Config, fetcher: Fetcher = fetch) {
  const app = express();
  const cloud = elevenLabsClient(config, fetcher);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    );
    // Local app: reject DNS rebinding and browser requests from other sites.
    const host = req.headers.host;
    if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) {
      return res.status(403).json({ error: 'ローカルホストからアクセスしてください。' });
    }
    if (
      req.headers['sec-fetch-site'] === 'cross-site' ||
      (req.headers.origin && req.headers.origin !== `http://${host}`)
    ) {
      return res.status(403).json({ error: '同じアプリ画面から実行してください。' });
    }
    if (!/^\/api(?:\/|$)/i.test(req.path)) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'POST' && !req.is('application/json'))
      return res.status(415).json({ error: 'application/jsonで送信してください。' });
    next();
  });
  app.use('/api/analyze', express.json({ limit: '12mb', inflate: false }));
  app.use('/api', express.json({ limit: '16kb', inflate: false }));
  let busy = false;
  const runExclusive = async <T>(work: () => Promise<T>) => {
    if (busy) throw new AppError(429, '処理中です。完了後にもう一度お試しください。');
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  };
  let cloudBusy = false;
  const runCloudExclusive = async <T>(work: () => Promise<T>) => {
    if (cloudBusy)
      throw new AppError(429, 'ElevenLabsで生成中です。完了後にもう一度お試しください。');
    cloudBusy = true;
    try {
      return await work();
    } finally {
      cloudBusy = false;
    }
  };
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.1.0' }));
  app.get('/api/catalog', (_req, res) => res.json({ voices, reviewedAt: catalogReviewedAt }));
  app.get('/api/irodori-samples/:hash', async (req, res) => {
    const hash = req.params.hash;
    const file = localIrodoriSamples.get(hash);
    if (!file) throw new AppError(404, '検証音声が見つかりません。');
    const path = fileURLToPath(
      new URL(`../.local-artifacts/irodori-v41-voice-design-20261024/${file}`, import.meta.url),
    );
    let wav: Buffer;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 4 * 1024 * 1024)
        throw new AppError(409, '検証音声の形式・サイズを確認してください。');
      wav = await readFile(path);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(404, 'この端末に検証音声がありません。');
    }
    if (createHash('sha256').update(wav).digest('hex') !== hash)
      throw new AppError(409, '検証音声の内容が記録と一致しません。');
    res.type('audio/wav').send(wav);
  });
  // Share only pending checks: an explicit refresh always gets fresh service state.
  let pendingCapabilities: ReturnType<typeof capabilities> | undefined;
  app.get('/api/capabilities', async (_req, res) => {
    pendingCapabilities ??= capabilities(config, fetcher).finally(() => {
      pendingCapabilities = undefined;
    });
    res.json(await pendingCapabilities);
  });
  app.post('/api/recommend', (req, res) => {
    const input = recommendRequestSchema.parse(req.body);
    res.json({ recommendations: recommend(input.profile, input.preferences) });
  });
  app.post('/api/analyze', async (req, res) => {
    const input = analyzeRequestSchema.parse(req.body);
    const analysis = await runExclusive(() => analyzeCharacter(config, input, fetcher));
    res.json({ analysis, provider: input.provider });
  });
  app.post('/api/preview', async (req, res) => {
    const input = previewRequestSchema.parse(req.body);
    const voice = voices.find((item) => item.id === input.voiceId);
    if (!voice) throw new AppError(404, '話者が見つかりません。');
    const adapter = createTtsAdapter(config, voice.engine, fetcher);
    const { wav, engineInfo } = await runExclusive(() =>
      adapter.synthesize({ voice, text: input.text, recipe: input.recipe }),
    );
    if (engineInfo)
      res.setHeader('X-Voice-Atlas-Engine', encodeURIComponent(JSON.stringify(engineInfo)));
    res.type('audio/wav').send(wav);
  });
  let pendingModelInfo: ReturnType<typeof getAivisModelInfo> | undefined;
  app.get('/api/casting/aivis-models', async (_req, res) => {
    pendingModelInfo ??= getAivisModelInfo(
      config.aivisUrl || 'http://127.0.0.1:10101',
      fetcher,
    ).finally(() => {
      pendingModelInfo = undefined;
    });
    res.json(await pendingModelInfo);
  });
  let pendingCasting: ReturnType<typeof castingInventory> | undefined;
  app.get('/api/casting/voices', async (_req, res) => {
    pendingCasting ??= castingInventory(config, fetcher, cloud).finally(() => {
      pendingCasting = undefined;
    });
    res.json(await pendingCasting);
  });
  app.get('/api/casting/elevenlabs/models', async (_req, res) => {
    try {
      const models = await cloud.listModels();
      res.json(
        elevenLabsModelsResponseSchema.parse({
          ready: models.length > 0,
          detail: models.length
            ? 'モデル一覧を取得しました。'
            : '利用できる音声合成モデルがありません。',
          checkedAt: new Date().toISOString(),
          models,
        }),
      );
    } catch (error) {
      res.json(
        elevenLabsModelsResponseSchema.parse({
          ready: false,
          detail:
            error instanceof AppError
              ? error.message
              : 'ElevenLabsのモデル一覧を取得できませんでした。',
          checkedAt: new Date().toISOString(),
          models: [],
        }),
      );
    }
  });
  app.get('/api/casting/elevenlabs/voices', async (req, res) => {
    const query = z
      .object({ search: z.string().max(100).optional(), cursor: elevenLabsCursorSchema.optional() })
      .parse(req.query);
    try {
      const page = await cloud.listVoices(query.search ?? '', query.cursor ?? null);
      res.json(elevenLabsVoicePageSchema.parse(page));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'ElevenLabsの声一覧を取得できませんでした。');
    }
  });
  app.post('/api/casting/preview', async (req, res) => {
    const input = castingPreviewSchema.parse(req.body);
    const exclusive =
      input.candidate.voice.engine === 'ElevenLabs' ? runCloudExclusive : runExclusive;
    const result = await exclusive(() =>
      castingSynthesize(config, input.candidate, input.text, fetcher, cloud),
    );
    res.setHeader(
      'X-Voice-Atlas-Generation',
      encodeURIComponent(JSON.stringify(generationSchema.parse(result.generation))),
    );
    res.type('audio/wav').send(result.wav);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'APIが見つかりません。' }));
  const onError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (error instanceof AppError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: '入力の形式・範囲を確認してください。' });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: '有効なJSONを送信してください。' });
      return;
    }
    if ((error as { type?: string })?.type === 'entity.too.large') {
      res
        .status(413)
        .json({ error: '送信データが上限を超えました。画像は8MB以下にしてください。' });
      return;
    }
    if ((error as { type?: string })?.type === 'encoding.unsupported') {
      res.status(415).json({ error: '圧縮せずにJSONを送信してください。' });
      return;
    }
    // Never log image bodies, provider responses or secrets.
    console.error('Request failed:', error instanceof Error ? error.name : 'UnknownError');
    res
      .status(500)
      .json({ error: '処理に失敗しました。接続状態を確認して、もう一度お試しください。' });
  };
  app.use(onError);
  return app;
}
