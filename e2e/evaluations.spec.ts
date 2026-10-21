import { test, expect, type Download } from '@playwright/test';
import { voices } from '../shared/catalog';
import { makeRecipe } from '../shared/recommend';
import { makeEvaluationDataset, type EvaluationRecord } from '../shared/evaluation-dataset';
import type { Evaluation } from '../shared/saved-recipe';

const metan = voices.find((voice) => voice.id === 'vv-metan')!;
const ryusei = voices.find((voice) => voice.id === 'vv-ryusei')!;
function record(
  outcome: Evaluation['outcome'] = 'a',
  reason = 'はっきりした演技が合う。',
): EvaluationRecord {
  return {
    evaluation: {
      recordedAt: '2026-10-21T00:00:00.000Z',
      profile: { ...metan.profile },
      sampleText: '評価を集計するセリフです。',
      outcome,
      reason,
      candidates: [metan, ryusei].map((voice) => ({
        voiceId: voice.id,
        parameters: makeRecipe(metan.profile, voice),
      })) as Evaluation['candidates'],
    },
    sourceCatalogDates: ['2026-10-20'],
  };
}
function file(input: unknown, name = 'evaluations.json') {
  return { name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(input)) };
}
async function downloadedBuffer(download: Download) {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
test.beforeEach(async ({ page }) => {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({
      json: {
        ollama: { ready: false, model: 'test', detail: '未接続' },
        openai: { ready: false, model: 'test' },
        anthropic: { ready: false, model: 'test' },
        gemini: { ready: false, model: 'test' },
        voicevox: { ready: false, detail: '未接続' },
      },
    }),
  );
});

