import { test, expect, type Page } from '@playwright/test';
import { castingKey } from '../shared/casting';
import { voices } from '../shared/catalog';
const uuid = '11111111-1111-4111-8111-111111111111';
const av = {
  engine: 'AivisSpeech' as const,
  speakerUuid: uuid,
  name: '検証用話者',
  style: 'ノーマル',
};
const av2 = { ...av, style: 'ささやき' };
const vv = {
  engine: 'VOICEVOX' as const,
  voiceId: voices[0].id,
  name: voices[0].name,
  style: voices[0].style,
};
function inventory() {
  return {
    checkedAt: '2026-10-21T12:00:00.000Z',
    engines: [
      { engine: 'VOICEVOX', ready: true, detail: '接続済み' },
      { engine: 'AivisSpeech', ready: true, detail: '接続済み' },
    ],
    voices: [av, av2, vv],
  };
}
function wav() {
  const bytes = Buffer.alloc(4844);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24);
  bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(4800, 40);
  return bytes;
}
async function open(page: Page) {
  await page.route('**/api/casting/voices', (route) => route.fulfill({ json: inventory() }));
  await page.goto('/');
  await page.getByRole('button', { name: 'VOICEVOX・AivisSpeechを比較する', exact: true }).click();
  const panel = page.getByRole('region', { name: '製品横断の比較', exact: true });
  await expect(panel.getByText('AivisSpeech：接続済み', { exact: false })).toBeVisible();
  return panel;
}
async function downloadJson(page: Page) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: '比較セッションJSONを保存', exact: true }).click();
  const stream = await (await event).createReadStream();
  const buffers: Buffer[] = [];
  for await (const chunk of stream) buffers.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(buffers).toString());
}

test('compares products with native controls, preserves immutable evaluation and restores the chosen voice', async ({
  page,
}) => {
  const calls: string[] = [];
  await page.route('**/api/casting/preview', async (route) => {
    const request = route.request().postDataJSON();
    calls.push(request.candidate.voice.engine);
    expect(request.text).toBe('同じセリフで比較します。');
    if (request.candidate.voice.engine === 'AivisSpeech')
      expect(request.candidate.recipe).toMatchObject({
        engine: 'AivisSpeech',
        tempoDynamicsScale: 0.72,
        intonationScale: 1.2,
      });
    else expect(request.candidate.recipe).toMatchObject({ engine: 'VOICEVOX', speedScale: 0.85 });
    await route.fulfill({
      contentType: 'audio/wav',
      body: wav(),
      headers: {
        'X-Voice-Atlas-Generation': encodeURIComponent(
          JSON.stringify({
            engine: request.candidate.voice.engine,
            engineVersion: 'test-1',
            checkedAt: '2026-10-21T12:00:00.000Z',
          }),
        ),
      },
    });
  });
  const panel = await open(page);
  await page.locator('#casting-B').selectOption(castingKey(vv));
  await expect(panel.getByLabel('テンポの緩急', { exact: true })).toHaveCount(1);
  await page.locator('#casting-A-tempoDynamicsScale').fill('0.72');
  await page.locator('#casting-A-intonationScale').fill('1.2');
  await page.locator('#casting-B-speedScale').fill('0.85');
  await page.locator('#casting-text').fill('同じセリフで比較します。');
  await panel.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: '製品比較の評価を記録', exact: true }),
  ).toBeEnabled();
  expect(calls).toEqual(['AivisSpeech', 'VOICEVOX']);
  await panel.getByRole('radio', { name: 'Aを採用', exact: true }).check();
  await page.locator('#casting-reason').fill('感情表現とテンポが役に合う。');
  await panel.getByRole('button', { name: '製品比較の評価を記録', exact: true }).click();
  await page.locator('#casting-A-tempoDynamicsScale').fill('0.4');
  await expect(panel.locator('audio[aria-label="製品比較候補Aの試聴"]')).toHaveCount(0);
  const saved = await downloadJson(page);
  expect(saved.format).toBe('voice-atlas-casting');
  expect(saved.selectedKey).toBe(castingKey(av));
  expect(saved.evaluations[0]).toMatchObject({
    reason: '感情表現とテンポが役に合う。',
    candidates: [
      { recipe: { engine: 'AivisSpeech', tempoDynamicsScale: 0.72 } },
      { recipe: { engine: 'VOICEVOX', speedScale: 0.85 } },
    ],
  });
  expect(saved.evaluations[0]).not.toHaveProperty('score');
  await page.locator('#casting-B').selectOption(castingKey(av2));
  await page.locator('#casting-B').selectOption(castingKey(vv));
  await expect(page.locator('#casting-B-speedScale')).toHaveValue('0.85');
  await page.locator('#casting-A-tempoDynamicsScale').fill('1.5');
  await page.getByLabel('比較セッションJSONファイル').setInputFiles({
    name: 'casting.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(page.locator('#casting-A-tempoDynamicsScale')).toHaveValue('0.4');
  await expect(
    panel.getByText('保存対象の声：AivisSpeech · 検証用話者 / ノーマル', { exact: true }),
  ).toBeVisible();
  await expect(panel.locator('audio')).toHaveCount(0);
  await panel.getByText('製品比較の履歴を見る', { exact: true }).click();
  await expect(
    panel.getByText('理由：感情表現とテンポが役に合う。', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath('casting-products.png'), fullPage: true });
});

