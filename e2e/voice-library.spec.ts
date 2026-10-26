import { test, expect, type Page, type Locator } from '@playwright/test';
import { makeCastingEvaluation, makeCastingSession } from '../tests/fixtures/casting';
import { makeLibraryEntry, serializeLibrary, libraryStorageKey } from '../shared/voice-library';
import { castingKey } from '../shared/casting';
import { makeCastingDataset } from '../shared/casting-dataset';

const record = makeCastingEvaluation();
function file(value: unknown) {
  return {
    name: 'library.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
  };
}
async function open(page: Page) {
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: record.recordedAt,
        engines: [
          { engine: 'VOICEVOX', ready: true, detail: '接続済み' },
          { engine: 'AivisSpeech', ready: true, detail: '接続済み' },
        ],
        voices: record.candidates.map((c) => c.voice),
      },
    }),
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await expect(page.locator('#casting-A')).toBeVisible();
  return page.getByRole('region', { name: '製品横断の比較', exact: true });
}
async function exported(page: Page, region: Locator, button: string) {
  const event = page.waitForEvent('download');
  await region.getByRole('button', { name: button, exact: true }).click();
  const stream = await (await event).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}

test('registers adopted voice, persists edits across reload and reuses native tuning without changing history', async ({
  page,
}) => {
  let posts = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST') posts++;
  });
  const workspace = await open(page);
  await workspace
    .getByLabel('比較セッションJSONファイル')
    .setInputFiles(file(makeCastingSession([record])));
  await workspace.getByText('製品比較の履歴を見る', { exact: true }).click();
  await workspace.getByRole('button', { name: '採用声を登録', exact: true }).click();
  const library = page.getByRole('region', { name: '採用声ライブラリ', exact: true });
  await library.getByLabel('ライブラリのキャラクター名').fill('案内人');
  await library.getByLabel('ライブラリの設定名').fill('通常');
  await library.getByLabel('ライブラリのメモ').fill('落ち着いた場面');
  await library.getByRole('button', { name: '採用声をライブラリに保存', exact: true }).click();
  await library.getByLabel('ライブラリの設定名').fill('囁きの演技');
  await library.getByRole('button', { name: '採用声の編集を保存', exact: true }).click();
  const saved = await exported(page, library, '採用声ライブラリJSONを保存');
  expect(saved.entries[0].evaluation).toEqual(record);
  await page.reload();
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await expect(library.getByText('案内人 / 囁きの演技', { exact: true })).toBeVisible();
  await workspace
    .getByLabel('比較セッションJSONファイル')
    .setInputFiles(file(makeCastingSession([record])));
  await page.locator('#casting-A-tempoDynamicsScale').fill('1.8');
  await library.getByRole('button', { name: '候補Bに読み込む', exact: true }).click();
  await expect(library.getByRole('alert')).toContainText('もう一方');
  await expect(page.locator('#casting-A-tempoDynamicsScale')).toHaveValue('1.8');
  await library.getByRole('button', { name: '候補Aに読み込む', exact: true }).click();
  await expect(page.locator('#casting-A-tempoDynamicsScale')).toHaveValue('0.72');
  const session = await exported(page, workspace, '比較セッションJSONを保存');
  expect(session.evaluations).toEqual([record]);
  expect(session.comparisonKeys[1]).toBe(castingKey(record.candidates[1].voice));
  expect(session.comparisonContext.profile.pitch).toBe(17);
  expect(posts).toBe(0);
});

