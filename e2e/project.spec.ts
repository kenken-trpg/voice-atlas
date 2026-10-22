import { test, expect, type Page } from '@playwright/test';
import { projectFixture } from '../tests/fixtures/project';
import { projectStorageKey, projectLibraryStorageKey } from '../shared/project';
import { scriptStorageKey, serializeScript } from '../shared/script';
import { scriptLibraryStorageKey } from '../shared/script-library';
import { scriptFixture } from '../tests/fixtures/script';
import { makeCastingEvaluation, makeCastingSession } from '../tests/fixtures/casting';
import { castingSessionSchema } from '../shared/casting';

const offline = {
  checkedAt: '2026-10-22T00:00:00Z',
  engines: [
    { engine: 'VOICEVOX', ready: false, detail: '未接続' },
    { engine: 'AivisSpeech', ready: false, detail: '未接続' },
  ],
  voices: [],
};
async function open(page: Page) {
  await page.route('**/api/casting/voices', (route) => route.fulfill({ json: offline }));
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({ json: { ready: false, checkedAt: offline.checkedAt, models: [] } }),
  );
  await page.goto('/');
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  return page.getByRole('region', { name: '作品の保存と復元', exact: true });
}
async function readDownload(page: Page, action: () => Promise<unknown>) {
  const event = page.waitForEvent('download');
  await action();
  const stream = await (await event).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function storedProject(page: Page) {
  return page.evaluate(
    ({ single, library }) => {
      const text = localStorage.getItem(library);
      if (text !== null) {
        const value = JSON.parse(text);
        return value.projects.find((p: { id: string }) => p.id === value.activeId) ?? null;
      }
      const raw = localStorage.getItem(single);
      return raw === null ? null : JSON.parse(raw);
    },
    { single: projectStorageKey, library: projectLibraryStorageKey },
  );
}
async function inspect(page: Page, value: unknown) {
  await page.getByLabel('作品JSONファイル', { exact: true }).setInputFiles({
    name: 'project.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  });
}
test('backs up live voice discovery and restores it in a clean browser context without synthesis', async ({
  page,
  browser,
}, testInfo) => {
  const panel = await open(page);
  await panel.getByLabel('保存する作品名').fill('NPCの声を準備');
  await page.getByRole('button', { name: '凛と、落ち着いて' }).click();
  await page.getByLabel('ソフトで絞り込む').selectOption('VOICEVOX');
  await page.locator('#recipe-speedScale').fill('0.88');
  await panel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  await expect(panel.getByText('作品はブラウザに保存済みです', { exact: true })).toBeVisible();
  await page.locator('#recipe-speedScale').fill('0.91');
  await expect(panel.getByText('作品に未保存の変更があります', { exact: true })).toBeVisible();
  const saved = await readDownload(page, () =>
    panel.getByRole('button', { name: '作品JSONを書き出す', exact: true }).click(),
  );
  expect(saved.documents.workbench.recipe.parameters.speedScale).toBe(0.91);
  expect(saved.documents.workbench.recipe.image).toBeUndefined();
  await panel.screenshot({ path: testInfo.outputPath('project-panel.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const fresh = await browser.newContext({ viewport: testInfo.project.use.viewport });
  try {
    const other = await fresh.newPage();
    let posts = 0;
    other.on('request', (request) => {
      if (request.method() === 'POST') posts++;
    });
    await open(other);
    await inspect(other, saved);
    await other.getByRole('button', { name: '確認した作品を復元', exact: true }).click();
    await expect(other.locator('#recipe-speedScale')).toHaveValue('0.91');
    await expect(
      other.getByRole('heading', { name: 'あなたの演出に、近い声。', exact: true }),
    ).toBeVisible();
    await other.reload();
    await expect(other.locator('#recipe-speedScale')).toHaveValue('0.91');
    expect(posts).toBe(0);
  } finally {
    await fresh.close();
  }
});
test('reviews and cancels switching, restores casting and scripts, and keeps legacy storage separate', async ({
  page,
}) => {
  const original = serializeScript(scriptFixture().script);
  await page.addInitScript(({ key, text }) => localStorage.setItem(key, text), {
    key: scriptStorageKey,
    text: original,
  });
  const panel = await open(page);
  const fixture = projectFixture();
  fixture.documents.casting = {
    session: castingSessionSchema.parse(makeCastingSession([makeCastingEvaluation()])),
    outcome: 'b',
    reason: 'まだ記録していない比較理由',
  };
  await inspect(page, fixture);
  await expect(panel.getByRole('group', { name: '作品の復元確認' })).toContainText('配役2件');
  await panel.getByRole('button', { name: '作品の復元をキャンセル', exact: true }).click();
  expect(await page.evaluate((key) => localStorage.getItem(key), projectStorageKey)).toBeNull();
  await inspect(page, fixture);
  await panel.getByRole('button', { name: '確認した作品を復元', exact: true }).click();
  expect(await page.evaluate((key) => localStorage.getItem(key), scriptStorageKey)).toBe(original);
  await page.getByRole('button', { name: 'VOICEVOX・AivisSpeechを比較する', exact: true }).click();
  await expect(page.locator('#casting-A-tempoDynamicsScale')).toHaveValue('0.72');
  await expect(page.locator('#casting-reason')).toHaveValue('まだ記録していない比較理由');
  await page.locator('#casting-A-tempoDynamicsScale').fill('0.43');
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  const script = page.getByRole('region', { name: '台本の試聴', exact: true });
  await expect(script.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('ようこそ。');
  await script.getByLabel('第1行のセリフ', { exact: true }).fill('まだ個別保存していないセリフ');
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  const projectPanel = page.getByRole('region', { name: '作品の保存と復元', exact: true });
  await projectPanel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  const saved = await storedProject(page);
  expect(saved.documents.script.lines[0].text).toBe('まだ個別保存していないセリフ');
  expect(saved.documents.casting.session.candidates[0].recipe.tempoDynamicsScale).toBe(0.43);
  expect(
    saved.documents.casting.session.evaluations[0].candidates[0].recipe.tempoDynamicsScale,
  ).toBe(0.72);
  expect(saved.documents.casting.reason).toBe('まだ記録していない比較理由');
  expect(saved.documents.voiceLibrary.entries[0].evaluation.reason).toBe(
    '落ち着きとテンポが合う。',
  );
  await script.getByRole('button', { name: '台本をブラウザに保存', exact: true }).click();
  expect(await page.evaluate((key) => localStorage.getItem(key), scriptStorageKey)).toBe(original);
  await projectPanel.getByRole('button', { name: '以前のブラウザ保存を開く', exact: true }).click();
  await projectPanel.getByRole('button', { name: '確認した作品を復元', exact: true }).click();
  const previous = await storedProject(page);
  expect(previous.name).toBe('以前のブラウザ保存');
  expect(previous.documents.script.lines[0].text).toBe('ようこそ。');
});
test('rejects invalid files and quota failures without replacing the current project or edits', async ({
  page,
}) => {
  const panel = await open(page);
  await panel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  const before = await page.evaluate((key) => localStorage.getItem(key), projectStorageKey);
  const bad = projectFixture();
  bad.documents.script!.lines.push(bad.documents.script!.lines[0]);
  await inspect(page, bad);
  await expect(panel.getByRole('alert')).toContainText('作品JSONを確認できませんでした');
  expect(await page.evaluate((key) => localStorage.getItem(key), projectStorageKey)).toBe(before);
  await page.evaluate(
    (keys) => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (keys.includes(name)) throw new DOMException('full', 'QuotaExceededError');
        set.call(this, name, value);
      };
    },
    [projectStorageKey, projectLibraryStorageKey],
  );
  await panel.getByLabel('保存する作品名').fill('保存できない変更');
  await panel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('保存容量');
  expect(await page.evaluate((key) => localStorage.getItem(key), projectStorageKey)).toBe(before);
  await inspect(page, projectFixture());
  await panel.getByRole('button', { name: '確認した作品を復元', exact: true }).click();
  await panel
    .getByRole('button', { name: '未保存の変更を破棄して切り替える', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText('現在の作業は保持');
  await panel.getByRole('button', { name: '作品の復元をキャンセル', exact: true }).click();
  await expect(panel.getByLabel('保存する作品名')).toHaveValue('保存できない変更');
  const exported = await readDownload(page, () =>
    panel.getByRole('button', { name: '作品JSONを書き出す', exact: true }).click(),
  );
  expect(exported.name).toBe('保存できない変更');
  expect(await page.evaluate((key) => localStorage.getItem(key), projectStorageKey)).toBe(before);
});
test('preserves corrupt saved data and permits recovery only by a reviewed valid project file', async ({
  page,
}) => {
  await page.addInitScript((key) => localStorage.setItem(key, '{broken'), projectStorageKey);
  const panel = await open(page);
  await expect(
    panel.getByRole('alert').filter({ hasText: '保存データは上書きしていません' }),
  ).toBeVisible();
  await panel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  expect(await page.evaluate((key) => localStorage.getItem(key), projectStorageKey)).toBe(
    '{broken',
  );
  await inspect(page, projectFixture());
  await panel.getByRole('button', { name: '確認した作品を復元', exact: true }).click();
  expect(
    JSON.parse((await page.evaluate((key) => localStorage.getItem(key), projectStorageKey))!).name,
  ).toBe('導入シナリオ');
  expect(
    await page.evaluate((key) => localStorage.getItem(key), scriptLibraryStorageKey),
  ).toBeNull();
});

test('keeps another tab from overwriting a newer project while allowing a backup of its own edits', async ({
  page,
}) => {
  const first = await open(page);
  await first.getByLabel('保存する作品名').fill('最初の作品');
  await first.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  const other = await page.context().newPage();
  const second = await open(other);
  await first.getByLabel('保存する作品名').fill('別タブで更新された作品');
  await first.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  await second.getByLabel('保存する作品名').fill('こちらの未保存の編集');
  await second.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  await expect(
    second.getByRole('alert').filter({ hasText: '別のタブで作品が変更' }).first(),
  ).toBeVisible();
  const exported = await readDownload(other, () =>
    second.getByRole('button', { name: '作品JSONを書き出す', exact: true }).click(),
  );
  expect(exported.name).toBe('こちらの未保存の編集');
  expect(
    JSON.parse((await page.evaluate((key) => localStorage.getItem(key), projectStorageKey))!).name,
  ).toBe('別タブで更新された作品');
});
