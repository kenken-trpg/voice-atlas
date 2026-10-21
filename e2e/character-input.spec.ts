import { test, expect, type Download } from '@playwright/test';
import sharp from 'sharp';
import { voices } from '../shared/catalog';

const setting = '旅人を案内する司書。穏やかだが芯が強い。丁寧な言葉遣い。';
const direction = '低めの声でゆっくり話す。';
const analysis = {
  subjectFound: true,
  summary: '作者の設定から、穏やかな案内役という演出案です。',
  cues: ['旅人を案内する司書', '丁寧な言葉遣い'],
  delivery: '落ち着いたテンポで話します。',
  profile: { ...voices[0].profile },
};
const capabilities = {
  ollama: { ready: false, textReady: true, model: 'test-local-text', detail: 'テキスト対応' },
  openai: { ready: true, model: 'test' },
  anthropic: { ready: true, model: 'test' },
  gemini: { ready: true, model: 'test' },
  voicevox: {
    ready: true,
    detail: '接続済み',
    availableVoiceIds: voices
      .filter((voice) => voice.engine === 'VOICEVOX')
      .map((voice) => voice.id),
    checkedAt: '2026-10-21T00:00:00Z',
  },
};
async function downloadBuffer(download: Download) {
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
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
  await page.route('**/api/capabilities', (route) => route.fulfill({ json: capabilities }));
});
for (const { provider, label, display } of [
  { provider: 'ollama', label: 'Ollama', display: 'Ollama' },
  { provider: 'openai', label: 'OpenAI', display: 'OpenAI' },
  { provider: 'anthropic', label: 'Claude', display: 'Anthropic（Claude）' },
  { provider: 'gemini', label: 'Gemini', display: 'Google（Gemini）' },
]) {
  test(`creates a direction from text via ${label} without uploading an image`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let sent = 0;
    await page.route('**/api/analyze', async (route) => {
      const input = route.request().postDataJSON();
      expect(input).toMatchObject({
        provider,
        inputMode: 'text',
        characterText: setting,
        direction,
      });
      expect(input).not.toHaveProperty('image');
      expect(input.consent).toBe(provider !== 'ollama');
      sent++;
      await route.fulfill({ json: { analysis, provider } });
    });
    await page.goto('/');
    if (provider === 'ollama') {
      // Keeping an image in the other input tab must not send it in text mode.
      const buffer = await sharp({
        create: { width: 48, height: 64, channels: 3, background: '#81a292' },
      })
        .png()
        .toBuffer();
      await page
        .locator('#character-image')
        .setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer });
    }
    await page.getByRole('radio', { name: '設定テキストのみ', exact: true }).check();
    await page.getByRole('radio', { name: label }).check();
    const generate = page.getByRole('button', { name: '設定から声の演出案を作る', exact: true });
    await expect(generate).toBeDisabled();
    await expect(page.locator('#character-image')).toBeHidden();
    await page.locator('#character-setting').fill(setting);
    await page.locator('#direction').fill(direction);
    if (provider !== 'ollama') {
      await expect(generate).toBeDisabled();
      await page
        .getByRole('checkbox', {
          name: `キャラクター設定と補足を${display}に送信することに同意する（API利用料がかかる場合があります）`,
          exact: true,
        })
        .check();
    }
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect(page.locator('.analysis-card')).toContainText(analysis.summary);
    await expect(page.locator('.analysis-card')).toContainText('作者の設定からの要点');
    await expect(page.locator('.source-badge')).toContainText('（設定テキスト）');
    expect(sent).toBe(1);
    if (provider === 'ollama') {
      await page.getByRole('button', { name: '接続設定', exact: true }).click();
      await expect(page.getByRole('region', { name: '接続設定' })).toContainText(
        '画像入力は未対応',
      );
    }
    await page.screenshot({ path: test.info().outputPath('text-direction.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.locator('#direction').fill('語尾に少し威厳を加える。');
    await expect(page.locator('.input-change-note')).toBeVisible();
    if (provider !== 'ollama') {
      await expect(page.locator('.consent input')).not.toBeChecked();
      await expect(generate).toBeDisabled();
    }
    expect(errors).toEqual([]);
  });
}

