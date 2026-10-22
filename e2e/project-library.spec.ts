import { test, expect, type Page } from '@playwright/test';
import { projectFixture } from '../tests/fixtures/project';
import { projectStorageKey, projectLibraryStorageKey } from '../shared/project';
async function open(page: Page) {
  await page.goto('/');
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  return page.getByRole('region', { name: '作品の保存と復元', exact: true });
}
test('creates, protects unsaved edits, switches, renames, duplicates and deletes projects independently', async ({
  page,
}, testInfo) => {
  await page.addInitScript(
    ({ key, data }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, data);
    },
    { key: projectStorageKey, data: JSON.stringify(projectFixture()) },
  );
  let panel = await open(page);
  await panel.getByLabel('保存する作品名').fill('作品Aの未保存名');
  await panel.getByRole('button', { name: '新しい作品を作成', exact: true }).click();
  await panel.getByRole('button', { name: '確認した作品を復元', exact: true }).click();
  await expect(panel.getByRole('group', { name: '作品の未保存変更の確認' })).toBeVisible();
  await panel.getByRole('button', { name: '作品の切り替えをキャンセル', exact: true }).click();
  await expect(panel.getByLabel('保存する作品名')).toHaveValue('作品Aの未保存名');
  await panel.getByRole('button', { name: '新しい作品を作成', exact: true }).click();
  await panel.getByRole('button', { name: '確認した作品を復元', exact: true }).click();
  await panel.getByRole('button', { name: '保存して作品を切り替える', exact: true }).click();
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  panel = page.getByRole('region', { name: '作品の保存と復元', exact: true });
  await panel.getByLabel('保存する作品名').fill('作品B');
  await panel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  await expect(panel.getByRole('listitem', { name: '保存作品 作品B', exact: true })).toBeVisible();
  const first = panel.getByRole('listitem', { name: '保存作品 作品Aの未保存名', exact: true });
  await first.getByRole('button', { name: 'この作品を開く', exact: true }).click();
  await panel.getByRole('button', { name: '確認した作品を復元', exact: true }).click();
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  await expect(panel.getByLabel('保存する作品名')).toHaveValue('作品Aの未保存名');
  const second = panel.getByRole('listitem', { name: '保存作品 作品B', exact: true });
  await second.getByRole('button', { name: '作品名を変更', exact: true }).click();
  await second.getByLabel('変更後の作品名').fill('作品B改');
  await second.getByRole('button', { name: '作品名の変更を保存', exact: true }).click();
  await expect(
    panel.getByRole('listitem', { name: '保存作品 作品B改', exact: true }),
  ).toBeVisible();
  await first.getByRole('button', { name: '保存済みの作品を複製', exact: true }).click();
  await panel.getByRole('button', { name: '確認した作品を復元', exact: true }).click();
  if (
    await panel
      .getByRole('button', { name: '未保存の変更を破棄して切り替える', exact: true })
      .isVisible()
  )
    await panel
      .getByRole('button', { name: '未保存の変更を破棄して切り替える', exact: true })
      .click();
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  await expect(panel.getByLabel('保存する作品名')).toHaveValue('作品Aの未保存名（コピー）');
  await panel.getByLabel('作品ライブラリの検索').fill('B改');
  await expect(panel.getByRole('listitem')).toHaveCount(1);
  await panel.getByRole('button', { name: 'この作品を削除', exact: true }).click();
  await panel.getByRole('button', { name: '確認した作品を削除', exact: true }).click();
  await expect(panel.getByRole('listitem')).toHaveCount(0);
  await panel.getByLabel('作品ライブラリの検索').fill('');
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await panel.screenshot({ path: testInfo.outputPath('project-library.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const library = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    projectLibraryStorageKey,
  );
  expect(
    library.projects.every(
      (p: { documents: { script: { lines: unknown[] } | null } }) =>
        p.documents.script?.lines.length === 2,
    ),
  ).toBe(true);
  await page.reload();
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  await expect(panel.getByLabel('保存する作品名')).toHaveValue('作品Aの未保存名（コピー）');
});
