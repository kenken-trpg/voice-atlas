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
  app.use(express.static(dist));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
  closeVite = () => vite.close();
}
const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`Voice Atlas: http://127.0.0.1:${config.port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close(() => {
      void closeVite?.().then(() => process.exit(0));
      if (!closeVite) process.exit(0);
    });
    server.closeAllConnections();
  });
