import { test, expect, type Page, type Locator } from '@playwright/test';
import { scriptFixture } from '../tests/fixtures/script';
import { pcmWav } from '../tests/fixtures/wav';
import { serializeScript, scriptStorageKey, scriptCandidate } from '../shared/script';
import { castingBoardStorageKey, serializeCastingBoard } from '../shared/casting-board';
import { maxScriptImportBytes } from '../shared/script-import';
const fixture = scriptFixture();
const alternate = { ...fixture.assignments[0], id: crypto.randomUUID(), scene: '再会' };
const assignments = [...fixture.assignments, alternate];
async function open(page: Page) {
  await page.addInitScript(
    ({ boardKey, board, scriptKey, script }) => {
      localStorage.setItem(boardKey, board);
      localStorage.setItem(scriptKey, script);
    },
    {
      boardKey: castingBoardStorageKey,
      board: serializeCastingBoard(assignments),
      scriptKey: scriptStorageKey,
      script: serializeScript(fixture.script),
    },
  );
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: alternate.assignedAt,
        engines: [
          { engine: 'AivisSpeech', ready: true, detail: '接続済み' },
          { engine: 'VOICEVOX', ready: true, detail: '接続済み' },
        ],
        voices: fixture.script.lines.map((line) => scriptCandidate(line)!.voice),
      },
    }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({ json: { ready: false, checkedAt: alternate.assignedAt, models: [] } }),
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  const panel = page.getByRole('region', { name: '台本の試聴', exact: true });
  await panel.getByText('テキスト・CSVから台本を取り込む', { exact: true }).click();
  return {
    panel,
    importer: panel.getByRole('region', { name: '台本の一括取り込み', exact: true }),
    library: panel.getByRole('region', { name: '台本ライブラリ', exact: true }),
  };
}
async function exported(page: Page, panel: Locator) {
  const event = page.waitForEvent('download');
  await panel.getByRole('button', { name: '台本JSONを保存', exact: true }).click();
  const stream = await (await event).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}
