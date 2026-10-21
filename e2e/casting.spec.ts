import { test, expect } from '@playwright/test';
import { voices, catalogReviewedAt } from '../shared/catalog';
import { makeRecipe } from '../shared/recommend';
import { neutralProfile } from '../shared/schema';

function wav() {
  const bytes = Buffer.alloc(4844);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({
      json: {
        ollama: { ready: false, model: 'test', detail: '未接続' },
        openai: { ready: false, model: 'test' },
        anthropic: { ready: false, model: 'test' },
        gemini: { ready: false, model: 'test' },
        voicevox: {
          ready: true,
          detail: '接続済み',
          availableVoiceIds: voices
            .filter((voice) => voice.engine === 'VOICEVOX')
            .map((voice) => voice.id),
          checkedAt: '2026-10-21T00:00:00Z',
        },
      },
    }),
  );
});

test('compares sequentially, retains per-candidate settings, records conditions and restores the chosen voice', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const requests: { voiceId: string; text: string; recipe: { speedScale: number } }[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route('**/api/preview', async (route) => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) await firstGate;
    await route.fulfill({ contentType: 'audio/wav', body: wav() });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '凛と、落ち着いて' }).click();
  await page.getByRole('button', { name: '2候補を比較する' }).click();
  const panel = page.getByRole('region', { name: '2候補の比較試聴' });
  await panel.getByLabel('候補B', { exact: true }).selectOption('vv-metan');
  await panel.getByLabel('候補A', { exact: true }).selectOption('vv-ryusei');
  await page.locator('#compare-A-speedScale').fill('0.88');
  await page.locator('#compare-B-speedScale').fill('0.93');
  await panel.getByLabel('候補A', { exact: true }).selectOption('vv-zundamon');
  await panel.getByLabel('候補A', { exact: true }).selectOption('vv-ryusei');
  await expect(page.locator('#compare-A-speedScale')).toHaveValue('0.88');
  await page.locator('#comparison-text').fill('同じセリフで比較します。');
  await expect(panel.getByRole('button', { name: '評価を記録' })).toBeDisabled();
  await panel.getByRole('button', { name: 'A・Bの比較音声を生成' }).click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(panel.getByLabel('候補B', { exact: true })).toBeDisabled();
  releaseFirst();
  await expect(panel.locator('audio')).toHaveCount(2);
  await panel.screenshot({ path: test.info().outputPath('comparison.png') });
  expect(requests.map((request) => request.voiceId)).toEqual(['vv-ryusei', 'vv-metan']);
  expect(requests.map((request) => request.text)).toEqual(
    Array(2).fill('同じセリフで比較します。'),
  );
  expect(requests.map((request) => request.recipe.speedScale)).toEqual([0.88, 0.93]);
  await panel.getByRole('radio', { name: 'Aを採用' }).check();
  await panel.getByLabel('選択理由（任意・1000文字まで）').fill('落ち着いた低音が役柄に合う。');
  await panel.getByRole('button', { name: '評価を記録' }).click();
  await expect(page.locator('.voice-card.selected')).toContainText('青山龍星');
  await expect(page.locator('#recipe-speedScale')).toHaveValue('0.88');
  await expect(panel.getByText('評価記録：1件 / 100件')).toBeVisible();
  await page.getByRole('button', { name: '評価記録をまとめる' }).click();
  const aggregate = page.getByRole('region', { name: '評価記録の集計' });
  await aggregate.getByRole('button', { name: '現在の比較記録を追加（1件）' }).click();
  await aggregate.getByRole('button', { name: '現在の比較記録を追加（1件）' }).click();
  await expect(aggregate.locator('.evaluation-summary')).toContainText('集計した評価：1件');
  await expect(aggregate.getByRole('status').filter({ hasText: '0件追加・重複1件' })).toBeVisible();
  await page.getByRole('button', { name: '評価記録の集計を閉じる' }).click();
  // Main detail and comparison share settings and generated audio.
  await expect(page.locator('.audio-result audio')).toBeVisible();
  await page.locator('#recipe-speedScale').fill('0.89');
  await expect(page.locator('#compare-A-speedScale')).toHaveValue('0.89');
  await expect(panel.locator('audio')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: '評価を記録' })).toBeDisabled();
  await panel.getByRole('button', { name: 'A・Bの比較音声を生成' }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  expect(requests).toHaveLength(3); // B remains valid; only A needs regeneration.
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'レシピをJSONで保存' }).click();
  const downloaded = await downloadEvent;
  const chunks: Buffer[] = [];
  for await (const chunk of await downloaded.createReadStream()) chunks.push(Buffer.from(chunk));
  const buffer = Buffer.concat(chunks);
  const saved = JSON.parse(buffer.toString());
  expect(saved.version).toBe(2);
  expect(saved.voice.id).toBe('vv-ryusei');
  expect(saved.parameters.speedScale).toBe(0.89);
  expect(saved.evaluations[0].candidates[0].parameters.speedScale).toBe(0.88);
  expect(saved.evaluations[0].reason).toBe('落ち着いた低音が役柄に合う。');
  expect(saved.image).toBeUndefined();
  await page.reload();
  await page
    .getByLabel('レシピJSONファイル')
    .setInputFiles({ name: 'casting.json', mimeType: 'application/json', buffer });
  await expect(page.locator('.recipe-notice')).toContainText('レシピを復元しました');
  await expect(page.locator('.voice-card.selected')).toContainText('青山龍星');
  await expect(page.locator('#recipe-speedScale')).toHaveValue('0.89');
  await expect(page.locator('#compare-A-speedScale')).toHaveValue('0.89');
  await expect(page.locator('#compare-B-speedScale')).toHaveValue('0.93');
  await expect(page.locator('#comparison-text')).toHaveValue('同じセリフで比較します。');
  await expect(panel.locator('audio')).toHaveCount(0);
  await panel.getByText('記録した評価を見る').click();
  await expect(panel.getByText('理由：落ち着いた低音が役柄に合う。')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await panel.getByRole('button', { name: 'A・Bの比較音声を生成' }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  expect(requests.slice(-2).map((request) => request.recipe.speedScale)).toEqual([0.89, 0.93]);
  // Candidate switches retain both settings and the current audio.
  await page
    .locator('.voice-card')
    .filter({ has: page.getByRole('heading', { name: '四国めたん', exact: true }) })
    .filter({ has: page.locator('small').filter({ hasText: /^ノーマル$/ }) })
    .click();
  await expect(page.locator('#recipe-speedScale')).toHaveValue('0.93');
  await expect(page.locator('.audio-result audio')).toBeVisible();
  expect(errors).toEqual([]);
});

