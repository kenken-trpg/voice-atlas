import { test, expect, type Page, type Locator } from '@playwright/test';
import { projectFixture } from '../tests/fixtures/project';
import { scriptFixture } from '../tests/fixtures/script';
import { projectStorageKey } from '../shared/project';
import { makeScriptLine, scriptCandidate } from '../shared/script';
import { pcmWav } from '../tests/fixtures/wav';

const base = scriptFixture();
const quiet = structuredClone(base.assignments[0]);
quiet.id = crypto.randomUUID();
quiet.scene = '小声';
quiet.comparison.entries[0].evaluation.candidates[0].recipe.speedScale = 0.7;
const same = { ...base.assignments[0], id: crypto.randomUUID(), scene: '通常' };
const other = { ...base.assignments[0], id: crypto.randomUUID(), project: '別作品' };
const offline = structuredClone(quiet);
offline.id = crypto.randomUUID();
offline.scene = '未導入の声';
const voice = offline.comparison.entries[0].evaluation.candidates[0].voice;
if (voice.engine !== 'AivisSpeech') throw new Error('fixture');
voice.speakerUuid = 'aaaaaaaa-1111-4111-8111-111111111111';
const fixture = projectFixture();
fixture.documents.castingBoard.assignments = [...base.assignments, quiet, same, other, offline];
fixture.documents.script = {
  ...base.script,
  gapMs: 640,
  lines: [
    { ...base.script.lines[0], spokenText: 'ほしよみのとう', readingSource: 'manual' },
    { ...makeScriptLine(base.assignments[0]), text: '通常のまま' },
    base.script.lines[1],
    { ...makeScriptLine(other), text: '別作品の同名人物' },
    { ...makeScriptLine(), character: '案内人', text: '声が未割り当て' },
  ],
};
async function expand(page: Page) {
  await page.getByRole('button', { name: 'VOICEVOX・AivisSpeechを比較する', exact: true }).click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  const panel = page.getByRole('region', { name: '台本の試聴', exact: true });
  await panel.getByText('場面別の声を呼び出す', { exact: true }).click();
  return { panel, scenes: panel.getByRole('region', { name: '台本の場面別設定', exact: true }) };
}
async function setup(page: Page) {
  await page.addInitScript(
    ({ key, value }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    },
    { key: projectStorageKey, value: JSON.stringify(fixture) },
  );
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: fixture.createdAt,
        engines: ['VOICEVOX', 'AivisSpeech'].map((engine) => ({
          engine,
          ready: true,
          detail: '接続済み',
        })),
        voices: base.script.lines.map((line) => scriptCandidate(line)!.voice),
      },
    }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({ json: { ready: false, checkedAt: fixture.createdAt, models: [] } }),
  );
  const calls: { text: string; candidate: { recipe: { speedScale: number } } }[] = [];
  await page.route('**/api/casting/preview', (route) => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: 'audio/wav',
      body: Buffer.from(pcmWav(Array(2400).fill(100))),
    });
  });
  await page.goto('/');
  return { ...(await expand(page)), calls };
}
async function choose(scenes: Locator, id = quiet.id, project = '物語') {
  await scenes.getByLabel('場面設定の作品', { exact: true }).selectOption(project);
  await scenes.getByLabel('場面設定のキャラクター', { exact: true }).selectOption('案内人');
  await scenes.getByLabel('呼び出す場面設定', { exact: true }).selectOption(id);
}
test('applies a scene to chosen rows, retains other audio and readings, and undoes without generating', async ({
  page,
}, testInfo) => {
  const { panel, scenes, calls } = await setup(page);
  for (const n of [1, 2])
    await panel.getByRole('button', { name: `第${n}行を生成`, exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  const urls = await panel
    .locator(':scope > ol audio')
    .evaluateAll((items) => items.map((item) => (item as HTMLAudioElement).src));
  await choose(scenes);
  await expect(scenes.getByRole('checkbox')).toHaveCount(3);
  await expect(scenes.getByLabel('場面設定の対象 第3行', { exact: true })).toHaveCount(0);
  await expect(scenes.getByLabel('場面設定の対象 第4行', { exact: true })).toHaveCount(0);
  await scenes.getByLabel('場面設定の対象 第1行', { exact: true }).check();
  await scenes.getByRole('button', { name: '場面設定の適用対象を確認', exact: true }).click();
  const review = scenes.getByRole('group', { name: '場面設定の適用確認' });
  await expect(review).toContainText('音声再生成が必要1行');
  await scenes.getByRole('button', { name: '場面設定の適用をキャンセル', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  expect(calls).toHaveLength(2);
  await scenes.getByRole('button', { name: '場面設定の適用対象を確認', exact: true }).click();
  await scenes.screenshot({ path: testInfo.outputPath('scene-settings.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await scenes.getByRole('button', { name: '確認した場面設定を反映', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(1);
  await expect(panel.getByLabel('台本の第2行の試聴', { exact: true })).toHaveAttribute(
    'src',
    urls[1],
  );
  await expect(panel.getByLabel('第1行の読み上げ文', { exact: true })).toHaveValue(
    'ほしよみのとう',
  );
  await expect(panel.getByLabel('結合WAVの行間', { exact: true })).toHaveValue('640');
  expect(calls).toHaveLength(2);
  await panel.getByRole('button', { name: '差し替えた行の未生成音声を生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  expect(calls).toHaveLength(3);
  expect(calls[2].text).toBe('ほしよみのとう');
  expect(calls[2].candidate.recipe.speedScale).toBe(0.7);
  await panel.getByRole('button', { name: '直前の声の差し替えを取り消す', exact: true }).click();
  await expect(panel.getByLabel('台本の第1行の試聴', { exact: true })).toHaveAttribute(
    'src',
    urls[0],
  );
  expect(calls).toHaveLength(3);
});
test('invalidates edited or deleted reviews and preserves audio for an identical voice and tuning', async ({
  page,
}) => {
  const { panel, scenes, calls } = await setup(page);
  await panel.getByRole('button', { name: '第1行を生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(1);
  const url = await panel.getByLabel('台本の第1行の試聴', { exact: true }).getAttribute('src');
  await choose(scenes);
  await scenes.getByLabel('場面設定の対象 第1行', { exact: true }).check();
  await scenes.getByRole('button', { name: '場面設定の適用対象を確認', exact: true }).click();
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('表示だけを変更');
  await expect(
    scenes.getByRole('button', { name: '確認した場面設定を反映', exact: true }),
  ).toBeDisabled();
  await expect(scenes.getByRole('status')).toContainText('確認し直してください');
  await scenes.getByRole('button', { name: '場面設定の適用対象を確認', exact: true }).click();
  const board = page.getByRole('region', { name: 'キャスティング表', exact: true });
  const item = board
    .locator(':scope > ol > li')
    .filter({ has: page.getByText('物語 / 案内人 / 小声', { exact: true }) });
  await item.getByRole('button', { name: '確定設定を削除', exact: true }).click();
  await item.getByRole('button', { name: 'この確定設定を削除する', exact: true }).click();
  await expect(
    scenes.getByRole('button', { name: '確認した場面設定を反映', exact: true }),
  ).toBeDisabled();
  await scenes.getByLabel('呼び出す場面設定', { exact: true }).selectOption(same.id);
  await scenes.getByRole('button', { name: '場面設定の適用対象を確認', exact: true }).click();
  await expect(scenes.getByRole('group', { name: '場面設定の適用確認' })).toContainText(
    '音声再生成が必要0行',
  );
  await scenes.getByRole('button', { name: '確認した場面設定を反映', exact: true }).click();
  await expect(panel.getByLabel('台本の第1行の試聴', { exact: true })).toHaveAttribute('src', url!);
  expect(calls).toHaveLength(1);
});
test('assigns unvoiced lines explicitly, separates projects, persists scene snapshots and keeps unavailable voices from generating', async ({
  page,
}) => {
  const { panel, scenes, calls } = await setup(page);
  await choose(scenes, other.id, '別作品');
  await expect(scenes.getByRole('checkbox')).toHaveCount(2);
  await expect(scenes.getByLabel('場面設定の対象 第1行', { exact: true })).toHaveCount(0);
  await choose(scenes, offline.id);
  await expect(scenes.getByText(/未導入$/)).toBeVisible();
  await scenes.getByRole('button', { name: '対象行をすべて選択', exact: true }).click();
  await expect(scenes.getByRole('checkbox', { checked: true })).toHaveCount(3);
  await scenes.getByRole('button', { name: '対象行の選択を解除', exact: true }).click();
  await expect(scenes.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await scenes.getByLabel('場面設定の対象 第5行', { exact: true }).check();
  await scenes.getByRole('button', { name: '場面設定の適用対象を確認', exact: true }).click();
  await scenes.getByRole('button', { name: '確認した場面設定を反映', exact: true }).click();
  await expect(panel.getByRole('button', { name: '第5行を生成', exact: true })).toBeDisabled();
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  await page.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  await page.reload();
  const restored = await expand(page);
  await expect(restored.panel.getByLabel('第5行の声', { exact: true })).toContainText('未導入の声');
  await expect(restored.panel.getByLabel('第1行の読み上げ文', { exact: true })).toHaveValue(
    'ほしよみのとう',
  );
  await expect(restored.panel.getByLabel('第4行の声', { exact: true })).toContainText('別作品');
  await expect(
    restored.panel.getByRole('button', { name: '第5行を生成', exact: true }),
  ).toBeDisabled();
  expect(calls).toHaveLength(0);
});