test('aggregates recipe histories, filters current score disagreements, exports and restores without replacing casting work', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') requests.push(request.url());
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '凛と、落ち着いて' }).click();
  await page.locator('#recipe-speedScale').fill('0.91');
  await page.getByRole('button', { name: '評価記録をまとめる' }).click();
  const panel = page.getByRole('region', { name: '評価記録の集計' });
  const recipe = (records: EvaluationRecord[], date: string) => ({
    format: 'voice-atlas-recipe',
    version: 2,
    catalogReviewedAt: date,
    evaluations: records.map((item) => item.evaluation),
  });
  await panel
    .getByLabel('集計用JSONファイル')
    .setInputFiles([
      file(recipe([record()], '2026-10-20'), 'first.json'),
      file(recipe([record(), record('b', '=低音の役柄に合う。')], '2026-10-21'), 'second.json'),
    ]);
  await expect(panel.getByRole('status').filter({ hasText: '2件追加・重複1件' })).toBeVisible();
  await expect(panel.locator('.evaluation-summary')).toContainText('集計した評価：2件');
  await expect(panel.locator('.evaluation-summary')).toContainText('高スコアを採用：1件');
  await expect(panel.locator('.evaluation-summary')).toContainText('低スコアを採用：1件');
  await expect(page.locator('#recipe-speedScale')).toHaveValue('0.91');
  await panel.getByLabel('現行スコアとの関係').selectOption('lower');
  await panel.getByLabel('理由・セリフ・候補名で検索').fill('低音');
  await expect(panel.locator('.evaluation-records > li')).toHaveCount(1);
  await panel.getByText('比較条件を見る', { exact: true }).click();
  await expect(panel.getByRole('table')).toContainText('話速');
  const csvEvent = page.waitForEvent('download');
  await panel.getByRole('button', { name: '絞り込み結果をCSVで保存' }).click();
  const csv = (await downloadedBuffer(await csvEvent)).toString('utf8');
  expect(csv).toContain('"\'=低音の役柄に合う。"');
  expect(csv).not.toContain('はっきりした演技が合う。');
  const jsonEvent = page.waitForEvent('download');
  await panel.getByRole('button', { name: '集計全体をJSONで保存' }).click();
  const json = await downloadedBuffer(await jsonEvent);
  const saved = JSON.parse(json.toString());
  expect(saved.records).toHaveLength(2);
  expect(saved.records[0].sourceCatalogDates).toEqual(['2026-10-20', '2026-10-21']);
  expect(saved.image).toBeUndefined();
  await panel.screenshot({ path: test.info().outputPath('evaluations.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: '評価記録の集計を閉じる' }).click();
  await page.getByRole('button', { name: '評価記録をまとめる' }).click();
  await expect(panel.locator('.evaluation-summary')).toContainText('集計した評価：2件');
  await page.reload();
  await page.getByRole('button', { name: '評価記録をまとめる' }).click();
  await panel
    .getByLabel('集計用JSONファイル')
    .setInputFiles({ name: 'archive.json', mimeType: 'application/json', buffer: json });
  await expect(panel.locator('.evaluation-summary')).toContainText('集計した評価：2件');
  await expect(page.getByRole('heading', { name: 'まだ声のない、その物語に。' })).toBeVisible();
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test('imports a batch atomically and retains historical IDs without inventing scores', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '評価記録をまとめる' }).click();
  const panel = page.getByRole('region', { name: '評価記録の集計' });
  const input = panel.getByLabel('集計用JSONファイル');
  await input.setInputFiles(file(makeEvaluationDataset([record()])));
  await expect(panel.locator('.evaluation-summary')).toContainText('集計した評価：1件');
  await input.setInputFiles([
    file(makeEvaluationDataset([record('b')])),
    { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken') },
  ]);
  await expect(panel.getByRole('alert')).toContainText('有効なJSONでない');
  await expect(panel.locator('.evaluation-summary')).toContainText('集計した評価：1件');
  await input.setInputFiles(
    Array.from({ length: 21 }, (_, i) => file(makeEvaluationDataset([record()]), `${i}.json`)),
  );
  await expect(panel.getByRole('alert')).toContainText('20ファイル');
  await expect(panel.locator('.evaluation-summary')).toContainText('集計した評価：1件');
  const unknown = record('a', '以前の声の記録');
  unknown.evaluation.candidates[0].voiceId = 'removed-voice';
  await input.setInputFiles(file(makeEvaluationDataset([unknown])));
  await expect(panel.locator('.evaluation-summary')).toContainText('集計した評価：2件');
  await expect(panel.getByText('A：未収録：removed-voice ／ スコア：未収録')).toBeVisible();
  await input.setInputFiles(file({ format: 'voice-atlas-recipe', version: 1 }));
  await expect(panel.getByRole('status').filter({ hasText: '評価履歴はありません' })).toBeVisible();
  await input.setInputFiles(file({ ...makeEvaluationDataset([record()]), version: 99 }));
  await expect(panel.getByRole('alert')).toContainText('バージョン');
  await expect(panel.locator('.evaluation-summary')).toContainText('集計した評価：2件');
});

test('paginates and exports all filtered records rather than only the current page', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: '評価記録をまとめる' }).click();
  const panel = page.getByRole('region', { name: '評価記録の集計' });
  const records = Array.from({ length: 26 }, (_, i) => record('tie', `比較記録${i}`));
  await panel.getByLabel('集計用JSONファイル').setInputFiles(file(makeEvaluationDataset(records)));
  await expect(panel.locator('.evaluation-records > li')).toHaveCount(25);
  await panel.getByRole('button', { name: '次の25件' }).click();
  await expect(panel.locator('.evaluation-records > li')).toHaveCount(1);
  const downloadEvent = page.waitForEvent('download');
  await panel.getByRole('button', { name: '絞り込み結果をCSVで保存' }).click();
  const csv = (await downloadedBuffer(await downloadEvent)).toString();
  expect(csv.trimEnd().split('\r\n')).toHaveLength(27);
  await panel.getByLabel('判断で絞り込む').selectOption('a');
  await expect(
    panel.getByText('この条件に合う評価はありません。絞り込みを変更してください。'),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: '絞り込み結果をCSVで保存' })).toBeDisabled();
  await panel.getByRole('button', { name: '集計をクリア' }).click();
  await expect(panel.locator('.evaluation-summary')).toContainText('集計した評価：0件');
});
