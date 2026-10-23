import { test, expect, type Page } from '@playwright/test';
import { projectFixture } from '../tests/fixtures/project';
import { projectStorageKey } from '../shared/project';
import { scriptCandidate } from '../shared/script';
import { pcmWav } from '../tests/fixtures/wav';

const fixture = projectFixture();
async function expand(page: Page) {
  await page.getByRole('button', { name: 'VOICEVOX・AivisSpeechを比較する', exact: true }).click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  return page.getByRole('region', { name: '台本の試聴', exact: true });
}
async function setup(page: Page) {
  await page.addInitScript(
    ({ key, data }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, data);
    },
    { key: projectStorageKey, data: JSON.stringify(fixture) },
  );
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: fixture.createdAt,
        engines: ['VOICEVOX', 'AivisSpeech'].map((engine) => ({
          engine,
          ready: true,
          detail: '接続済み',
        })),
        voices: fixture.documents.script!.lines.map((line) => scriptCandidate(line)!.voice),
      },
    }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({ json: { ready: false, checkedAt: fixture.createdAt, models: [] } }),
  );
  let calls = 0;
  await page.route('**/api/casting/preview', (route) => {
    const body = route.request().postDataJSON();
    calls++;
    return route.fulfill({
      contentType: 'audio/wav',
      body: Buffer.from(pcmWav(Array(2400).fill(calls * 100))),
      headers: {
        'X-Voice-Atlas-Generation': encodeURIComponent(
          JSON.stringify({
            engine: body.candidate.voice.engine,
            engineVersion: 'cache-test-version',
            checkedAt: fixture.createdAt,
          }),
        ),
      },
    });
  });
  await page.goto('/');
  const panel = await expand(page);
  return { panel, calls: () => calls };
}
async function saveProject(page: Page) {
  const panel = page.getByRole('region', { name: '作品の保存と復元', exact: true });
  if (!(await panel.isVisible()))
    await page.getByText('作品を保存・復元する', { exact: true }).click();
  await panel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  await expect(panel.getByText('作品はブラウザに保存済みです', { exact: true })).toBeVisible();
  return panel;
}
async function openCache(panel: ReturnType<Page['getByRole']>) {
  const region = panel.getByRole('region', { name: '台本音声の保存と再利用', exact: true });
  if (!(await region.isVisible()))
    await panel.getByText('台本音声の保存と再利用', { exact: true }).click();
  return region;
}
test('keeps editing available while initial cache loading waits and enables generation after it finishes', async ({
  page,
}) => {
  let requested = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/assets/script-audio-store-*.js', async (route) => {
    requested = true;
    await held;
    await route.continue();
  });
  const { panel, calls } = await setup(page);
  try {
    await expect.poll(() => requested).toBe(true);
    const generate = panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true });
    await expect(generate).toBeDisabled();
    await panel.getByLabel('第1行のセリフ', { exact: true }).fill('読み込み中の編集');
    await saveProject(page);
    expect(calls()).toBe(0);
    release();
    await expect(generate).toBeEnabled();
    await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue(
      '読み込み中の編集',
    );
    await generate.click();
    await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
    expect(calls()).toBe(2);
  } finally {
    release();
  }
});
test('persists WAVs and provenance across reload, ignores changed conditions and explicitly clears cached audio', async ({
  page,
}, testInfo) => {
  const { panel, calls } = await setup(page);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  const projectPanel = await saveProject(page);
  const savedProject = projectPanel.getByRole('listitem', {
    name: '保存作品 導入シナリオ',
    exact: true,
  });
  await expect(savedProject).toContainText('保存音声：0.00MiB・0行');
  let cache = await openCache(panel);
  await cache.getByRole('button', { name: '台本音声をブラウザに保存', exact: true }).click();
  await expect(
    panel.getByRole('status').filter({ hasText: '2行の音声をこのブラウザに保存' }),
  ).toBeVisible();
  await expect(savedProject).toContainText('保存音声：0.01MiB・2行');
  await page.reload();
  await expand(page);
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  expect(calls()).toBe(2);
  await expect(
    panel.getByText('今回の生成エンジン版：cache-test-version', { exact: true }),
  ).toHaveCount(2);
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('別のセリフ');
  await expect(panel.locator(':scope > ol audio')).toHaveCount(1);
  cache = await openCache(panel);
  await cache.getByRole('button', { name: '保存した台本音声を読み込む', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(1);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  expect(calls()).toBe(3);
  await cache.getByRole('button', { name: '台本音声をブラウザに保存', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('先にブラウザに保存');
  await saveProject(page);
  await cache.getByRole('button', { name: '台本音声をブラウザに保存', exact: true }).click();
  await expect(
    panel.getByRole('status').filter({ hasText: '2行の音声をこのブラウザに保存' }),
  ).toBeVisible();
  await cache.screenshot({ path: testInfo.outputPath('audio-cache.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await cache.getByRole('button', { name: 'この作品の保存音声を削除', exact: true }).click();
  await cache.getByRole('button', { name: '保存音声の削除をキャンセル', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await cache.getByRole('button', { name: 'この作品の保存音声を削除', exact: true }).click();
  await cache.getByRole('button', { name: '確認した保存音声を削除', exact: true }).click();
  await expect(
    panel.getByRole('status').filter({ hasText: '保存音声を削除しました' }),
  ).toBeVisible();
  await expect(savedProject).toContainText('保存音声：0.00MiB・0行');
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await page.reload();
  await expand(page);
  await expect(
    panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }),
  ).toBeEnabled();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(0);
  expect(calls()).toBe(3);
});
test('does not reuse another project cache when a project is duplicated, and recovers the original cached audio', async ({
  page,
}) => {
  const { panel, calls } = await setup(page);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  const projects = await saveProject(page);
  const cache = await openCache(panel);
  await cache.getByRole('button', { name: '台本音声をブラウザに保存', exact: true }).click();
  await expect(
    panel.getByRole('status').filter({ hasText: '2行の音声をこのブラウザに保存' }),
  ).toBeVisible();
  await projects.getByRole('button', { name: '保存済みの作品を複製', exact: true }).click();
  await projects.getByRole('button', { name: '確認した作品を復元', exact: true }).click();
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  await expect(
    projects.getByRole('listitem', { name: '保存作品 導入シナリオ（コピー）' }),
  ).toContainText('保存音声：0.00MiB・0行');
  await expect(
    projects.getByRole('listitem', { name: '保存作品 導入シナリオ', exact: true }),
  ).toContainText('保存音声：0.01MiB・2行');
  await expand(page);
  await expect(
    panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }),
  ).toBeEnabled();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(0);
  await projects
    .getByRole('listitem', { name: '保存作品 導入シナリオ', exact: true })
    .getByRole('button', { name: 'この作品を開く', exact: true })
    .click();
  await projects.getByRole('button', { name: '確認した作品を復元', exact: true }).click();
  if (
    await projects
      .getByRole('button', { name: '未保存の変更を破棄して切り替える', exact: true })
      .isVisible()
  )
    await projects
      .getByRole('button', { name: '未保存の変更を破棄して切り替える', exact: true })
      .click();
  await expand(page);
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  expect(calls()).toBe(2);
});
test('aborts a failed cache update atomically and retains the old WAVs as well as current live previews', async ({
  page,
}) => {
  const { panel, calls } = await setup(page);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await saveProject(page);
  const cache = await openCache(panel);
  await cache.getByRole('button', { name: '台本音声をブラウザに保存', exact: true }).click();
  await expect(
    panel.getByRole('status').filter({ hasText: '2行の音声をこのブラウザに保存' }),
  ).toBeVisible();
  await panel.getByRole('button', { name: '第1行を再生成', exact: true }).click();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'audio') throw new DOMException('full', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await cache.getByRole('button', { name: '台本音声をブラウザに保存', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('保存容量');
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await page.reload();
  await expand(page);
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  expect(calls()).toBe(3);
  const sample = await page.evaluate(
    async ({ projectId, lineId }) => {
      const entry: { blob: Blob } = await new Promise((resolve, reject) => {
        const request = indexedDB.open('voice-atlas-script-audio-v1', 1);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction('audio');
          const get = tx.objectStore('audio').get(JSON.stringify([projectId, lineId]));
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
          tx.oncomplete = () => db.close();
        };
      });
      return new DataView(await entry.blob.arrayBuffer()).getInt16(44, true);
    },
    { projectId: fixture.id, lineId: fixture.documents.script!.lines[0].id },
  );
  expect(sample).toBe(100);
});

test('enforces cache capacity and ignores stored provenance that does not match the line voice', async ({
  page,
}) => {
  const { panel, calls } = await setup(page);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await saveProject(page);
  const cache = await openCache(panel);
  await cache.getByRole('button', { name: '台本音声をブラウザに保存', exact: true }).click();
  await expect(
    panel.getByRole('status').filter({ hasText: '2行の音声をこのブラウザに保存' }),
  ).toBeVisible();
  await page.evaluate(
    ({ projectId, lineId }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('voice-atlas-script-audio-v1', 1);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction(['audio', 'sizes'], 'readwrite');
          tx.objectStore('sizes').put({ id: 'capacity-test', projectId, bytes: 65 * 1024 * 1024 });
          const get = tx.objectStore('audio').get(JSON.stringify([projectId, lineId]));
          get.onsuccess = () => {
            const entry = get.result;
            entry.audition.generation.engine = 'VOICEVOX';
            tx.objectStore('audio').put(entry);
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    { projectId: fixture.id, lineId: fixture.documents.script!.lines[0].id },
  );
  await cache.getByRole('button', { name: '台本音声をブラウザに保存', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('容量上限');
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await page.reload();
  await expand(page);
  await expect(
    panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }),
  ).toBeEnabled();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(1);
  expect(calls()).toBe(2);
});
