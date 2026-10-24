import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { voices } from '../shared/catalog';
const unavailable = {
  ollama: { ready: false, model: 'test', detail: '未接続' },
  openai: { ready: false, model: 'test' },
  anthropic: { ready: false, model: 'test-claude' },
  gemini: { ready: false, model: 'test-gemini' },
  deepseek: { ready: false, model: 'test-deepseek' },
  voicevox: { ready: false, detail: '未接続' },
};
test.beforeEach(async ({ page }) => {
  await page.route('**/api/capabilities', (route) => route.fulfill({ json: unavailable }));
});
test('manual discovery, filters, detail guides and empty-state recovery', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('button', { name: '明るく、親しみやすく' }).click();
  await expect(page.getByRole('heading', { name: 'あなたの演出に、近い声。' })).toBeVisible();
  await expect(page.locator('.voice-card')).toHaveCount(24);
  await page.getByLabel('ソフトで絞り込む').selectOption('A.I.VOICE2');
  await expect(page.locator('.voice-card')).toHaveCount(2);
  await expect(page.getByRole('heading', { name: '調声ガイド', exact: true })).toBeVisible();
  await page.getByLabel('無料のみ').check();
  await expect(page.getByRole('heading', { name: 'この条件の候補はありません' })).toBeVisible();
  await page.getByRole('button', { name: '絞り込みをリセット' }).click();
  await expect(page.locator('.voice-card')).toHaveCount(24);
  expect(errors).toEqual([]);
});
test('exports the chosen voice and edited recipe without embedding the image', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '凛と、落ち着いて' }).click();
  await page.getByLabel('ソフトで絞り込む').selectOption('VOICEVOX');
  await expect(page.locator('#recipe-speedScale')).toBeVisible();
  await page.locator('#recipe-speedScale').fill('0.88');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'レシピをJSONで保存' }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const result = JSON.parse(Buffer.concat(chunks).toString());
  expect(result.parameters.speedScale).toBe(0.88);
  expect(result.voice.engine).toBe('VOICEVOX');
  expect(result.manuallyAdjusted).toBe(true);
  expect(result.image).toBeUndefined();
});
for (const { provider, label, display } of [
  { provider: 'openai', label: 'OpenAI', display: 'OpenAI' },
  { provider: 'anthropic', label: 'Claude', display: 'Anthropic（Claude）' },
  { provider: 'gemini', label: 'Gemini', display: 'Google（Gemini）' },
  { provider: 'deepseek', label: 'DeepSeek', display: 'DeepSeek' },
]) {
  test(`${label} image analysis requires provider-specific consent`, async ({ page }) => {
    await page.route('**/api/capabilities', (route) =>
      route.fulfill({
        json: {
          ...unavailable,
          openai: { ready: true, model: 'test-openai' },
          anthropic: { ready: true, model: 'test-claude' },
          gemini: { ready: true, model: 'test-gemini' },
          deepseek: { ready: true, model: 'test-deepseek' },
        },
      }),
    );
    await page.goto('/');
    const image = await sharp({
      create: { width: 64, height: 80, channels: 3, background: '#81a292' },
    })
      .png()
      .toBuffer();
    await page
      .locator('#character-image')
      .setInputFiles({ name: 'test-character.png', mimeType: 'image/png', buffer: image });
    await page.getByRole('radio', { name: label }).check();
    await expect(page.getByRole('button', { name: '画像から声の演出案を作る' })).toBeDisabled();
    await page.locator('#direction').fill('落ち着いた案内役');
    let sent = false;
    await page.route('**/api/analyze', async (route) => {
      const input = route.request().postDataJSON();
      expect(input.provider).toBe(provider);
      expect(input.consent).toBe(true);
      expect(input.direction).toBe('落ち着いた案内役');
      expect(input.image).toMatch(/^data:image\/png;base64,/);
      sent = true;
      await route.fulfill({
        json: {
          analysis: {
            subjectFound: true,
            summary: '凛とした案内役という演出案です。',
            cues: ['緑の配色'],
            delivery: '落ち着いたテンポで。',
            profile: { pitch: 30, energy: 35, warmth: 45, airiness: 30 },
          },
          provider,
        },
      });
    });
    await page
      .getByRole('checkbox', {
        name: `画像と補足を${display}に送信することに同意する（API利用料がかかる場合があります）`,
        exact: true,
      })
      .check();
    await page.getByRole('button', { name: '画像から声の演出案を作る' }).click();
    await expect(page.getByText('凛とした案内役という演出案です。')).toBeVisible();
    expect(sent).toBe(true);
    await expect(page.locator('.source-badge')).toContainText(`${display}で解析`);
    await page.getByRole('slider', { name: '声の高さ', exact: true }).fill('55');
    await expect(page.locator('.source-badge')).toContainText('調整済み');
    await page.getByRole('radio', { name: label === 'Claude' ? 'OpenAI' : 'Claude' }).check();
    await expect(page.locator('.consent input')).not.toBeChecked();
    await expect(page.getByRole('button', { name: '画像から声の演出案を作る' })).toBeDisabled();
    await page.getByRole('radio', { name: label }).check();
    await expect(page.locator('.consent input')).not.toBeChecked();
  });
}
test('Claude setup shows how to configure the server key without horizontal overflow', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Claude' }).check();
  await page.getByRole('button', { name: '接続設定を開く' }).click();
  const settings = page.getByRole('region', { name: '接続設定' });
  await expect(settings.getByText('Anthropic（Claude）', { exact: true })).toBeVisible();
  await expect(settings.getByText('ANTHROPIC_API_KEY=…')).toBeVisible();
  await expect(settings.getByText(/モデル: test-claude/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: '接続設定を閉じる' }).click();
  await expect(page.getByRole('button', { name: '画像から声の演出案を作る' })).toBeDisabled();
});
test('Gemini setup shows how to configure the server key without horizontal overflow', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Gemini' }).check();
  await page.getByRole('button', { name: '接続設定を開く' }).click();
  const settings = page.getByRole('region', { name: '接続設定' });
  await expect(settings.getByText('Google（Gemini）', { exact: true })).toBeVisible();
  await expect(settings.getByText('GEMINI_API_KEY=…')).toBeVisible();
  await expect(settings.getByText(/モデル: test-gemini/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: '接続設定を閉じる' }).click();
  await expect(page.getByRole('button', { name: '画像から声の演出案を作る' })).toBeDisabled();
});
test('DeepSeek setup shows the server key and configured model', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('radio', { name: 'DeepSeek' }).check();
  await page.getByRole('button', { name: '接続設定を開く' }).click();
  const settings = page.getByRole('region', { name: '接続設定' });
  await expect(settings.getByText('DeepSeek', { exact: true })).toBeVisible();
  await expect(settings.getByText('DEEPSEEK_API_KEY=…')).toBeVisible();
  await expect(settings.getByText(/モデル: test-deepseek/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('handles model failure without showing invented analysis', async ({ page }) => {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({
      json: { ...unavailable, ollama: { ready: true, model: 'test', detail: '接続済み' } },
    }),
  );
  await page.route('**/api/analyze', (route) =>
    route.fulfill({ status: 502, json: { error: 'テスト用の接続エラー' } }),
  );
  await page.goto('/');
  const image = await sharp({
    create: { width: 20, height: 20, channels: 3, background: '#829f70' },
  })
    .png()
    .toBuffer();
  await page
    .locator('#character-image')
    .setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: image });
  await page.getByRole('radio', { name: 'Ollama' }).check();
  await page.getByRole('button', { name: '画像から声の演出案を作る' }).click();
  await expect(page.getByRole('alert')).toContainText('テスト用の接続エラー');
  await expect(page.getByRole('heading', { name: 'まだ声のない、その物語に。' })).toBeVisible();
});
test('stays within the viewport on home and recommendation screens', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'そっと、ささやく' }).click();
  await expect(page.locator('#recipe-pitchScale')).toHaveValue('0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('previews edited settings and invalidates audio after further editing', async ({ page }) => {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({
      json: {
        ...unavailable,
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
  let received = false;
  await page.route('**/api/preview', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.recipe.speedScale).toBe(0.91);
    expect(body.text).toBe('試聴テストです。');
    received = true;
    const pcm = Buffer.alloc(4800);
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(24000, 24);
    header.writeUInt32LE(48000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    await route.fulfill({ contentType: 'audio/wav', body: Buffer.concat([header, pcm]) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '凛と、落ち着いて' }).click();
  await page.getByLabel('ソフトで絞り込む').selectOption('VOICEVOX');
  await page.locator('#recipe-speedScale').fill('0.91');
  await page.locator('#preview-text').fill('試聴テストです。');
  await page.getByRole('button', { name: 'VOICEVOXで音声を生成' }).click();
  await expect(page.locator('.audio-result audio')).toBeVisible();
  expect(received).toBe(true);
  await expect(page.getByRole('link', { name: 'WAVを保存' })).toBeVisible();
  await page.locator('#recipe-speedScale').fill('0.92');
  await expect(page.locator('.audio-result')).toHaveCount(0);
});

test('help works with focus, Escape and touch without viewport overflow', async ({ page }) => {
  await page.goto('/');
  const help = page.getByRole('button', { name: '声の高さのヘルプ', exact: true });
  await help.focus();
  await expect(page.getByRole('tooltip')).toContainText('候補の順位');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await help.click();
  await expect(page.getByRole('tooltip')).toBeVisible();
  const bounds = await page.getByRole('tooltip').boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '凛と、落ち着いて' }).click();
  await page.getByLabel('ソフトで絞り込む').selectOption('VOICEVOX');
  const pitchHelp = page.getByRole('button', { name: '音高のヘルプ', exact: true });
  if (test.info().project.name === 'mobile') await pitchHelp.tap();
  else await pitchHelp.hover();
  await expect(page.getByRole('tooltip')).toContainText('0が元の音高');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('production serves a restricted document and immutable bundled assets', async ({ page }) => {
  const response = await page.goto('/');
  const headers = response!.headers();
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['content-security-policy']).toContain("script-src 'self'");
  const source = await page.locator('script[src]').first().getAttribute('src');
  const asset = await page.request.get(source!);
  expect(asset.headers()['cache-control']).toContain('immutable');
  expect(headers['cache-control']).not.toContain('immutable');
});
