import { test, expect, type Page, type Locator } from '@playwright/test';
import { scriptFixture } from '../tests/fixtures/script';
import { pcmWav } from '../tests/fixtures/wav';
import { serializeScript, scriptCandidate } from '../shared/script';
import {
  makeScriptLibraryEntry,
  serializeScriptLibrary,
  scriptLibraryStorageKey,
} from '../shared/script-library';
const fixture = scriptFixture();
const source = makeScriptLibraryEntry(fixture.script, '物語', '導入');
const file = (value: unknown) => ({
  name: 'scripts.json',
  mimeType: 'application/json',
  buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
});
async function expand(page: Page) {
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
}
async function open(page: Page, importDraft = true) {
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: source.createdAt,
        engines: [
          { engine: 'AivisSpeech', ready: true, detail: '接続済み' },
          { engine: 'VOICEVOX', ready: true, detail: '接続済み' },
        ],
        voices: fixture.script.lines.map((line) => scriptCandidate(line)!.voice),
      },
    }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({ json: { ready: false, checkedAt: source.createdAt, models: [] } }),
  );
  await page.goto('/');
  await expand(page);
  const panel = page.getByRole('region', { name: '台本の試聴', exact: true });
  const library = panel.getByRole('region', { name: '台本ライブラリ', exact: true });
  if (importDraft) {
    await panel
      .getByLabel('台本JSONファイル', { exact: true })
      .setInputFiles(file(serializeScript(fixture.script)));
    await expect(panel.getByLabel('台本名', { exact: true })).toHaveValue('導入の会話');
  }
  return { panel, library };
}
async function exported(page: Page, library: Locator) {
  const event = page.waitForEvent('download');
  await library.getByRole('button', { name: '台本ライブラリJSONを保存', exact: true }).click();
  const stream = await (await event).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}
