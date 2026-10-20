import express from 'express';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createApp } from './app';
import { loadConfig } from './config';
const config = loadConfig();
const app = createApp(config);
const production = process.argv.includes('--production');
let closeVite: (() => Promise<void>) | undefined;
if (production) {
  const dist = fileURLToPath(new URL('../dist', import.meta.url));
  if (!existsSync(resolve(dist, 'index.html')))
    throw new Error('先に npm run build を実行してください。');
  app.use((_req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
    next();
  });
  app.use('/assets', express.static(resolve(dist, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(dist, { maxAge: 0 }));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
  closeVite = () => vite.close();
}
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Voice Atlas: http://127.0.0.1:${config.port}`);
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close(() => {
      void closeVite?.().then(() => process.exit(0));
      if (!closeVite) process.exit(0);
    });
    server.closeAllConnections();
  });
