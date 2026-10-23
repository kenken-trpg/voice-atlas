import { test, expect } from '@playwright/test';
import { pcmWav } from '../tests/fixtures/wav';
import { projectFixture } from '../tests/fixtures/project';
import { castingKey, type CastingInventory } from '../shared/casting';
import { projectStorageKey, projectLibraryStorageKey } from '../shared/project';

const voice = {
  engine: 'AivisSpeech' as const,
  speakerUuid: '11111111-1111-4111-8111-111111111111',
  name: '案内役',
  style: 'ノーマル',
};
function inventory(ready = true): CastingInventory {
  return {
    checkedAt: '2026-10-22T00:00:00Z',
    engines: [
      { engine: 'VOICEVOX', ready: true, detail: '接続済み' },
      { engine: 'AivisSpeech', ready, detail: ready ? '接続済み' : '未接続' },
    ],
    voices: ready ? [voice] : [],
  };
}
test('distinguishes connected with no matching voices, offline and failed checks without generating automatically', async ({
  page,
}) => {
  let checks = 0,
    posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') posts++;
  });
  await page.route('**/api/casting/voices', (route) => {
    checks++;
    return checks === 3
      ? route.fulfill({ status: 500, json: { error: 'failure' } })
      : route.fulfill({ json: inventory(checks === 2) });
  });
  await page.goto('/');
  expect(checks).toBe(0);
  await page.getByText('はじめての試聴・接続を確認する', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'はじめての音声試聴', exact: true });
  await expect(panel.locator('li').filter({ hasText: 'VOICEVOX：' })).toContainText(
    '接続済み・利用できる候補がありません',
  );
  await expect(panel.locator('li').filter({ hasText: 'AivisSpeech：' })).toContainText('未接続');
  await expect(panel.getByRole('button', { name: '最初の試聴音声を生成' })).toBeDisabled();
  await panel.getByRole('button', { name: '試聴用の接続を再確認' }).click();
  await expect(panel.getByLabel('はじめての試聴の声')).toHaveValue(castingKey(voice));
  await expect(panel.getByRole('button', { name: '最初の試聴音声を生成' })).toBeEnabled();
  await panel.getByRole('button', { name: '試聴用の接続を再確認' }).click();
  await expect(panel.getByRole('alert')).toContainText('接続を確認できませんでした');
  await expect(panel.getByLabel('はじめての試聴の声')).toHaveValue('');
  await expect(panel.getByRole('button', { name: '最初の試聴音声を生成' })).toBeDisabled();
  expect(posts).toBe(0);
});
test('previews native settings, clears outdated audio after edits and exports a WAV', async ({
  page,
}, testInfo) => {
  const calls: unknown[] = [];
  await page.route('**/api/casting/voices', (route) => route.fulfill({ json: inventory() }));
  await page.route('**/api/casting/preview', (route) => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'audio/wav', body: Buffer.from(pcmWav([100, 0, -100])) });
  });
  await page.goto('/');
  await page.getByText('はじめての試聴・接続を確認する', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'はじめての音声試聴', exact: true });
  await expect(panel.getByLabel('はじめての試聴の声')).toHaveValue(castingKey(voice));
  await panel.getByLabel('はじめての試聴のセリフ').fill('声を確かめます。');
  await panel.getByRole('button', { name: '最初の試聴音声を生成' }).click();
  await expect(panel.getByLabel('はじめての試聴音声')).toBeVisible();
  expect(calls).toEqual([
    expect.objectContaining({
      text: '声を確かめます。',
      candidate: {
        voice,
        recipe: expect.objectContaining({ engine: 'AivisSpeech', tempoDynamicsScale: 1 }),
      },
    }),
  ]);
  const event = page.waitForEvent('download');
  await panel.getByRole('link', { name: '最初の試聴WAVを保存' }).click();
  expect((await event).suggestedFilename()).toBe('voice-atlas-first-preview.wav');
  await panel.screenshot({ path: testInfo.outputPath('connection-guide.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByLabel('はじめての試聴のセリフ').fill('変更後');
  await expect(panel.getByLabel('はじめての試聴音声')).toHaveCount(0);
});
test('blocks project switching while generating and can cancel then retry the preview', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route('**/api/casting/voices', (route) => route.fulfill({ json: inventory() }));
  await page.route('**/api/casting/preview', async (route) => {
    if (++calls === 1) await gate;
    try {
      await route.fulfill({ contentType: 'audio/wav', body: Buffer.from(pcmWav([100, 0, -100])) });
    } catch {
      /* cancelled */
    }
  });
  await page.goto('/');
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  await page.getByLabel('作品JSONファイル', { exact: true }).setInputFiles({
    name: 'project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(projectFixture())),
  });
  await page.getByText('はじめての試聴・接続を確認する', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'はじめての音声試聴', exact: true });
  await expect(panel.getByRole('button', { name: '最初の試聴音声を生成' })).toBeEnabled();
  await panel.getByRole('button', { name: '最初の試聴音声を生成' }).click();
  const project = page.getByRole('region', { name: '作品の保存と復元', exact: true });
  await project.getByRole('button', { name: '確認した作品を復元' }).click();
  await expect(project.getByRole('alert')).toContainText('処理が完了してから');
  expect(await page.evaluate((key) => localStorage.getItem(key), projectStorageKey)).toBeNull();
  await panel.getByRole('button', { name: '試聴の待機を中止' }).click();
  release();
  await expect(panel.getByRole('button', { name: '最初の試聴音声を生成' })).toBeEnabled();
  await panel.getByRole('button', { name: '最初の試聴音声を生成' }).click();
  await expect(panel.getByLabel('はじめての試聴音声')).toBeVisible();
  await project.getByRole('button', { name: '確認した作品を復元' }).click();
  expect(
    await page.evaluate((key) => {
      const library = JSON.parse(localStorage.getItem(key)!);
      return library.projects.find((p: { id: string }) => p.id === library.activeId).name;
    }, projectLibraryStorageKey),
  ).toBe('導入シナリオ');
});