test('keeps successful A audio when B fails and retries only B', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/preview', (route) => {
    calls++;
    return calls === 2
      ? route.fulfill({ status: 409, json: { error: 'スタイルがありません' } })
      : route.fulfill({ contentType: 'audio/wav', body: wav() });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '凛と、落ち着いて' }).click();
  await page.getByRole('button', { name: '2候補を比較する' }).click();
  const panel = page.getByRole('region', { name: '2候補の比較試聴' });
  await panel.getByRole('button', { name: 'A・Bの比較音声を生成' }).click();
  await expect(page.getByRole('alert')).toContainText('スタイルがありません');
  await expect(panel.locator('audio')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: '評価を記録' })).toBeDisabled();
  await panel.getByRole('button', { name: 'A・Bの比較音声を生成' }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  expect(calls).toBe(3);
  await page.locator('#comparison-text').fill('変更後のセリフ');
  await expect(panel.locator('audio')).toHaveCount(0);
});

test('reads v1 files and rejects invalid imports without changing current work', async ({
  page,
}) => {
  const legacy = {
    format: 'voice-atlas-recipe',
    version: 1,
    createdAt: '2026-10-21T00:00:00.000Z',
    source: 'manual',
    manuallyAdjusted: true,
    voice: voices[0],
    profile: neutralProfile,
    parameters: { ...makeRecipe(neutralProfile, voices[0]), speedScale: 0.77 },
    sampleText: '以前のレシピ',
    catalogReviewedAt,
  };
  await page.goto('/');
  const upload = (input: unknown) =>
    page.getByLabel('レシピJSONファイル').setInputFiles({
      name: 'recipe.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(input)),
    });
  await upload(legacy);
  await expect(page.locator('#recipe-speedScale')).toHaveValue('0.77');
  await expect(page.locator('#preview-text')).toHaveValue('以前のレシピ');
  await upload({ ...legacy, version: 42 });
  await expect(page.getByRole('alert')).toContainText('バージョン');
  await expect(page.locator('#recipe-speedScale')).toHaveValue('0.77');
  await upload({ ...legacy, voice: { ...voices[0], id: 'removed' } });
  await expect(page.getByRole('alert')).toContainText('カタログにない話者');
  await expect(page.locator('#recipe-speedScale')).toHaveValue('0.77');
  await page.getByLabel('レシピJSONファイル').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{invalid'),
  });
  await expect(page.getByRole('alert')).toContainText('有効なJSON');
  await expect(page.locator('#recipe-speedScale')).toHaveValue('0.77');
});

