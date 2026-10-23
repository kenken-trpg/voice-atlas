import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { readIrodoriRun } from './irodori-memory';

const sampleSchema = z.object({
  id: z.string().regex(/^sample-\d{3}$/),
  file: z.string().regex(/^sample-\d{3}\.wav$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  text: z.string(),
  caption: z.string().nullable(),
  seed: z.number(),
  steps: z.number(),
  repeatOf: z.string().nullable(),
  durationSeconds: z.number(),
  elapsedMs: z.number(),
});
const reviewSchema = z.strictObject({
  format: z.literal('voice-atlas-irodori-review'),
  version: z.literal(1),
  runId: z.string().uuid(),
  status: z.enum(['draft', 'reviewed']),
  summary: z.string().max(4000),
  samples: z.record(z.string().regex(/^sample-\d{3}$/), z.string().max(2000)),
  updatedAt: z.string().datetime(),
});
type Review = z.infer<typeof reviewSchema>;
type PreparedRun = Awaited<ReturnType<typeof prepareReviewRuns>>[number];

function hash(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function prepareReviewRuns(paths: string[]) {
  if (!paths.length || paths.length > 8) throw new Error('評価ランは1〜8件指定してください。');
  const runs = await Promise.all(paths.map(readIrodoriRun));
  if (new Set(runs.map((item) => item.directory)).size !== runs.length)
    throw new Error('同じ評価ランを重複指定できません。');
  return runs.map(({ directory, run }, index) => {
    const id = z
      .string()
      .uuid()
      .parse((run as { id?: unknown }).id);
    const samples = z.array(sampleSchema).max(300).parse(run.samples);
    if (
      new Set(samples.map((item) => item.id)).size !== samples.length ||
      samples.some((item) => item.file !== `${item.id}.wav`)
    )
      throw new Error(`${directory}: 音声ファイルの対応が不正です。`);
    return {
      index,
      directory,
      id,
      status: run.status,
      mode: run.plan.config.mode,
      device: run.plan.config.device,
      seconds: run.plan.config.seconds ?? 30,
      samples,
    };
  });
}

function emptyReview(run: PreparedRun): Review {
  return {
    format: 'voice-atlas-irodori-review',
    version: 1,
    runId: run.id,
    status: 'draft',
    summary: '',
    samples: {},
    updatedAt: new Date(0).toISOString(),
  };
}

async function readReview(run: PreparedRun) {
  const path = join(run.directory, 'review.json');
  let bytes: Buffer;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 64 * 1024) throw new Error('review.jsonが不正です。');
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { review: emptyReview(run), revision: null };
  }
  const review = reviewSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (review.runId !== run.id) throw new Error('review.jsonの評価ランIDが一致しません。');
  return { review, revision: hash(bytes) };
}

export function createIrodoriReviewApp(runs: PreparedRun[]) {
  const app = express();
  const writeQueues = new Map<number, Promise<void>>();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (req.headers.host !== `127.0.0.1:${req.socket.localPort}`) {
      res.status(403).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    next();
  });
  app.get('/', (_req, res) =>
    res.sendFile(fileURLToPath(new URL('./irodori-review.html', import.meta.url))),
  );
  app.get('/irodori-review-ui.js', (_req, res) =>
    res
      .type('application/javascript')
      .sendFile(fileURLToPath(new URL('./irodori-review-ui.js', import.meta.url))),
  );
  app.get('/api/runs', (_req, res) =>
    res.json(
      runs.map(({ directory, samples, ...run }) => ({
        ...run,
        directory,
        samples: samples.map(({ sha256, ...sample }) => sample),
      })),
    ),
  );
  app.get('/api/review/:index', async (req, res, next) => {
    try {
      const run = runs[Number(req.params.index)];
      if (!run) {
        res.status(404).end();
        return;
      }
      res.json(await readReview(run));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/audio/:index/:sample', async (req, res, next) => {
    try {
      const run = runs[Number(req.params.index)];
      const sample = run?.samples.find((item) => item.id === req.params.sample);
      if (!run || !sample) {
        res.status(404).end();
        return;
      }
      const path = join(run.directory, sample.file);
      const info = await lstat(path);
      if (!info.isFile() || info.size > 64 * 1024 * 1024)
        throw new Error('WAVファイルが不正です。');
      const bytes = await readFile(path);
      if (hash(bytes) !== sample.sha256) throw new Error('WAVのハッシュが記録と一致しません。');
      res.type('audio/wav').send(bytes);
    } catch (error) {
      next(error);
    }
  });
  app.put(
    '/api/review/:index',
    express.json({ limit: '64kb', strict: true }),
    async (req, res, next) => {
      try {
        if (req.headers.origin !== `http://127.0.0.1:${req.socket.localPort}`) {
          res.status(403).json({ error: '同一画面から保存してください。' });
          return;
        }
        const index = Number(req.params.index);
        const run = runs[index];
        if (!run) {
          res.status(404).end();
          return;
        }
        const previous = writeQueues.get(index) ?? Promise.resolve();
        let release!: () => void;
        const queued = new Promise<void>((resolve) => {
          release = resolve;
        });
        writeQueues.set(
          index,
          previous.then(() => queued),
        );
        await previous;
        try {
          const { revision } = await readReview(run);
          if (req.body?.revision !== revision) {
            res
              .status(409)
              .json({ error: '別の画面でメモが更新されました。再読み込みして確認してください。' });
            return;
          }
          const review = reviewSchema.parse({
            ...req.body.review,
            updatedAt: new Date().toISOString(),
          });
          if (
            review.runId !== run.id ||
            Object.keys(review.samples).some(
              (id) => !run.samples.some((sample) => sample.id === id),
            )
          )
            throw new Error('メモの評価ランまたは音声IDが一致しません。');
          const bytes = JSON.stringify(review, null, 2) + '\n';
          const path = join(run.directory, 'review.json');
          const pending = join(run.directory, `review.pending-${randomUUID()}.json`);
          try {
            await writeFile(pending, bytes, { flag: 'wx' });
            await rename(pending, path);
          } finally {
            await unlink(pending).catch(() => {});
          }
          res.json({ review, revision: hash(bytes) });
        } finally {
          release();
        }
      } catch (error) {
        next(error);
      }
    },
  );
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = error instanceof Error ? error.message : '処理に失敗しました。';
      res
        .status(error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 500)
        .json({ error: message });
    },
  );
  return app;
}

export async function startIrodoriReview(paths: string[]) {
  const runs = await prepareReviewRuns(paths);
  const server = createServer(createIrodoriReviewApp(runs));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('レビュー画面を開始できませんでした。');
  console.log(`Irodoriレビュー: http://127.0.0.1:${address.port}`);
  return server;
}
