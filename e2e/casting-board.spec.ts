import { test, expect, type Page } from '@playwright/test';
import { makeLibraryEntry } from '../shared/voice-library';
import {
  makeLibraryComparisonRecord,
  libraryComparisonStorageKey,
  serializeLibraryComparison,
} from '../shared/library-comparison';
import {
  castingBoardStorageKey,
  makeCastingAssignment,
  serializeCastingBoard,
} from '../shared/casting-board';
import { makeCastingEvaluation } from '../tests/fixtures/casting';

const a = makeLibraryEntry(makeCastingEvaluation(), '案内人', '通常', '');
const b = makeLibraryEntry(makeCastingEvaluation({ outcome: 'b' }), '案内人', '威厳', '');
const record = makeLibraryComparisonRecord({
  entries: [a, b],
  text: '確定時の比較セリフ',
  scene: '導入',
  reason: '案内が聞き取りやすい',
  selectedId: a.id,
  auditions: [{ generation: null }, { generation: null }],
});
const file = (text: string) => ({
  name: 'casting.json',
  mimeType: 'application/json',
  buffer: Buffer.from(text),
});
async function open(page: Page) {
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({ json: { checkedAt: record.recordedAt, engines: [], voices: [] } }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({ json: { ready: false, checkedAt: record.recordedAt, models: [] } }),
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  return page.getByRole('region', { name: 'キャスティング表', exact: true });
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ key, value }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    {
      key: libraryComparisonStorageKey,
      value: serializeLibraryComparison({
        format: 'voice-atlas-library-comparison',
        version: 1,
        createdAt: record.recordedAt,
        entries: null,
        text: '',
        scene: '',
        reason: '',
        selectedId: null,
        records: [record],
      }),
    },
  );
});
test('assigns, confirms replacement, restores after reload and loads native settings without synthesis', async ({
  page,
}, testInfo) => {
  let calls = 0;
  await page.route('**/api/casting/preview', (route) => {
    calls++;
    return route.abort();
  });
  let board = await open(page);
  await board.getByLabel('キャスティングの比較記録').selectOption(record.id);
  await board.getByLabel('キャスティングの作品名').fill('物語');
  await board.getByRole('button', { name: 'キャスティングを確定して保存', exact: true }).click();
  await expect(board.getByText('物語 / 案内人 / 導入', { exact: true })).toBeVisible();
  await expect(board.getByText('選択理由：案内が聞き取りやすい')).toBeVisible();
  await board.getByRole('button', { name: 'キャスティングを確定して保存', exact: true }).click();
  await expect(board.getByRole('button', { name: 'この場面の確定設定を置き換える' })).toBeVisible();
  await board.getByRole('button', { name: '置き換えを取り消す' }).click();
  await board.getByRole('button', { name: 'キャスティングを確定して保存', exact: true }).click();
  await board.getByRole('button', { name: 'この場面の確定設定を置き換える' }).click();
  await expect(board.getByText('キャスティング：1件 / 登録1件')).toBeVisible();
  await page.reload();
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  board = page.getByRole('region', { name: 'キャスティング表', exact: true });
  await expect(board.getByText('物語 / 案内人 / 導入', { exact: true })).toBeVisible();
  await board.getByLabel('キャスティング表を検索').fill('別作品');
  await expect(board.getByText('キャスティング：0件 / 登録1件')).toBeVisible();
  await board.getByLabel('キャスティング表を検索').fill('物語');
  await board.getByText('確定時の設定・生成情報', { exact: true }).click();
  await board.scrollIntoViewIfNeeded();
  await board.screenshot({ path: testInfo.outputPath('casting-board.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await board.getByRole('button', { name: '確定設定を候補Aに読み込む', exact: true }).click();
  await expect(board.getByRole('status').filter({ hasText: '確定した設定を候補A' })).toBeVisible();
  const stored = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    castingBoardStorageKey,
  );
  expect(stored.assignments[0].comparison.entries[0].id).toBe(a.id);
  expect(calls).toBe(0);
});
test('imports atomically, rejects conflicting data and storage failure, exports and deletes explicitly', async ({
  page,
}) => {
  const board = await open(page);
  const item = makeCastingAssignment(record, '作品', '役', '説明');
  await board
    .getByLabel('キャスティング表JSONファイル')
    .setInputFiles(file(serializeCastingBoard([item])));
  await expect(board.getByText('作品 / 役 / 説明', { exact: true })).toBeVisible();
  await board
    .getByLabel('キャスティング表JSONファイル')
    .setInputFiles(
      file(serializeCastingBoard([{ ...item, comparison: { ...record, reason: '競合' } }])),
    );
  await expect(board.getByRole('alert')).toContainText('競合');
  await expect(board.getByText('選択理由：案内が聞き取りやすい')).toBeVisible();
  await board.getByLabel('キャスティング表JSONファイル').setInputFiles(file('{"version":99}'));
  await expect(board.getByText('キャスティング：1件 / 登録1件')).toBeVisible();
  const downloadEvent = page.waitForEvent('download');
  await board.getByRole('button', { name: 'キャスティング表JSONを保存', exact: true }).click();
  const stream = await (await downloadEvent).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString()).assignments).toEqual([item]);
  await board.getByRole('button', { name: '確定設定を削除', exact: true }).click();
  await board.getByRole('button', { name: '削除を取り消す' }).click();
  await expect(board.getByText('キャスティング：1件 / 登録1件')).toBeVisible();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
  });
  await board.getByRole('button', { name: '確定設定を削除', exact: true }).click();
  await board.getByRole('button', { name: 'この確定設定を削除する' }).click();
  await expect(board.getByRole('alert')).toContainText('保持');
  await expect(board.getByText('キャスティング：1件 / 登録1件')).toBeVisible();
  await page.reload();
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await board.getByRole('button', { name: '確定設定を削除', exact: true }).click();
  await board.getByRole('button', { name: 'この確定設定を削除する' }).click();
  await expect(board.getByText('キャスティング：0件 / 登録0件')).toBeVisible();
});
