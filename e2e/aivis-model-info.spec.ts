import { test, expect, type Page, type Locator } from '@playwright/test';
import { makeCastingEvaluation } from '../tests/fixtures/casting';
import { modelInfo } from '../tests/fixtures/aivis-model-info';
import type { AivisModelInfoResponse } from '../shared/aivis-model-info';
const evaluation = makeCastingEvaluation();
const info = modelInfo();
function response(): AivisModelInfoResponse {
  return { ready: true, checkedAt: info.checkedAt, models: [structuredClone(info)] };
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
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: info.checkedAt,
        engines: [
          { engine: 'AivisSpeech', ready: true, detail: '接続済み' },
          { engine: 'VOICEVOX', ready: true, detail: '接続済み' },
        ],
        voices: evaluation.candidates.map((candidate) => candidate.voice),
      },
    }),
  );
  await page.route('**/api/casting/preview', (route) => {
    expect(route.request().postDataJSON().candidate).not.toHaveProperty('modelInfo');
    return route.fulfill({ contentType: 'audio/wav', body: wav() });
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  const workspace = page.getByRole('region', { name: '製品横断の比較', exact: true });
  await expect(workspace.locator('#casting-A')).toBeVisible();
  return workspace;
}
async function save(page: Page, workspace: Locator) {
  const event = page.waitForEvent('download');
  await workspace.getByRole('button', { name: '比較セッションJSONを保存', exact: true }).click();
  const stream = await (await event).createReadStream(),
    chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('shows source model metadata and literal terms without executing markup or loading linked media', async ({
  page,
}) => {
  const payload = response();
  payload.models[0].licenseText =
    '# 利用条件\nクレジット：検証用制作者\n<script>window.modelInfoExecuted=true</script>\n![画像](https://example.com/private-image.png)';
  let external = 0;
  page.on('request', (request) => {
    if (request.url().startsWith('https://example.com')) external++;
  });
  await page.route('**/api/casting/aivis-models', (route) => route.fulfill({ json: payload }));
  const workspace = await open(page);
  const details = workspace.getByRole('region', { name: 'モデル・利用条件', exact: true });
  await expect(details.getByText('検証用モデル', { exact: true })).toBeVisible();
  await expect(details.getByText(/モデル版：1\.2\.3/)).toBeVisible();
  await expect(
    details.getByText('制作者（提供元の記載）：検証用制作者', { exact: true }),
  ).toBeVisible();
  await expect(
    details.getByText('情報源：AivisSpeechのモデル情報（取得時点）', { exact: true }),
  ).toBeVisible();
  await details.getByText('利用条件の本文（提供元の記載）', { exact: true }).click();
  await expect(details.locator('.model-license-text')).toContainText(
    '<script>window.modelInfoExecuted=true</script>',
  );
  expect(
    await page.evaluate(
      () => (window as unknown as { modelInfoExecuted?: boolean }).modelInfoExecuted,
    ),
  ).toBeUndefined();
  await expect(details.locator('img,script,iframe')).toHaveCount(0);
  await details.getByText('提供元の関連リンク', { exact: true }).click();
  const link = details.getByRole('link', { name: 'https://example.com/terms', exact: true });
  await expect(link).toHaveAttribute('href', 'https://example.com/terms');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(external).toBe(0);
  const saved = await save(page, workspace);
  expect(saved.candidates[0].modelInfo.licenseText).toBe(payload.models[0].licenseText);
  expect(saved.candidates[1]).not.toHaveProperty('modelInfo');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath('aivis-model-info.png'), fullPage: true });
});