test('retains successful audio and retries only the failed product', async ({ page }) => {
  const calls: string[] = [];
  let fail = true;
  await page.route('**/api/casting/preview', async (route) => {
    const request = route.request().postDataJSON();
    const style = request.candidate.voice.style;
    calls.push(style);
    if (style === 'ささやき' && fail) {
      fail = false;
      await route.fulfill({ status: 502, json: { error: '生成失敗テスト' } });
      return;
    }
    await route.fulfill({ contentType: 'audio/wav', body: wav() });
  });
  const panel = await open(page);
  await panel.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('生成失敗テスト');
  await expect(panel.locator('audio')).toHaveCount(1);
  await panel.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  expect(calls).toEqual(['ノーマル', 'ささやき', 'ささやき']);
});

test('preserves offline restored settings and rejects a mixed-product import atomically', async ({
  page,
}) => {
  const panel = await open(page);
  await page.locator('#casting-A-tempoDynamicsScale').fill('0.65');
  const saved = await downloadJson(page);
  const invalid = structuredClone(saved);
  invalid.candidates[0].recipe.engine = 'VOICEVOX';
  await page.getByLabel('比較セッションJSONファイル').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(invalid)),
  });
  await expect(panel.getByRole('alert')).toContainText('現在の作業は保持');
  await expect(page.locator('#casting-A-tempoDynamicsScale')).toHaveValue('0.65');
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: inventory().checkedAt,
        engines: [
          { engine: 'VOICEVOX', ready: false, detail: '未接続' },
          { engine: 'AivisSpeech', ready: true, detail: '接続済み' },
        ],
        voices: [],
      },
    }),
  );
  await panel.getByRole('button', { name: '比較用の接続を再確認', exact: true }).click();
  await expect(panel.getByText('未導入', { exact: true })).toHaveCount(2);
  await expect(
    panel.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('比較セッションJSONファイル').setInputFiles({
    name: 'saved.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(page.locator('#casting-A-tempoDynamicsScale')).toHaveValue('0.65');
  await expect(
    panel.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }),
  ).toBeDisabled();
});

test('clears failed connection inventory and preserves edits across closing the workspace', async ({
  page,
}) => {
  const panel = await open(page);
  await page.locator('#casting-A-tempoDynamicsScale').fill('0.6');
  await page.getByRole('button', { name: '製品横断の比較を閉じる', exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: 'VOICEVOX・AivisSpeechを比較する', exact: true }).click();
  await expect(page.locator('#casting-A-tempoDynamicsScale')).toHaveValue('0.6');
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({ status: 502, json: { error: '接続失敗テスト' } }),
  );
  await panel.getByRole('button', { name: '比較用の接続を再確認', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('接続失敗テスト');
  await expect(
    panel.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('#casting-A-tempoDynamicsScale')).toHaveValue('0.6');
});

test('cancels the remaining product and allows a fresh generation', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  await page.route('**/api/casting/preview', async (route) => {
    calls++;
    if (calls === 1) await held;
    await route.fulfill({ contentType: 'audio/wav', body: wav() }).catch(() => {});
  });
  const panel = await open(page);
  await panel.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }).click();
  await expect.poll(() => calls).toBe(1);
  await panel.getByRole('button', { name: '製品比較の生成を中止', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }),
  ).toBeEnabled();
  release();
  await expect(panel.locator('audio')).toHaveCount(0);
  await panel.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  expect(calls).toBe(3);
});
