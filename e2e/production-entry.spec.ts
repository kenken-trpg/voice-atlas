import { test, expect } from '@playwright/test';

test('production entry opens nested workspaces and preserves edits across navigation', async ({
  page,
}) => {
  let synthesis = 0;
  await page.route('**/api/casting/preview', async (route) => {
    synthesis++;
    await route.abort();
  });
  await page.goto('/');
  const entry = page.getByRole('region', { name: '制作の入口', exact: true });
  await expect(entry).toContainText('まだ作品として保存していません');
  await entry.getByRole('button', { name: '台本へ進む' }).click();
  await expect(page.getByRole('region', { name: '台本の試聴', exact: true })).toBeVisible();
  await expect(page.locator('#production-script > summary')).toBeFocused();
  await entry.getByRole('button', { name: '配役へ進む' }).click();
  await expect(page.getByRole('region', { name: 'キャスティング表', exact: true })).toBeFocused();
  await entry.getByRole('button', { name: '声探しへ進む' }).click();
  await expect(page.locator('#workspace')).toBeFocused();
  await entry.getByRole('button', { name: '作品を管理・保存する' }).click();
  const panel = page.getByRole('region', { name: '作品の保存と復元', exact: true });
  await expect(panel.getByRole('region', { name: '保存方法の選び方' })).toContainText(
    '音声は含みません',
  );
  await panel.getByRole('button', { name: '台本音声の保存へ進む' }).click();
  await expect(page.locator('#production-audio-storage > summary')).toBeFocused();
  await expect(
    page.getByRole('button', { name: '台本音声をブラウザに保存', exact: true }),
  ).toBeVisible();
  await entry.getByRole('button', { name: '保存・再開へ進む' }).click();
  await expect(page.locator('#project-management > summary')).toBeFocused();
  await panel.getByLabel('保存する作品名').fill('星読みの塔');
  await panel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  await expect(entry).toContainText('現在の作品：星読みの塔');
  await expect(entry).toContainText('ブラウザに保存済みです');
  await panel.getByLabel('保存する作品名').fill('星読みの塔・改稿');
  await expect(entry).toContainText('未保存の変更があります');
  await entry.getByRole('button', { name: '台本へ進む' }).click();
  await entry.getByRole('button', { name: '作品を管理・保存する' }).click();
  await expect(panel.getByLabel('保存する作品名')).toHaveValue('星読みの塔・改稿');
  expect(synthesis).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