test('imports atomically, filters, retains offline voices and confirms deletion', async ({
  page,
}) => {
  await open(page);
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  const library = page.getByRole('region', { name: '採用声ライブラリ', exact: true });
  const a = makeLibraryEntry(record, '案内人', '通常', '');
  const b = makeLibraryEntry(makeCastingEvaluation({ outcome: 'b' }), '騎士', '戦闘', '');
  const input = library.getByLabel('採用声ライブラリJSONファイル');
  const payload = JSON.parse(serializeLibrary([a, b]));
  await input.setInputFiles(file(payload));
  await input.setInputFiles(file(payload));
  await expect(library.getByRole('status').filter({ hasText: '採用声：2件' })).toBeVisible();
  await library.getByLabel('採用声の製品').selectOption('VOICEVOX');
  await expect(library.getByText('騎士 / 戦闘', { exact: true })).toBeVisible();
  await expect(library.getByText('案内人 / 通常', { exact: true })).toBeHidden();
  await library.getByLabel('採用声の製品').selectOption('');
  await library.getByLabel('採用声を検索').fill('案内');
  await expect(library.getByText('騎士 / 戦闘', { exact: true })).toBeHidden();
  await library.getByLabel('採用声を検索').fill('');
  await input.setInputFiles(file({ ...payload, entries: [a, { ...b, characterName: '競合' }] }));
  await expect(library.getByRole('alert')).toBeVisible();
  expect((await exported(page, library, '採用声ライブラリJSONを保存')).entries).toEqual([a, b]);
  await input.setInputFiles(file({ ...payload, version: 99 }));
  expect((await exported(page, library, '採用声ライブラリJSONを保存')).entries).toHaveLength(2);
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: record.recordedAt,
        engines: [{ engine: 'AivisSpeech', ready: true, detail: '接続済み' }],
        voices: [],
      },
    }),
  );
  await page.getByRole('button', { name: '比較用の接続を再確認', exact: true }).click();
  await expect(library.getByText(/AivisSpeech.*未導入/)).toBeVisible();
  const knight = library.locator('li').filter({ hasText: '騎士 / 戦闘' });
  await knight.getByRole('button', { name: '登録を削除', exact: true }).click();
  await knight.getByRole('button', { name: '削除を取り消す', exact: true }).click();
  await expect(knight).toBeVisible();
  await knight.getByRole('button', { name: '登録を削除', exact: true }).click();
  await knight.getByRole('button', { name: 'この登録を削除する', exact: true }).click();
  await expect(library.getByRole('status').filter({ hasText: '採用声：1件' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('registers from archived evaluations and reports storage failure without losing existing entries', async ({
  page,
}) => {
  const workspace = await open(page);
  await workspace.getByRole('button', { name: '製品比較の履歴を集計する', exact: true }).click();
  const archive = page.getByRole('region', { name: '製品比較の履歴集計', exact: true });
  await archive
    .getByLabel('製品比較集計用JSONファイル')
    .setInputFiles(file(makeCastingDataset([record])));
  await archive.getByRole('button', { name: '採用声を登録', exact: true }).click();
  const library = page.getByRole('region', { name: '採用声ライブラリ', exact: true });
  await library.getByLabel('ライブラリのキャラクター名').fill('保存できない声');
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('容量不足', 'QuotaExceededError');
    };
  });
  await library.getByRole('button', { name: '採用声をライブラリに保存', exact: true }).click();
  await expect(library.getByRole('alert')).toBeVisible();
  await expect(library.getByRole('status').filter({ hasText: '採用声：0件' })).toBeVisible();
  expect(await page.evaluate((key) => localStorage.getItem(key), libraryStorageKey)).toBeNull();
});

test('keeps corrupt browser data untouched until an explicit valid import recovers the library', async ({
  page,
}, testInfo) => {
  await page.addInitScript((key) => localStorage.setItem(key, '{broken'), libraryStorageKey);
  await open(page);
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  const library = page.getByRole('region', { name: '採用声ライブラリ', exact: true });
  await expect(library.getByRole('alert')).toContainText('上書きしていません');
  expect(await page.evaluate((key) => localStorage.getItem(key), libraryStorageKey)).toBe(
    '{broken',
  );
  const entry = makeLibraryEntry(record, '案内人', '通常', '再利用する採用声');
  await library
    .getByLabel('採用声ライブラリJSONファイル')
    .setInputFiles(file(JSON.parse(serializeLibrary([entry]))));
  await expect(library.getByRole('alert')).toHaveCount(0);
  await library.getByRole('button', { name: '登録を編集', exact: true }).click();
  await library.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await library.screenshot({ path: testInfo.outputPath('voice-library.png') });
});