test('keeps generation-time snapshots when model info changes and preserves saved/history information on restore', async ({
  page,
}) => {
  let previews = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/casting/preview') && request.method() === 'POST') previews++;
  });
  let payload = response();
  await page.route('**/api/casting/aivis-models', (route) => route.fulfill({ json: payload }));
  const workspace = await open(page);
  await expect(workspace.getByText('検証用モデル', { exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }).click();
  await expect(
    workspace.getByRole('button', { name: '製品比較の評価を記録', exact: true }),
  ).toBeEnabled();
  payload = response();
  payload.models[0].modelVersion = '2.0.0';
  payload.models[0].licenseText = '更新された条件';
  await workspace.getByRole('button', { name: 'モデル・利用条件を再確認', exact: true }).click();
  await expect(workspace.getByText(/モデル版：2\.0\.0/)).toBeVisible();
  await expect(workspace.locator('audio')).toHaveCount(2);
  await workspace.getByRole('radio', { name: 'Aを採用', exact: true }).check();
  await workspace.getByRole('button', { name: '製品比較の評価を記録', exact: true }).click();
  const firstSaved = await save(page, workspace);
  expect(firstSaved.candidates[0].modelInfo.modelVersion).toBe('1.2.3');
  expect(firstSaved.evaluations[0].candidates[0].modelInfo.modelVersion).toBe('1.2.3');
  await expect(workspace.getByText('この試聴音声のモデル版：1.2.3', { exact: true })).toBeVisible();
  await expect(
    workspace
      .getByRole('status')
      .filter({ hasText: '現在のモデル情報は音声生成時の確認情報と異なります' }),
  ).toBeVisible();
  await workspace.getByRole('button', { name: '候補Aの音声を再生成', exact: true }).click();
  await expect(workspace.getByText('この試聴音声のモデル版：2.0.0', { exact: true })).toBeVisible();
  expect(previews).toBe(3);
  const saved = await save(page, workspace);
  expect(saved.candidates[0].modelInfo.modelVersion).toBe('2.0.0');
  expect(saved.evaluations[0].candidates[0].modelInfo.modelVersion).toBe('1.2.3');

  await workspace.getByLabel('比較セッションJSONファイル', { exact: true }).setInputFiles({
    name: 'session.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  payload = response();
  payload.models[0].modelVersion = '3.0.0';
  payload.models[0].licenseText = 'さらに更新された条件';
  await workspace.getByRole('button', { name: 'モデル・利用条件を再確認', exact: true }).click();
  const details = workspace.getByRole('region', { name: 'モデル・利用条件', exact: true });
  await expect(details.getByText(/モデル版：3\.0\.0/)).toBeVisible();
  await expect(details.getByRole('status')).toContainText(
    '保存時からモデル情報または利用条件が変わっています',
  );
  await details.getByText('保存時のモデル情報・利用条件', { exact: true }).click();
  await expect(details.getByText(/モデル版：2\.0\.0/)).toBeVisible();
  const again = await save(page, workspace);
  expect(again.candidates[0].modelInfo.modelVersion).toBe('2.0.0');
  expect(again.evaluations[0].candidates[0].modelInfo.modelVersion).toBe('1.2.3');
  await workspace.getByRole('button', { name: '製品比較の履歴を集計する', exact: true }).click();
  const archive = workspace.getByRole('region', { name: '製品比較の履歴集計', exact: true });
  await archive
    .getByRole('button', { name: '現在の製品比較記録を追加（1件）', exact: true })
    .click();
  const historical = archive.getByRole('region', { name: '評価時のモデル・利用条件', exact: true });
  await expect(historical.getByText(/モデル版：1\.2\.3/)).toBeVisible();
  await archive.getByRole('button', { name: 'この採用声で比較を再開', exact: true }).click();
  expect((await save(page, workspace)).candidates[0].modelInfo.modelVersion).toBe('1.2.3');
});

test('allows comparison when the model endpoint is unavailable or invalid and clears stale current metadata', async ({
  page,
}) => {
  let payload: unknown = response();
  await page.route('**/api/casting/aivis-models', (route) => route.fulfill({ json: payload }));
  const workspace = await open(page);
  await expect(workspace.getByText('検証用モデル', { exact: true })).toBeVisible();
  payload = { ready: false, checkedAt: info.checkedAt, models: [] };
  await workspace.getByRole('button', { name: 'モデル・利用条件を再確認', exact: true }).click();
  await expect(
    workspace.getByText('現在のモデル情報は未取得です。', { exact: false }),
  ).toBeVisible();
  await expect(workspace.getByText('検証用モデル', { exact: true })).toHaveCount(0);
  await workspace.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }).click();
  await expect(workspace.locator('audio')).toHaveCount(2);
  const bad = response();
  bad.models[0].links = ['javascript:alert(1)'];
  payload = bad;
  await workspace.getByRole('button', { name: 'モデル・利用条件を再確認', exact: true }).click();
  await expect(
    workspace.getByText('現在のモデル情報は未取得です。', { exact: false }),
  ).toBeVisible();
  await expect(workspace.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(workspace.locator('audio')).toHaveCount(2);
  await workspace.getByRole('radio', { name: 'Aを採用', exact: true }).check();
  await workspace.getByRole('button', { name: '製品比較の評価を記録', exact: true }).click();
  expect((await save(page, workspace)).evaluations[0].candidates[0]).not.toHaveProperty(
    'modelInfo',
  );
});

test('distinguishes absent and omitted terms and rejects unsafe metadata in imported sessions atomically', async ({
  page,
}) => {
  const payload = response();
  payload.models[0].licenseStatus = 'not-provided';
  payload.models[0].licenseText = null;
  await page.route('**/api/casting/aivis-models', (route) => route.fulfill({ json: payload }));
  const workspace = await open(page);
  await expect(
    workspace.getByText('利用条件の本文は記載されていません。提供元に確認してください。', {
      exact: true,
    }),
  ).toBeVisible();
  payload.models[0].licenseStatus = 'omitted';
  await workspace.getByRole('button', { name: 'モデル・利用条件を再確認', exact: true }).click();
  await expect(
    workspace.getByText(
      '利用条件の本文は表示・保存上限を超えるため未掲載です。AivisSpeechで全文を確認してください。',
      { exact: true },
    ),
  ).toBeVisible();
  await page.locator('#casting-A-tempoDynamicsScale').fill('0.64');
  const saved = await save(page, workspace);
  saved.candidates[0].modelInfo.links = ['data:text/html,private'];
  saved.candidates[0].recipe.tempoDynamicsScale = 1.5;
  await workspace.getByLabel('比較セッションJSONファイル', { exact: true }).setInputFiles({
    name: 'unsafe.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(workspace.getByRole('alert')).toContainText('現在の作業は保持');
  await expect(page.locator('#casting-A-tempoDynamicsScale')).toHaveValue('0.64');
});