test('cancelling comparison stops the remaining candidate and allows a fresh retry', async ({
  page,
}) => {
  let calls = 0;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route('**/api/preview', async (route) => {
    calls++;
    if (calls === 1) await firstGate;
    await route.fulfill({ contentType: 'audio/wav', body: wav() });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '凛と、落ち着いて' }).click();
  await page.getByRole('button', { name: '2候補を比較する' }).click();
  const panel = page.getByRole('region', { name: '2候補の比較試聴' });
  await panel.getByRole('button', { name: 'A・Bの比較音声を生成' }).click();
  await expect.poll(() => calls).toBe(1);
  await page.getByRole('button', { name: '待機を中止する' }).click();
  releaseFirst();
  await expect(panel.getByRole('button', { name: 'A・Bの比較音声を生成' })).toBeEnabled();
  await expect(panel.locator('audio')).toHaveCount(0);
  await panel.getByRole('button', { name: 'A・Bの比較音声を生成' }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  expect(calls).toBe(3);
});

test('compares two styles of the same speaker with independent tuning and exports the adopted style', async ({
  page,
}) => {
  const requests: { voiceId: string; recipe: { speedScale: number; pitchScale: number } }[] = [];
  await page.route('**/api/preview', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'audio/wav', body: wav() });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '凛と、落ち着いて' }).click();
  await page.getByLabel('ソフトで絞り込む').selectOption('VOICEVOX');
  await expect(page.locator('.voice-card')).toHaveCount(20);
  await page.getByRole('button', { name: '2候補を比較する' }).click();
  const panel = page.getByRole('region', { name: '2候補の比較試聴' });
  await panel.getByLabel('候補B', { exact: true }).selectOption('vv-metan-whisper');
  await panel.getByLabel('候補A', { exact: true }).selectOption('vv-metan');
  await page.locator('#compare-A-speedScale').fill('0.82');
  await page.locator('#compare-B-speedScale').fill('0.73');
  await expect(page.locator('#compare-B-pitchScale')).toHaveValue('0');
  await panel.getByRole('button', { name: 'A・Bの比較音声を生成' }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  expect(requests.map((item) => item.voiceId)).toEqual(['vv-metan', 'vv-metan-whisper']);
  expect(requests.map((item) => item.recipe.speedScale)).toEqual([0.82, 0.73]);
  expect(requests[1].recipe.pitchScale).toBe(0);
  await panel.getByRole('radio', { name: 'Bを採用' }).check();
  await panel.getByLabel('選択理由（任意・1000文字まで）').fill('静かな場面にはささやきが合う。');
  await panel.getByRole('button', { name: '評価を記録' }).click();
  await expect(page.locator('.voice-card.selected')).toContainText('四国めたん');
  await expect(page.locator('.voice-card.selected small')).toHaveText('ささやき');
  await expect(page.locator('#recipe-speedScale')).toHaveValue('0.73');
  await expect(page.locator('.catalog-provenance')).toContainText('実機での聴取評価は未実施');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'レシピをJSONで保存' }).click();
  const chunks: Buffer[] = [];
  for await (const chunk of await (await downloadEvent).createReadStream())
    chunks.push(Buffer.from(chunk));
  const saved = JSON.parse(Buffer.concat(chunks).toString());
  expect(saved.voice.id).toBe('vv-metan-whisper');
  expect(saved.voice.speakerId).toBe('vv-metan');
  expect(saved.voice.provenance.listeningReviewedAt).toBeNull();
  await page.reload();
  await page.getByLabel('レシピJSONファイル').setInputFiles({
    name: 'styles.json',
    mimeType: 'application/json',
    buffer: Buffer.concat(chunks),
  });
  await expect(page.locator('.voice-card.selected small')).toHaveText('ささやき');
  await expect(page.locator('#compare-A-speedScale')).toHaveValue('0.82');
  await expect(page.locator('#compare-B-speedScale')).toHaveValue('0.73');
});
