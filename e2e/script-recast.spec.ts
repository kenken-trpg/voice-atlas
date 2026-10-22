import { test, expect, type Page, type Locator } from '@playwright/test';
import { scriptFixture } from '../tests/fixtures/script';
import { pcmWav } from '../tests/fixtures/wav';
import {
  makeScriptLine,
  scriptCandidate,
  scriptStorageKey,
  serializeScript,
} from '../shared/script';
import { castingBoardStorageKey, serializeCastingBoard } from '../shared/casting-board';
import {
  makeScriptLibraryEntry,
  scriptLibraryStorageKey,
  serializeScriptLibrary,
} from '../shared/script-library';
import { scriptSettingKey } from '../shared/script-recast';
const base = scriptFixture();
const variant = structuredClone(base.assignments[0]);
variant.id = crypto.randomUUID();
variant.scene = 'ゆっくり';
variant.comparison.entries[0].evaluation.candidates[0].recipe.speedScale = 0.7;
const metadata = {
  ...base.assignments[0],
  id: crypto.randomUUID(),
  character: '別の登録名',
  scene: '同じ音声',
};
const offline = structuredClone(base.assignments[0]);
offline.id = crypto.randomUUID();
offline.scene = '未導入モデル';
const offlineVoice = offline.comparison.entries[0].evaluation.candidates[0].voice;
if (offlineVoice.engine !== 'AivisSpeech') throw new Error('fixture');
offlineVoice.speakerUuid = 'aaaaaaaa-1111-4111-8111-111111111111';
const assignments = [...base.assignments, variant, metadata, offline];
const script = {
  ...base.script,
  gapMs: 500,
  lines: [
    base.script.lines[0],
    { ...makeScriptLine(variant), character: '案内人', text: 'ゆっくり案内' },
    base.script.lines[1],
    { ...makeScriptLine(base.assignments[0]), character: 'ナレーター', text: '同じ声の別の役' },
  ],
};
const storedLibrary = serializeScriptLibrary([makeScriptLibraryEntry(script, '作品', '元台本')]);
async function open(page: Page) {
  await page.addInitScript(
    ({ scriptKey, script, boardKey, board, libraryKey, library }) => {
      localStorage.setItem(scriptKey, script);
      localStorage.setItem(boardKey, board);
      localStorage.setItem(libraryKey, library);
    },
    {
      scriptKey: scriptStorageKey,
      script: serializeScript(script),
      boardKey: castingBoardStorageKey,
      board: serializeCastingBoard(assignments),
      libraryKey: scriptLibraryStorageKey,
      library: storedLibrary,
    },
  );
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: base.assignments[0].assignedAt,
        engines: [
          { engine: 'AivisSpeech', ready: true, detail: '接続済み' },
          { engine: 'VOICEVOX', ready: true, detail: '接続済み' },
        ],
        voices: base.script.lines.map((line) => scriptCandidate(line)!.voice),
      },
    }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({
      json: { ready: false, checkedAt: base.assignments[0].assignedAt, models: [] },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'VOICEVOX・AivisSpeechを比較する', exact: true }).click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  const panel = page.getByRole('region', { name: '台本の試聴', exact: true });
  await panel.getByText('キャラクターの声をまとめて差し替える', { exact: true }).click();
  return {
    panel,
    recast: panel.getByRole('region', { name: '台本の声の一括差し替え', exact: true }),
  };
}
async function prepare(recast: Locator, target = base.assignments[1].id, source = 'all') {
  await recast.getByLabel('差し替える発話者', { exact: true }).selectOption('案内人');
  await recast.getByLabel('声の差し替え範囲', { exact: true }).selectOption(source);
  await recast.getByLabel('差し替え先の確定設定', { exact: true }).selectOption(target);
  await recast.getByRole('button', { name: '差し替え対象を確認', exact: true }).click();
}
async function exported(page: Page, panel: Locator) {
  const event = page.waitForEvent('download');
  await panel.getByRole('button', { name: '台本JSONを保存', exact: true }).click();
  const stream = await (await event).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}
