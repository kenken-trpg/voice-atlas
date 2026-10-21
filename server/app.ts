import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { voices, catalogReviewedAt } from '../shared/catalog';
import { analyzeRequestSchema, previewRequestSchema, recommendRequestSchema } from './validation';
import { recommend } from '../shared/recommend';
import type { Config } from './config';
import { analyzeCharacter, AppError, capabilities, type Fetcher } from './services';
import { createTtsAdapter } from './tts';
import { castingPreviewSchema } from '../shared/casting';
import { castingInventory, castingSynthesize } from './tts/casting';

export function createApp(config: Config, fetcher: Fetcher = fetch) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
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
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: '0.1.0' }));
  app.get('/api/catalog', (_req, res) => res.json({ voices, reviewedAt: catalogReviewedAt }));
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
  let pendingCasting: ReturnType<typeof castingInventory> | undefined;
  app.get('/api/casting/voices', async (_req, res) => {
    pendingCasting ??= castingInventory(config, fetcher).finally(() => {
      pendingCasting = undefined;
    });
    res.json(await pendingCasting);
  });
  app.post('/api/casting/preview', async (req, res) => {
    const input = castingPreviewSchema.parse(req.body);
    const result = await runExclusive(() =>
      castingSynthesize(config, input.candidate, input.text, fetcher),
    );
    res.setHeader(
      'X-Voice-Atlas-Generation',
      encodeURIComponent(JSON.stringify(result.generation)),
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
