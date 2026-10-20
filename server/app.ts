import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { voices, catalogReviewedAt } from '../shared/catalog';
import { preferencesSchema, profileSchema, recipeSchema, providerSchema } from '../shared/schema';
import { recommend } from '../shared/recommend';
import type { Config } from './config';
import { analyzeImage, AppError, capabilities, synthesize, type Fetcher } from './services';

export function createApp(config: Config, fetcher: Fetcher = fetch) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (!req.path.startsWith('/api/')) return next();
    res.setHeader('Cache-Control', 'no-store');
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
    if (req.method === 'POST' && !req.is('application/json'))
      return res.status(415).json({ error: 'application/jsonで送信してください。' });
    next();
  });
  app.use('/api', express.json({ limit: '12mb' }));
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
  app.get('/api/capabilities', async (_req, res) => res.json(await capabilities(config, fetcher)));
  app.post('/api/recommend', (req, res) => {
    const input = z
      .object({ profile: profileSchema, preferences: preferencesSchema })
      .parse(req.body);
    res.json({ recommendations: recommend(input.profile, input.preferences) });
  });
  app.post('/api/analyze', async (req, res) => {
    const input = z
      .object({
        provider: providerSchema,
        image: z.string().max(11_200_000),
        direction: z.string().max(1000).default(''),
        consent: z.boolean().default(false),
      })
      .parse(req.body);
    const analysis = await runExclusive(() => analyzeImage(config, input, fetcher));
    res.json({ analysis, provider: input.provider });
  });
  app.post('/api/preview', async (req, res) => {
    const input = z
      .object({
        voiceId: z.string().max(80),
        text: z.string().trim().min(1).max(300),
        recipe: recipeSchema,
      })
      .parse(req.body);
    const voice = voices.find((item) => item.id === input.voiceId);
    if (!voice) throw new AppError(404, '話者が見つかりません。');
    const wav = await runExclusive(() =>
      synthesize(config, voice, input.text, input.recipe, fetcher),
    );
    res.type('audio/wav').send(wav);
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
      res.status(413).json({ error: '画像は8MB以下にしてください。' });
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