const audioBody = Buffer.from(pcmWav(Array(2400).fill(1000)));
test('recasts actor rows across products and regenerates only changed rows, preserving unrelated audio and library snapshots', async ({
  page,
}, testInfo) => {
  const calls: { text: string; candidate: { recipe: { engine: string; speedScale: number } } }[] =
    [];
  await page.route('**/api/casting/preview', (route) => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'audio/wav', body: audioBody });
  });
  const { panel, recast } = await open(page);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(4);
  const narratorUrl = await panel
    .getByLabel('台本の第4行の試聴', { exact: true })
    .getAttribute('src');
  await panel.getByRole('button', { name: '台本の全行をWAVに結合', exact: true }).click();
  await expect(panel.getByRole('link', { name: '台本全体のWAVを保存', exact: true })).toBeVisible();
  await prepare(recast);
  await expect(recast.getByRole('status')).toContainText(
    '対象2行 / 設定変更2行 / 音声再生成が必要2行',
  );
  await recast.getByRole('button', { name: '声の差し替えをキャンセル', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(4);
  await expect(panel.getByRole('link', { name: '台本全体のWAVを保存', exact: true })).toBeVisible();
  await prepare(recast);
  await recast.getByText('変更後の調声値', { exact: true }).click();
  await recast.screenshot({ path: testInfo.outputPath('script-recast.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await recast.getByRole('button', { name: '確認した声の差し替えを反映', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await expect(panel.getByRole('link', { name: '台本全体のWAVを保存', exact: true })).toHaveCount(
    0,
  );
  await expect(panel.getByText('発話者：案内人', { exact: true })).toHaveCount(2);
  await panel.getByLabel('第3行のセリフ', { exact: true }).fill('別の役の未生成セリフ');
  await panel.getByRole('button', { name: '差し替えた行の未生成音声を生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(3);
  expect(calls).toHaveLength(6);
  expect(
    calls
      .slice(4)
      .map((call) => [call.text, call.candidate.recipe.engine, call.candidate.recipe.speedScale]),
  ).toEqual([
    ['ようこそ。', 'VOICEVOX', 0.85],
    ['ゆっくり案内', 'VOICEVOX', 0.85],
  ]);
  await expect(panel.getByLabel('台本の第4行の試聴', { exact: true })).toHaveAttribute(
    'src',
    narratorUrl!,
  );
  await expect(panel.getByLabel('台本の第3行の試聴', { exact: true })).toHaveCount(0);
  await expect(
    panel.getByRole('button', { name: '差し替えた行の未生成音声を生成', exact: true }),
  ).toBeDisabled();
  const saved = await exported(page, panel);
  expect(saved.lines.map((line: { id: string }) => line.id)).toEqual(
    script.lines.map((line) => line.id),
  );
  expect(saved.gapMs).toBe(500);
  expect(saved.lines[0].character).toBe('案内人');
  expect(saved.lines[3].assignment.id).toBe(base.assignments[0].id);
  expect(await page.evaluate((key) => localStorage.getItem(key), scriptLibraryStorageKey)).toBe(
    storedLibrary,
  );
  expect(await page.evaluate((key) => localStorage.getItem(key), castingBoardStorageKey)).toBe(
    serializeCastingBoard(assignments),
  );
});
test('limits replacement to a source setting and keeps same-sound audio while retrying a failed changed row', async ({
  page,
}) => {
  let calls = 0,
    fail = false;
  await page.route('**/api/casting/preview', (route) => {
    calls++;
    return fail
      ? route.fulfill({ status: 502, json: { error: 'テスト失敗' } })
      : route.fulfill({ contentType: 'audio/wav', body: audioBody });
  });
  const { panel, recast } = await open(page);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(4);
  const urls = await panel
    .locator(':scope > ol audio')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('src')));
  await prepare(recast, metadata.id, scriptSettingKey(script.lines[0]));
  await expect(recast.getByRole('status')).toContainText('音声再生成が必要0行');
  await recast.getByRole('button', { name: '確認した声の差し替えを反映', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(4);
  await expect(panel.getByLabel('台本の第1行の試聴', { exact: true })).toHaveAttribute(
    'src',
    urls[0]!,
  );
  await prepare(recast, base.assignments[1].id, scriptSettingKey(script.lines[1]));
  await expect(recast.getByRole('status')).toContainText('対象1行 / 設定変更1行');
  await recast.getByRole('button', { name: '確認した声の差し替えを反映', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(3);
  fail = true;
  await panel.getByRole('button', { name: '差し替えた行の未生成音声を生成', exact: true }).click();
  await expect(panel.locator(':scope > [role="alert"]')).toContainText('第2行');
  await expect(panel.locator(':scope > ol audio')).toHaveCount(3);
  fail = false;
  await panel.getByRole('button', { name: '差し替えた行の未生成音声を生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(4);
  expect(calls).toBe(6);
  for (const i of [0, 2, 3])
    await expect(panel.getByLabel(`台本の第${i + 1}行の試聴`, { exact: true })).toHaveAttribute(
      'src',
      urls[i]!,
    );
});
test('invalidates stale reviews, permits offline settings without generation and retains partial results on cancellation', async ({
  page,
}) => {
  let calls = 0,
    hold = true;
  let release: (() => void) | undefined;
  await page.route('**/api/casting/preview', async (route) => {
    calls++;
    if (hold && calls === 2)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return route.fulfill({ contentType: 'audio/wav', body: audioBody });
  });
  const { panel, recast } = await open(page);
  await prepare(recast);
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('編集後のセリフ');
  await expect(recast.getByRole('group', { name: '声の差し替え確認' })).toHaveCount(0);
  await recast.getByRole('button', { name: '差し替え対象を確認', exact: true }).click();
  const board = page.getByRole('region', { name: 'キャスティング表', exact: true });
  const row = board
    .locator(':scope > ol > li')
    .filter({ has: page.getByText('物語 / 騎士 / 導入', { exact: true }) });
  await row.getByRole('button', { name: '確定設定を削除', exact: true }).click();
  await row.getByRole('button', { name: 'この確定設定を削除する', exact: true }).click();
  await expect(recast.getByRole('group', { name: '声の差し替え確認' })).toHaveCount(0);
  await prepare(recast, offline.id);
  await expect(recast.getByRole('group', { name: '声の差し替え確認' })).toContainText('未導入');
  await recast.getByRole('button', { name: '確認した声の差し替えを反映', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: '差し替えた行の未生成音声を生成', exact: true }),
  ).toBeDisabled();
  expect(calls).toBe(0);
  await prepare(recast, base.assignments[0].id);
  await recast.getByRole('button', { name: '確認した声の差し替えを反映', exact: true }).click();
  await panel.getByRole('button', { name: '差し替えた行の未生成音声を生成', exact: true }).click();
  await expect.poll(() => calls).toBe(2);
  await expect(
    page.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }),
  ).toBeDisabled();
  await panel.getByRole('button', { name: '台本の生成を中止', exact: true }).click();
  await expect(panel.getByRole('button', { name: '台本の生成を中止', exact: true })).toHaveCount(0);
  release?.();
  hold = false;
  await expect(panel.locator(':scope > ol audio')).toHaveCount(1);
  const url = await panel.locator(':scope > ol audio').getAttribute('src');
  await panel.getByRole('button', { name: '差し替えた行の未生成音声を生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  expect(calls).toBe(3);
  await expect(panel.getByLabel('台本の第1行の試聴', { exact: true })).toHaveAttribute('src', url!);
});