function row(library: Locator, title: string) {
  return library
    .locator(':scope > ol > li')
    .filter({ has: library.page().getByText(title, { exact: true }) });
}
test('saves, duplicates and switches scripts with save/discard/cancel protection and independent audio/settings', async ({
  page,
}, testInfo) => {
  let calls = 0;
  await page.route('**/api/casting/preview', (route) => {
    calls++;
    return route.fulfill({
      contentType: 'audio/wav',
      body: Buffer.from(pcmWav(Array(2400).fill(1000))),
    });
  });
  const { panel, library } = await open(page);
  await library.getByLabel('台本ライブラリの作品名').fill('物語');
  await library.getByLabel('台本ライブラリの場面名').fill('導入');
  await panel.getByLabel('結合WAVの行間', { exact: true }).fill('725');
  await library.getByRole('button', { name: '台本ライブラリに保存', exact: true }).click();
  await expect(library.getByText('物語 / 導入 / 導入の会話', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await row(library, '物語 / 導入 / 導入の会話')
    .getByRole('button', { name: 'この保存台本を複製', exact: true })
    .click();
  await expect(panel.getByLabel('台本名', { exact: true })).toHaveValue('導入の会話（コピー）');
  await expect(panel.locator('audio')).toHaveCount(0);
  await expect(panel.getByLabel('結合WAVの行間', { exact: true })).toHaveValue('725');
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('複製側のセリフ');
  const url = await panel.locator(':scope > ol audio').getAttribute('src');
  await row(library, '物語 / 導入 / 導入の会話')
    .getByRole('button', { name: 'この台本を開く', exact: true })
    .click();
  await expect(library.getByRole('group', { name: '台本の未保存変更の確認' })).toBeVisible();
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toBeDisabled();
  await library.getByRole('button', { name: '台本の切り替えをキャンセル', exact: true }).click();
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('複製側のセリフ');
  await expect(panel.locator(':scope > ol audio')).toHaveAttribute('src', url!);
  await row(library, '物語 / 導入 / 導入の会話')
    .getByRole('button', { name: 'この台本を開く', exact: true })
    .click();
  await library.getByRole('button', { name: '台本を保存して切り替える', exact: true }).click();
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('ようこそ。');
  await expect(panel.locator('audio')).toHaveCount(0);
  const saved = await exported(page, library);
  expect(saved.entries).toHaveLength(2);
  expect(saved.entries[0].script.lines[0].text).toBe('ようこそ。');
  expect(saved.entries[1].script.lines[0].text).toBe('複製側のセリフ');
  await library.getByLabel('台本ライブラリを検索').fill('コピー');
  await expect(library.getByText('台本ライブラリ：1件 / 登録2件')).toBeVisible();
  await library.screenshot({ path: testInfo.outputPath('script-library.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await library.getByLabel('台本ライブラリを検索').fill('');
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('保存しない変更');
  await library.getByRole('button', { name: '新しい台本を作る', exact: true }).click();
  await library.getByRole('button', { name: '台本を保存せず切り替える', exact: true }).click();
  await expect(panel.getByLabel('台本名', { exact: true })).toHaveValue('');
  await page.reload();
  await expand(page);
  await expect(library.getByText('台本ライブラリ：2件 / 登録2件')).toBeVisible();
  await row(library, '物語 / 導入 / 導入の会話（コピー）')
    .getByRole('button', { name: 'この台本を開く', exact: true })
    .click();
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('複製側のセリフ');
  expect(calls).toBe(4);
});
test('merges library backups atomically and retains dirty work after quota failure or canceled single-script import', async ({
  page,
}) => {
  const { panel, library } = await open(page);
  await library
    .getByLabel('台本ライブラリJSONファイル', { exact: true })
    .setInputFiles(file(serializeScriptLibrary([source])));
  await expect(library.getByText('台本ライブラリ：1件 / 登録1件')).toBeVisible();
  await library
    .getByLabel('台本ライブラリJSONファイル', { exact: true })
    .setInputFiles(file(serializeScriptLibrary([source])));
  await expect(library.getByText('台本ライブラリ：1件 / 登録1件')).toBeVisible();
  const other = { ...source, id: crypto.randomUUID(), scene: '追加候補' };
  await library
    .getByLabel('台本ライブラリJSONファイル', { exact: true })
    .setInputFiles(file(serializeScriptLibrary([other, { ...source, scene: '競合' }])));
  await expect(library.getByRole('alert')).toContainText('競合');
  await expect(library.getByText('台本ライブラリ：1件 / 登録1件')).toBeVisible();
  await library
    .getByLabel('台本ライブラリJSONファイル', { exact: true })
    .setInputFiles(file({ format: 'voice-atlas-script-library', version: 2, entries: [] }));
  await expect(library.getByText('台本ライブラリ：1件 / 登録1件')).toBeVisible();
  await library.getByRole('button', { name: 'この台本を開く', exact: true }).click();
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('編集中の変更');
  await panel
    .getByLabel('台本JSONファイル', { exact: true })
    .setInputFiles(file({ ...fixture.script, title: '別台本' }));
  await expect(library.getByRole('group', { name: '台本の未保存変更の確認' })).toBeVisible();
  await library.getByRole('button', { name: '台本の切り替えをキャンセル', exact: true }).click();
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('編集中の変更');
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
  });
  await library.getByRole('button', { name: '新しい台本を作る', exact: true }).click();
  await library.getByRole('button', { name: '台本を保存して切り替える', exact: true }).click();
  await expect(library.getByRole('alert')).toContainText('保持');
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('編集中の変更');
  await library.getByRole('button', { name: '台本の切り替えをキャンセル', exact: true }).click();
  const saved = await exported(page, library);
  expect(saved.entries[0].script.lines[0].text).toBe('ようこそ。');
  await library
    .getByLabel('台本ライブラリJSONファイル', { exact: true })
    .setInputFiles(file(serializeScriptLibrary([other])));
  await expect(library.getByRole('alert')).toContainText('保持');
  await expect(library.getByText('台本ライブラリ：1件 / 登録1件')).toBeVisible();
});
test('preserves corrupt storage until explicit recovery and confirms deletion without deleting the editor', async ({
  page,
}) => {
  await page.addInitScript((key) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, '{broken');
  }, scriptLibraryStorageKey);
  const { panel, library } = await open(page, false);
  await expect(library.getByRole('alert')).toContainText('上書きしていません');
  expect(await page.evaluate((key) => localStorage.getItem(key), scriptLibraryStorageKey)).toBe(
    '{broken',
  );
  await library
    .getByLabel('台本ライブラリJSONファイル', { exact: true })
    .setInputFiles(file(serializeScriptLibrary([source])));
  await expect(library.getByRole('alert')).toHaveCount(0);
  await library.getByRole('button', { name: 'この台本を開く', exact: true }).click();
  await library.getByRole('button', { name: '保存台本を削除', exact: true }).click();
  await library.getByRole('button', { name: '台本の削除を取り消す', exact: true }).click();
  await expect(library.getByText('台本ライブラリ：1件 / 登録1件')).toBeVisible();
  await library.getByRole('button', { name: '保存台本を削除', exact: true }).click();
  await library.getByRole('button', { name: 'この保存台本を削除する', exact: true }).click();
  await expect(library.getByText('台本ライブラリ：0件 / 登録0件')).toBeVisible();
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('ようこそ。');
  await library.getByRole('button', { name: '新しい台本を作る', exact: true }).click();
  await expect(library.getByRole('group', { name: '台本の未保存変更の確認' })).toBeVisible();
  await library.getByRole('button', { name: '台本の切り替えをキャンセル', exact: true }).click();
  const entries = Array.from({ length: 30 }, (_, index) => ({
    ...source,
    id: crypto.randomUUID(),
    scene: String(index),
  }));
  await library
    .getByLabel('台本ライブラリJSONファイル', { exact: true })
    .setInputFiles(file(serializeScriptLibrary(entries)));
  await expect(library.getByText('台本ライブラリ：30件 / 登録30件')).toBeVisible();
  await expect(
    library.getByRole('button', { name: '台本ライブラリに保存', exact: true }),
  ).toBeDisabled();
  await expect(
    library.getByRole('button', { name: 'この保存台本を複製', exact: true }).first(),
  ).toBeDisabled();
});
