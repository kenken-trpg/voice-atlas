import { test, expect, type Page } from '@playwright/test';
import { scriptFixture } from '../tests/fixtures/script';
import { scriptStorageKey, serializeScript, scriptCandidate } from '../shared/script';
import { castingBoardStorageKey, serializeCastingBoard } from '../shared/casting-board';
import { pcmWav } from '../tests/fixtures/wav';
import { projectStorageKey, projectLibraryStorageKey } from '../shared/project';
const fixture = scriptFixture();
async function open(page: Page) {
  await page.addInitScript(
    ({ scriptKey, script, boardKey, board }) => {
      if (!localStorage.getItem(scriptKey)) localStorage.setItem(scriptKey, script);
      if (!localStorage.getItem(boardKey)) localStorage.setItem(boardKey, board);
    },
    {
      scriptKey: scriptStorageKey,
      script: serializeScript(fixture.script),
      boardKey: castingBoardStorageKey,
      board: serializeCastingBoard(fixture.assignments),
    },
  );
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: fixture.assignments[0].assignedAt,
        engines: ['VOICEVOX', 'AivisSpeech'].map((engine) => ({
          engine,
          ready: true,
          detail: '接続済み',
        })),
        voices: fixture.script.lines.map((line) => scriptCandidate(line)!.voice),
      },
    }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({
      json: { ready: false, checkedAt: fixture.assignments[0].assignedAt, models: [] },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'VOICEVOX・AivisSpeechを比較する', exact: true }).click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  return page.getByRole('region', { name: '台本の試聴', exact: true });
}
test('generates spoken text while retaining display text and reuses audio when only the display changes', async ({
  page,
}) => {
  const calls: { text: string }[] = [];
  await page.route('**/api/casting/preview', (route) => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: 'audio/wav',
      body: Buffer.from(pcmWav(Array(2400).fill(200))),
    });
  });
  const panel = await open(page);
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('星詠みの塔');
  await panel.getByLabel('第1行の読み上げ文を別に指定', { exact: true }).check();
  await panel.getByLabel('第1行の読み上げ文', { exact: true }).fill('ほしよみのとう');
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  expect(calls.map((c) => c.text)).toEqual(['ほしよみのとう', '案内を頼もう。']);
  const url = await panel.getByLabel('台本の第1行の試聴', { exact: true }).getAttribute('src');
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('星詠みの塔（看板）');
  await expect(panel.getByLabel('台本の第1行の試聴', { exact: true })).toHaveAttribute('src', url!);
  await panel.getByRole('button', { name: '台本をブラウザに保存', exact: true }).click();
  expect(
    JSON.parse((await page.evaluate((key) => localStorage.getItem(key), scriptStorageKey))!)
      .lines[0],
  ).toMatchObject({ text: '星詠みの塔（看板）', spokenText: 'ほしよみのとう' });
  await panel.getByLabel('第1行の読み上げ文', { exact: true }).fill('とうへ');
  await expect(panel.locator(':scope > ol audio')).toHaveCount(1);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  expect(calls.at(-1)!.text).toBe('とうへ');
});
test('reviews dictionary changes, protects manual readings and keeps dictionary and script together in project storage', async ({
  page,
}, testInfo) => {
  const panel = await open(page);
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('星詠みの塔へ。');
  await panel.getByLabel('第2行の読み上げ文を別に指定', { exact: true }).check();
  await panel.getByLabel('第2行の読み上げ文', { exact: true }).fill('てどう');
  await panel.getByText('作品の読み方辞書', { exact: true }).click();
  const dictionary = panel.getByRole('region', { name: '作品の読み方辞書', exact: true });
  await dictionary.getByLabel('辞書の表記').fill('星詠みの塔');
  await dictionary.getByLabel('辞書の読み方').fill('ほしよみのとう');
  await dictionary.getByRole('button', { name: '読み方を辞書に反映', exact: true }).click();
  await dictionary.getByRole('button', { name: '辞書を適用する行を確認', exact: true }).click();
  await expect(dictionary.getByRole('group', { name: '辞書適用の確認' })).toContainText(
    '設定変更1行',
  );
  await dictionary.getByRole('button', { name: '辞書の適用をキャンセル', exact: true }).click();
  await expect(panel.getByLabel('第1行の読み上げ文', { exact: true })).toHaveCount(0);
  await dictionary.getByRole('button', { name: '辞書を適用する行を確認', exact: true }).click();
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('星詠みの塔です。');
  await expect(
    dictionary.getByRole('button', { name: '確認した読み方を台本に反映', exact: true }),
  ).toBeDisabled();
  await dictionary.getByRole('button', { name: '辞書を適用する行を確認', exact: true }).click();
  await dictionary.getByRole('button', { name: '確認した読み方を台本に反映', exact: true }).click();
  await expect(panel.getByLabel('第1行の読み上げ文', { exact: true })).toHaveValue(
    'ほしよみのとうです。',
  );
  await expect(panel.getByLabel('第2行の読み上げ文', { exact: true })).toHaveValue('てどう');
  await dictionary.screenshot({ path: testInfo.outputPath('dictionary.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  await page.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  const saved = await page.evaluate(
    ({ single, multiple }) => {
      const lib = localStorage.getItem(multiple);
      if (lib) {
        const value = JSON.parse(lib);
        return value.projects.find((p: { id: string }) => p.id === value.activeId);
      }
      return JSON.parse(localStorage.getItem(single)!);
    },
    { single: projectStorageKey, multiple: projectLibraryStorageKey },
  );
  expect(saved.documents.pronunciations[0]).toMatchObject({
    term: '星詠みの塔',
    reading: 'ほしよみのとう',
  });
  expect(saved.documents.script.lines[0].spokenText).toBe('ほしよみのとうです。');
});
