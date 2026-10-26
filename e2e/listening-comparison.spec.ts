import { test, expect } from '@playwright/test';
import { listeningRun, listeningWav } from '../tests/fixtures/listening';
import { listeningSentences } from '../shared/listening-evaluation';
const manifest = listeningRun();
const json = (value: unknown) => ({
  name: 'manifest.json',
  mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify(value)),
});
const wavs = listeningSentences.map((sentence) => ({
  name: `${sentence.id}.wav`,
  mimeType: 'audio/wav',
  buffer: listeningWav,
}));

test('compares runs, verifies audio integrity and restores notes without generating audio', async ({
  page,
}, testInfo) => {
  let synthesis = 0;
  await page.route('**/api/casting/preview', async (route) => {
    synthesis++;
    await route.abort();
  });
  await page.goto('/');
  await page.getByText('実機評価の音声・待ち時間・聴取メモを比較する', { exact: true }).click();
  const region = page.getByRole('region', { name: '実機評価結果の比較', exact: true });
  const input = region.getByLabel('実機評価ファイル');
  await input.setInputFiles([json(manifest), ...wavs]);
  await expect(region.getByRole('status')).toContainText('音声6件');
  await expect(region.locator('audio')).toHaveCount(6);
  await expect(region).toContainText('初回：1,000 ms');
  await expect(region).toContainText('2文目以降の平均：100 ms');
  const second = listeningRun('10000000-0000-4000-8000-000000000002');
  second.candidate.voice.name = '比較する声';
  await input.setInputFiles(json(second));
  await expect(region.getByRole('article')).toHaveCount(2);
  const sentence = region.getByRole('region', { name: '通常の会話', exact: true });
  const first = sentence.locator('fieldset').first();
  await first.getByLabel('聴取済み').check();
  await first.getByLabel('自然さ', { exact: true }).selectOption('4');
  await first.getByLabel('採用判断').selectOption('adopt');
  await first.getByLabel('読み違い・音の問題・判断理由').fill('語尾が役柄に合う');
  await region.getByLabel('評価者', { exact: true }).fill('評価担当');
  await region.screenshot({ path: testInfo.outputPath('comparison.png') });
  const corrupted = Buffer.from(listeningWav);
  corrupted[corrupted.length - 1] ^= 1;
  await input.setInputFiles([json(manifest), { ...wavs[0], buffer: corrupted }]);
  await expect(region.getByRole('alert')).toContainText('SHA-256');
  await expect(region.locator('audio')).toHaveCount(6);
  await expect(first.getByLabel('読み違い・音の問題・判断理由')).toHaveValue('語尾が役柄に合う');
  const pending = page.waitForEvent('download');
  await region.getByRole('button', { name: '比較記録JSONを保存', exact: true }).click();
  const stream = await (await pending).createReadStream();
  const buffers: Buffer[] = [];
  for await (const chunk of stream) buffers.push(Buffer.from(chunk));
  const saved = JSON.parse(Buffer.concat(buffers).toString());
  expect(saved.runs[0].reviews.greeting).toMatchObject({
    listened: true,
    naturalness: 4,
    decision: 'adopt',
    notes: '語尾が役柄に合う',
  });
  await input.setInputFiles(json(saved));
  await region.getByRole('button', { name: '復元をキャンセル' }).click();
  await expect(region.locator('audio')).toHaveCount(6);
  await input.setInputFiles(json(saved));
  await region.getByRole('button', { name: '比較記録を復元する', exact: true }).click();
  await expect(region.locator('audio')).toHaveCount(0);
  await expect(first.getByLabel('読み違い・音の問題・判断理由')).toHaveValue('語尾が役柄に合う');
  await input.setInputFiles([json(manifest), ...wavs]);
  await expect(region.locator('audio')).toHaveCount(6);
  await expect(region.getByRole('article')).toHaveCount(2);
  await region
    .getByRole('article')
    .last()
    .getByRole('button', { name: 'このランを比較から外す' })
    .click();
  await region.getByRole('button', { name: 'ランを外す', exact: true }).click();
  await expect(region.getByRole('article')).toHaveCount(1);
  await expect(region.locator('audio')).toHaveCount(6);
  expect(synthesis).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