test('preserves draft and evaluated character settings separately through comparison, JSON restoration and aggregation', async ({
  page,
}) => {
  await page.route('**/api/analyze', (route) =>
    route.fulfill({ json: { analysis, provider: 'ollama' } }),
  );
  await page.route('**/api/preview', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: wav() }),
  );
  await page.goto('/');
  await page.getByRole('radio', { name: '設定テキストのみ', exact: true }).check();
  await page.locator('#character-setting').fill(setting);
  await page.getByRole('radio', { name: 'Ollama' }).check();
  await page.locator('#direction').fill(direction);
  await page.getByRole('button', { name: '設定から声の演出案を作る', exact: true }).click();
  await expect(page.locator('.analysis-card')).toBeVisible();
  await page.locator('#recipe-speedScale').fill('0.91');
  await page.getByRole('button', { name: '2候補を比較する', exact: true }).click();
  const panel = page.getByRole('region', { name: '2候補の比較試聴' });
  await panel.getByRole('button', { name: 'A・Bの比較音声を生成' }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  await page.locator('#character-setting').fill('次に試したい案：厳格な衛兵。');
  await page.locator('#direction').fill('鋭く、短い語尾。');
  await panel.getByRole('radio', { name: 'Aを採用', exact: true }).check();
  await panel.getByLabel('選択理由（任意・1000文字まで）').fill('司書の落ち着きに合う。');
  await panel.getByRole('button', { name: '評価を記録', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'レシピをJSONで保存' }).click();
  const buffer = await downloadBuffer(await downloadEvent);
  const saved = JSON.parse(buffer.toString());
  expect(saved.characterInput.text).toBe('次に試したい案：厳格な衛兵。');
  expect(saved.profileInput).toEqual({ mode: 'text', text: setting, direction });
  expect(saved.evaluations[0].characterInput).toEqual(saved.profileInput);
  expect(saved.evaluations[0].evidence).toBeDefined();
  expect(saved.image).toBeUndefined();
  await page.reload();
  await page
    .getByLabel('レシピJSONファイル')
    .setInputFiles({ name: 'character.json', mimeType: 'application/json', buffer });
  await expect(page.locator('.recipe-notice')).toContainText('レシピを復元しました');
  await expect(page.getByRole('radio', { name: '設定テキストのみ', exact: true })).toBeChecked();
  await expect(page.locator('#character-setting')).toHaveValue('次に試したい案：厳格な衛兵。');
  await expect(page.locator('#recipe-speedScale')).toHaveValue('0.91');
  await expect(page.locator('.input-change-note')).toBeVisible();
  await page.getByRole('radio', { name: 'Ollama' }).check();
  await expect(page.locator('#direction')).toHaveValue('鋭く、短い語尾。');
  await page.getByRole('button', { name: '評価記録をまとめる' }).click();
  const aggregate = page.getByRole('region', { name: '評価記録の集計' });
  await aggregate.getByRole('button', { name: '現在の比較記録を追加（1件）' }).click();
  const record = aggregate.locator('.evaluation-records > li');
  await record.getByText('比較条件を見る', { exact: true }).click();
  await record.getByText('声の方向を作ったときの設定', { exact: true }).click();
  await expect(record).toContainText(setting);
  await expect(record).not.toContainText('厳格な衛兵');
  const csvEvent = page.waitForEvent('download');
  await aggregate.getByRole('button', { name: '絞り込み結果をCSVで保存' }).click();
  const csv = (await downloadBuffer(await csvEvent)).toString();
  expect(csv).toContain('"character_text"');
  expect(csv).toContain(setting);
  expect(csv).not.toContain('厳格な衛兵');
});

test('keeps manual discovery offline and explicitly requires manual interpretation of settings', async ({
  page,
}) => {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({
      json: {
        ...capabilities,
        ollama: { ...capabilities.ollama, textReady: false },
        openai: { ready: false, model: 'test' },
        anthropic: { ready: false, model: 'test' },
        gemini: { ready: false, model: 'test' },
      },
    }),
  );
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('radio', { name: '設定テキストのみ', exact: true }).check();
  await page.locator('#character-setting').fill(setting);
  await expect(page.locator('.mode-note')).toContainText('設定の意図は4軸に手動で反映');
  await page.getByRole('slider', { name: '声の高さ', exact: true }).fill('25');
  await page.getByRole('button', { name: 'このイメージで声を探す' }).click();
  await expect(page.locator('.voice-card')).toHaveCount(24);
  expect(posts).toEqual([]);
});

test('retains text input and avoids invented results when the model requests more detail', async ({
  page,
}) => {
  await page.route('**/api/analyze', (route) =>
    route.fulfill({
      json: {
        analysis: {
          ...analysis,
          subjectFound: false,
          summary: 'キャラクターの役柄や話し方を追記してください。',
        },
        provider: 'ollama',
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('radio', { name: '設定テキストのみ', exact: true }).check();
  await page.locator('#character-setting').fill('まだ決めていない。');
  await page.getByRole('radio', { name: 'Ollama' }).check();
  await page.getByRole('button', { name: '設定から声の演出案を作る', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('役柄や話し方を追記');
  await expect(page.locator('.analysis-card')).toHaveCount(0);
  await expect(page.locator('#character-setting')).toHaveValue('まだ決めていない。');
});
