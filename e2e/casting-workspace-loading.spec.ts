import { test, expect } from '@playwright/test';
import { projectFixture } from '../tests/fixtures/project';

const chunk = '**/assets/CastingWorkspace-*.js';

test('navigates to the script after a slow casting workspace chunk arrives', async ({ page }) => {
  await page.route(chunk, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.goto('/');
  const entry = page.getByRole('region', { name: '制作の入口', exact: true });
  await entry.getByRole('button', { name: '台本へ進む' }).click();
  await expect(page.locator('#production-script > summary')).toBeFocused();
});

test('does not ask to keep changes on an untouched page after the chunk arrives', async ({
  page,
}) => {
  await page.route(chunk, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.goto('/');
  await expect(page.locator('.casting-workspace')).toBeAttached();
  await page.waitForTimeout(2500);
  await page
    .getByRole('region', { name: '制作の入口', exact: true })
    .getByRole('button', { name: '作品を管理・保存する' })
    .click();
  await page.getByLabel('作品JSONファイル', { exact: true }).setInputFiles({
    name: 'project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(projectFixture())),
  });
  await page.getByRole('button', { name: '確認した作品を復元', exact: true }).click();
  await expect(page.getByRole('group', { name: '作品の未保存変更の確認' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '制作の入口', exact: true })).toContainText(
    'ブラウザに保存済みです',
  );
});

test('keeps the page usable when the casting workspace chunk fails', async ({ page }) => {
  await page.route(chunk, (route) => route.abort());
  await page.goto('/');
  await expect(page.getByRole('button', { name: '凛と、落ち着いて' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('製品比較と台本の画面を読み込めませんでした');
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: '作品をブラウザに保存', exact: true }),
  ).toBeDisabled();
});
