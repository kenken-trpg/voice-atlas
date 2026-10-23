import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIrodoriReviewApp, prepareReviewRuns } from '../server/irodori-review';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'irodori-review-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const wav = Buffer.from('RIFFmock WAV bytes');
  await writeFile(join(directory, 'sample-001.wav'), wav);
  const manifest = {
    format: 'voice-atlas-irodori-run',
    version: 1,
    id: '00000000-0000-4000-8000-000000000001',
    status: 'completed',
    plan: { config: { mode: 'voice-design', device: 'cpu', seconds: 10 } },
    samples: [
      {
        id: 'sample-001',
        file: 'sample-001.wav',
        sha256: createHash('sha256').update(wav).digest('hex'),
        text: 'テスト',
        caption: '静かな声',
        seed: 17,
        steps: 20,
        repeatOf: null,
        durationSeconds: 1,
        elapsedMs: 200,
      },
    ],
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const runs = await prepareReviewRuns([directory]);
  const server: Server = createServer(createIrodoriReviewApp(runs));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address missing');
  const base = `http://127.0.0.1:${address.port}`;
  return { directory, base, manifest };
}

describe('Irodori local review', () => {
  it('shows existing samples, serves only matching WAV, and keeps the manifest unchanged', async () => {
    const { directory, base } = await fixture();
    const before = await readFile(join(directory, 'manifest.json'));
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Irodori 試聴レビュー');
    const runs = await (await fetch(`${base}/api/runs`)).json();
    expect(runs[0].samples[0]).toMatchObject({ id: 'sample-001', text: 'テスト' });
    expect(runs[0].samples[0].sha256).toBeUndefined();
    expect((await fetch(`${base}/api/audio/0/sample-001`)).status).toBe(200);
    expect((await fetch(`${base}/api/audio/0/sample-999`)).status).toBe(404);
    await writeFile(join(directory, 'sample-001.wav'), 'changed');
    expect((await fetch(`${base}/api/audio/0/sample-001`)).status).toBe(500);
    expect(await readFile(join(directory, 'manifest.json'))).toEqual(before);
  });

  it('saves drafts separately and rejects stale edits and cross-origin saves', async () => {
    const { directory, base, manifest } = await fixture();
    const initial = await (await fetch(`${base}/api/review/0`)).json();
    expect(initial.revision).toBeNull();
    const review = {
      ...initial.review,
      summary: '試聴前の確認事項',
      samples: { 'sample-001': '後で末尾を確認' },
    };
    const request = (revision: string | null, origin = base) =>
      fetch(`${base}/api/review/0`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ revision, review }),
      });
    expect((await request(null, 'http://another.example')).status).toBe(403);
    const saved = await request(null);
    expect(saved.status).toBe(200);
    expect((await saved.json()).revision).toMatch(/^[0-9a-f]{64}$/);
    expect((await request(null)).status).toBe(409);
    expect(JSON.parse(await readFile(join(directory, 'review.json'), 'utf8'))).toMatchObject({
      runId: review.runId,
      status: 'draft',
      summary: review.summary,
      samples: review.samples,
    });
    expect(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))).toEqual(manifest);
  });

  it('rejects invalid sample paths in a manifest', async () => {
    const { directory, manifest } = await fixture();
    manifest.samples[0].file = '../outside.wav';
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await expect(prepareReviewRuns([directory])).rejects.toThrow();
  });
});