const csvFile = (buffer: Buffer) => ({ name: 'dialogue.csv', mimeType: 'text/csv', buffer });
test('previews text, resolves scoped names and aliases, fixes invalid lines and protects current audio before application', async ({
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
  const { panel, importer, library } = await open(page);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  const url = await panel.locator(':scope > ol audio').first().getAttribute('src');
  await panel.getByLabel('結合WAVの行間', { exact: true }).fill('600');
  await importer
    .getByLabel('一括取り込みの入力')
    .fill(`案内人：一括の挨拶\n騎士: 返答\nナレーター：${'長'.repeat(301)}`);
  await importer.getByRole('button', { name: '取り込み内容を確認', exact: true }).click();
  await expect(importer.getByLabel('「案内人」に割り当てる声', { exact: true })).toHaveValue('');
  await expect(
    importer.getByRole('button', { name: '確認した内容を台本に反映', exact: true }),
  ).toBeDisabled();
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('ようこそ。');
  await importer.getByLabel('取り込み候補の作品').selectOption('物語');
  await importer.getByLabel('取り込み候補の場面').selectOption('導入');
  await expect(importer.getByLabel('「案内人」に割り当てる声', { exact: true })).toHaveValue(
    fixture.assignments[0].id,
  );
  await importer
    .getByLabel('「ナレーター」に割り当てる声', { exact: true })
    .selectOption(fixture.assignments[0].id);
  await importer.getByLabel('取り込み第3行のセリフ', { exact: true }).fill('物語が始まる。');
  await importer.getByLabel('取り込む台本名').fill('一括取り込みの会話');
  await expect(importer.getByRole('status')).toContainText('要修正0行');
  await importer.screenshot({ path: testInfo.outputPath('script-import.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await importer.getByRole('button', { name: '確認した内容を台本に反映', exact: true }).click();
  await expect(library.getByRole('group', { name: '台本の未保存変更の確認' })).toBeVisible();
  await expect(importer.getByLabel('取り込み第1行の名前', { exact: true })).toBeDisabled();
  await library.getByRole('button', { name: '台本の切り替えをキャンセル', exact: true }).click();
  await expect(panel.locator(':scope > ol audio').first()).toHaveAttribute('src', url!);
  await importer.getByRole('button', { name: '確認した内容を台本に反映', exact: true }).click();
  await library.getByRole('button', { name: '台本を保存せず切り替える', exact: true }).click();
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('一括の挨拶');
  await expect(panel.locator(':scope > ol audio')).toHaveCount(0);
  await expect(panel.getByText('発話者：ナレーター', { exact: true })).toBeVisible();
  const saved = await exported(page, panel);
  expect(saved.gapMs).toBe(600);
  expect(saved.lines).toHaveLength(3);
  expect(saved.lines[2].character).toBe('ナレーター');
  expect(saved.lines[2].assignment.character).toBe('案内人');
  expect(
    saved.lines[1].assignment.comparison.entries[1].evaluation.candidates[1].recipe.speedScale,
  ).toBe(0.85);
  expect(calls).toBe(2);
});
test('reads quoted UTF-8 CSV and rejects bad encoding, oversized input, extra records and malformed quotes without changing the editor', async ({
  page,
}) => {
  let calls = 0;
  await page.route('**/api/casting/preview', (route) => {
    calls++;
    return route.abort();
  });
  const { panel, importer } = await open(page);
  await importer
    .getByLabel('台本取り込みCSVファイル')
    .setInputFiles(csvFile(Buffer.from([0xff, 0xfe, 0x00])));
  await expect(importer.getByRole('alert')).toContainText('UTF-8');
  await importer
    .getByLabel('台本取り込みCSVファイル')
    .setInputFiles(csvFile(Buffer.alloc(maxScriptImportBytes + 1, 65)));
  await expect(importer.getByRole('alert')).toContainText('64KiB');
  await importer.getByLabel('台本取り込みの形式').selectOption('csv');
  await importer.getByLabel('一括取り込みの入力').fill('キャラクター名,セリフ\n案内人,"未終了');
  await importer.getByRole('button', { name: '取り込み内容を確認', exact: true }).click();
  await expect(importer.getByRole('alert')).toContainText('引用符');
  await importer
    .getByLabel('一括取り込みの入力')
    .fill('キャラクター名,セリフ\n' + Array(21).fill('案内人,声').join('\n'));
  await importer.getByRole('button', { name: '取り込み内容を確認', exact: true }).click();
  await expect(importer.getByRole('alert')).toContainText('20行');
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('ようこそ。');
  await importer
    .getByLabel('台本取り込みCSVファイル')
    .setInputFiles(
      csvFile(
        Buffer.from(
          '\uFEFFセリフ,キャラクター名\r\n"こんにちは、""旅人""。\r\n続けます。",案内人\r\n返答,騎士\r\n',
        ),
      ),
    );
  await expect(importer.getByLabel('取り込み第1行のセリフ', { exact: true })).toHaveValue(
    'こんにちは、"旅人"。\n続けます。',
  );
  await importer.getByLabel('取り込み候補の場面').selectOption('導入');
  await importer.getByLabel('取り込み第2行の名前', { exact: true }).fill('未知の役');
  await expect(
    importer.getByRole('button', { name: '確認した内容を台本に反映', exact: true }),
  ).toBeDisabled();
  await importer.getByLabel('取り込み第2行の名前', { exact: true }).fill('騎士');
  await importer.getByRole('button', { name: '確認した内容を台本に反映', exact: true }).click();
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue(
    'こんにちは、"旅人"。\n続けます。',
  );
  expect(calls).toBe(0);
  await importer.getByLabel('一括取り込みの入力').fill('キャラクター名,セリフ\n案内人,更新');
  await expect(
    importer.getByRole('button', { name: '確認した内容を台本に反映', exact: true }),
  ).toHaveCount(0);
});
test('saves dirty work before importing, keeps it on quota failure and refuses stale explicit voice mappings', async ({
  page,
}) => {
  const { panel, importer, library } = await open(page);
  await panel.getByLabel('台本名', { exact: true }).fill('残す台本');
  await library.getByLabel('台本ライブラリの作品名').fill('物語');
  await library.getByLabel('台本ライブラリの場面名').fill('保存元');
  await importer.getByLabel('一括取り込みの入力').fill('案内人：新しい1行\n案内人：新しい2行');
  await importer.getByRole('button', { name: '取り込み内容を確認', exact: true }).click();
  await importer
    .getByLabel('「案内人」に割り当てる声', { exact: true })
    .selectOption(fixture.assignments[0].id);
  await importer.getByRole('button', { name: '確認した内容を台本に反映', exact: true }).click();
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    (window as unknown as { restoreStorage: () => void }).restoreStorage = () => {
      Storage.prototype.setItem = original;
    };
  });
  await library.getByRole('button', { name: '台本を保存して切り替える', exact: true }).click();
  await expect(library.getByRole('alert')).toContainText('保持');
  await expect(panel.getByLabel('台本名', { exact: true })).toHaveValue('残す台本');
  await page.evaluate(() => (window as unknown as { restoreStorage: () => void }).restoreStorage());
  await library.getByRole('button', { name: '台本を保存して切り替える', exact: true }).click();
  await expect(library.getByText('物語 / 保存元 / 残す台本', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('新しい1行');
  const saved = await exported(page, panel);
  expect(saved.lines[0].assignment.id).toBe(saved.lines[1].assignment.id);
  const board = page.getByRole('region', { name: 'キャスティング表', exact: true });
  const row = board
    .locator(':scope > ol > li')
    .filter({ has: page.getByText('物語 / 案内人 / 導入', { exact: true }) });
  await row.getByRole('button', { name: '確定設定を削除', exact: true }).click();
  await row.getByRole('button', { name: 'この確定設定を削除する', exact: true }).click();
  await expect(importer.getByLabel('「案内人」に割り当てる声', { exact: true })).toHaveValue('');
  await expect(
    importer.getByRole('button', { name: '確認した内容を台本に反映', exact: true }),
  ).toBeDisabled();
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('新しい1行');
});
