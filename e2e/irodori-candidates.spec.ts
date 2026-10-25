import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const localSamples = resolve('.local-artifacts/irodori-v41-voice-design-20261024');

test('selects generated voices and restores the choices from a saved project', async ({ page }) => {
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Irodori生成済みの声を比較' });
  await expect(panel.getByRole('heading', { name: '生成済みの3つの声を比較' })).toBeVisible();
  await panel.getByRole('button', { name: '作品の候補に保存' }).first().click();
  await expect(panel.getByText('この作品の候補：1件 / 3件')).toBeVisible();
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  await page.getByRole('button', { name: '作品をブラウザに保存' }).click();
  await page.reload();
  await expect(panel.getByText('この作品の候補：1件 / 3件')).toBeVisible();
  const saved = await page.evaluate(
    () =>
      localStorage.getItem('voice-atlas-project-library-v1') ??
      localStorage.getItem('voice-atlas-project-v1'),
  );
  expect(saved).toContain('old_mage');
});

test('loads the existing verified WAVs and keeps them after reload', async ({ page }) => {
  test.skip(!existsSync(resolve(localSamples, 'sample_20261024_074100_778062_001.wav')));
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Irodori生成済みの声を比較' });
  await panel.getByRole('button', { name: 'この端末の検証音声を読み込む' }).click();
  await expect(panel.getByText('6件の検証音声をブラウザに保存しました。')).toBeVisible();
  await expect(panel.locator('audio')).toHaveCount(6);
  await page.reload();
  await expect(panel.locator('audio')).toHaveCount(6);
});

test('keeps provisional character casting with its selected voice', async ({ page }) => {
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Irodori生成済みの声を比較' });
  await panel.getByRole('button', { name: '作品の候補に保存' }).first().click();
  await panel.getByRole('textbox', { name: '仮配役のキャラクター名' }).fill('長老');
  await panel.getByRole('combobox', { name: '仮配役の候補声' }).selectOption('old_mage');
  await panel.getByRole('textbox', { name: '仮配役の理由' }).fill('低い声が合う');
  await panel.getByRole('button', { name: '仮配役を保存' }).click();
  await expect(panel.getByRole('heading', { name: '長老：老魔術師' })).toBeVisible();
  await panel.getByRole('button', { name: '候補から外す' }).click();
  await expect(panel.getByRole('alert')).toContainText('先に仮配役を変更または削除');
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  await page.getByRole('button', { name: '作品をブラウザに保存' }).click();
  await page.reload();
  await expect(panel.getByRole('heading', { name: '長老：老魔術師' })).toBeVisible();
  await expect(panel.getByText('理由：低い声が合う')).toBeVisible();
  const saved = await page.evaluate(
    () =>
      localStorage.getItem('voice-atlas-project-library-v1') ??
      localStorage.getItem('voice-atlas-project-v1'),
  );
  expect(saved).toContain('irodoriAssignments');
  expect(saved).toContain('長老');
  await panel.getByRole('button', { name: '編集', exact: true }).click();
  await panel.getByRole('textbox', { name: '仮配役の理由' }).fill('別の場面にも合う');
  await panel.getByRole('button', { name: '仮配役を更新' }).click();
  await expect(panel.getByText('理由：別の場面にも合う')).toBeVisible();
  await panel.getByRole('button', { name: '削除', exact: true }).click();
  await expect(panel.getByText('仮配役はまだありません。')).toBeVisible();
  await panel.getByRole('button', { name: '候補から外す' }).click();
  await expect(panel.getByText('この作品の候補：0件 / 3件')).toBeVisible();
});

test('compares voices for a character and decides the provisional cast', async ({ page }) => {
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Irodori生成済みの声を比較' });
  await panel.getByRole('button', { name: '作品の候補に保存' }).first().click();
  await panel.getByRole('button', { name: '作品の候補に保存' }).first().click();
  const comparison = panel.getByRole('region', { name: 'キャラクターごとのIrodori比較' });
  await comparison.getByRole('textbox', { name: '比較するキャラクター名' }).fill('長老');
  await comparison.getByRole('checkbox', { name: '老魔術師' }).check();
  await comparison.getByRole('checkbox', { name: '企業幹部' }).check();
  await expect(comparison.getByRole('heading', { name: '老魔術師' })).toBeVisible();
  await expect(comparison.getByRole('heading', { name: '企業幹部' })).toBeVisible();
  await comparison.getByRole('textbox', { name: 'Irodoriの比較メモ' }).fill('落ち着いた声を採用');
  await comparison.getByRole('button', { name: '比較メモを保存' }).click();
  await expect(comparison.getByText('比較メモ：落ち着いた声を採用')).toBeVisible();
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  await page.getByRole('button', { name: '作品をブラウザに保存' }).click();
  await page.reload();
  await expect(comparison.getByText('比較メモ：落ち着いた声を採用')).toBeVisible();
  await comparison.getByRole('button', { name: '比較を開く' }).click();
  await comparison.getByRole('button', { name: 'この声に仮配役' }).first().click();
  await expect(panel.getByRole('heading', { name: '長老：老魔術師' })).toBeVisible();
  await expect(comparison.getByText('現在の仮配役：老魔術師')).toBeVisible();
  await panel.getByRole('button', { name: '候補から外す' }).nth(1).click();
  await expect(panel.getByRole('alert')).toContainText('比較記録');
});
