import { test, expect, type Page, type Locator } from '@playwright/test';
import { makeLibraryEntry, serializeLibrary } from '../shared/voice-library';
import { evaluationWithModelInfo, modelInfo } from '../tests/fixtures/aivis-model-info';
import { makeCastingSession } from '../tests/fixtures/casting';

const evaluation = evaluationWithModelInfo();
const source = makeLibraryEntry(evaluation, '案内人', '通常', '元のメモ');
function file(value: unknown) {
  return {
    name: 'voices.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(value)),
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
async function open(page: Page, single = false) {
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: evaluation.recordedAt,
        engines: [
          { engine: 'AivisSpeech', ready: true, detail: '接続済み' },
          { engine: 'VOICEVOX', ready: !single, detail: single ? '未接続' : '接続済み' },
        ],
        voices: (single ? [evaluation.candidates[0]] : evaluation.candidates).map((c) => c.voice),
      },
    }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({
      json: {
        ready: true,
        checkedAt: evaluation.recordedAt,
        models: [{ ...modelInfo(), modelVersion: '2.0.0' }],
      },
    }),
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await expect(page.getByText(/AivisSpeech：接続済み/)).toBeVisible();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  const library = page.getByRole('region', { name: '採用声ライブラリ', exact: true });
  await library
    .getByLabel('採用声ライブラリJSONファイル')
    .setInputFiles(file({ format: 'voice-atlas-voice-library', version: 1, entries: [source] }));
  await library.getByRole('button', { name: '候補Aに読み込む', exact: true }).click();
  return { library, candidate: page.getByRole('region', { name: '製品比較候補A', exact: true }) };
}
async function exportLibrary(page: Page, library: Locator) {
  const event = page.waitForEvent('download');
  await library.getByRole('button', { name: '採用声ライブラリJSONを保存', exact: true }).click();
  const stream = await (await event).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function fillVariant(candidate: Locator, setting = '長文説明用') {
  await candidate.getByLabel('派生声の設定名').fill(setting);
  await candidate.getByLabel('派生声の変更理由').fill('長い説明を聞き取りやすくするため');
  await candidate.getByLabel('派生声のメモ').fill('説明シーン向け');
}

test('compares original and adjusted settings with one installed voice and saves independent v2 provenance', async ({
  page,
}, testInfo) => {
  const requests: { candidate: { recipe: { speedScale: number } }; text: string }[] = [];
  await page.route('**/api/casting/preview', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: 'audio/wav',
      body: wav(),
      headers: {
        'X-Voice-Atlas-Generation': encodeURIComponent(
          JSON.stringify({
            engine: 'AivisSpeech',
            engineVersion: 'engine-2',
            checkedAt: evaluation.recordedAt,
          }),
        ),
      },
    });
  });
  const { library, candidate } = await open(page, true);
  await page.locator('#casting-A-speedScale').fill('0.7');
  await page.locator('#casting-text').fill('長い説明を落ち着いて伝えます。');
  await fillVariant(candidate);
  const save = candidate.getByRole('button', { name: '調整した声を別設定で保存', exact: true });
  await expect(save).toBeDisabled();
  await candidate.getByRole('button', { name: '元の設定と候補Aを生成', exact: true }).click();
  await expect(save).toBeEnabled();
  expect(requests.map((r) => r.candidate.recipe.speedScale)).toEqual([1, 0.7]);
  expect(requests.map((r) => r.text)).toEqual([
    '長い説明を落ち着いて伝えます。',
    '長い説明を落ち着いて伝えます。',
  ]);
  await expect(candidate.getByLabel('候補Aの元の設定の試聴', { exact: true })).toBeVisible();
  await expect(candidate.getByLabel('製品比較候補Aの試聴', { exact: true })).toBeVisible();
  await save.click();
  await expect(save).toBeDisabled();
  const saved = await exportLibrary(page, library);
  expect(saved.version).toBe(2);
  expect(saved.entries).toHaveLength(2);
  expect(saved.entries[0]).toEqual(source);
  const variant = saved.entries[1];
  expect(variant.evaluation).toEqual(source.evaluation);
  expect(variant.variation.parent.id).toBe(source.id);
  expect(variant.variation.candidate.recipe.speedScale).toBe(0.7);
  expect(variant.variation.candidate.modelInfo.modelVersion).toBe('2.0.0');
  expect(variant.variation.parent.candidate.modelInfo.modelVersion).toBe('1.2.3');
  expect(variant.variation.generation.engineVersion).toBe('engine-2');
  await page.locator('#casting-A-speedScale').fill('0.6');
  await fillVariant(candidate, 'さらに遅い説明');
  await expect(save).toBeDisabled();
  await page.locator('#casting-text').fill('別のセリフ');
  await expect(candidate.getByLabel('候補Aの元の設定の試聴', { exact: true })).toHaveCount(0);
  await page.reload();
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  const original = library
    .locator('li')
    .filter({ has: page.locator('strong', { hasText: '案内人 / 通常' }) });
  await original.getByRole('button', { name: '登録を削除', exact: true }).click();
  await original.getByRole('button', { name: 'この登録を削除する', exact: true }).click();
  const derived = library
    .locator('li')
    .filter({ has: page.locator('strong', { hasText: '案内人 / 長文説明用' }) });
  await derived.getByRole('button', { name: '候補Aに読み込む', exact: true }).click();
  await expect(page.locator('#casting-A-speedScale')).toHaveValue('0.7');
  await expect(page.locator('#casting-text')).toHaveValue(variant.variation.text);
  await expect(derived.getByText('派生元：案内人 / 通常', { exact: true })).toBeVisible();
  expect((await exportLibrary(page, library)).entries).toEqual([variant]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await candidate.screenshot({ path: testInfo.outputPath('voice-variation.png') });
});

test('saves after a single preview, retains unrelated settings and clears transient origin on session restore', async ({
  page,
}) => {
  let requests = 0;
  await page.route('**/api/casting/preview', (route) => {
    requests++;
    return route.fulfill({ contentType: 'audio/wav', body: wav() });
  });
  const { library, candidate } = await open(page);
  await page.locator('#casting-B-speedScale').fill('1.4');
  await page.locator('#casting-A-speedScale').fill('0.8');
  await fillVariant(candidate);
  await candidate.getByRole('button', { name: '候補Aの音声を生成', exact: true }).click();
  const save = candidate.getByRole('button', { name: '調整した声を別設定で保存', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  const beforeFailure = await exportLibrary(page, library);
  expect(beforeFailure.entries).toHaveLength(2);
  expect(beforeFailure.entries[1].variation.generation).toBeNull();
  await fillVariant(candidate, '別の説明用');
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('容量不足', 'QuotaExceededError');
    };
  });
  await save.click();
  await expect(candidate.getByRole('alert')).toBeVisible();
  expect((await exportLibrary(page, library)).entries).toEqual(beforeFailure.entries);
  await expect(page.locator('#casting-B-speedScale')).toHaveValue('1.4');
  expect(requests).toBe(1);
  await page
    .getByLabel('比較セッションJSONファイル')
    .setInputFiles(file(makeCastingSession([evaluation])));
  await expect(candidate.getByLabel('派生声の設定名')).toHaveCount(0);
  await expect(page.getByText('製品比較の評価記録：1件 / 100件', { exact: true })).toBeVisible();
});

test('failed or cancelled preview cannot create a new variant', async ({ page }) => {
  await page.route('**/api/casting/preview', (route) =>
    route.fulfill({ status: 502, json: { error: 'モデルを利用できません' } }),
  );
  const { library, candidate } = await open(page);
  await fillVariant(candidate);
  await candidate.getByRole('button', { name: '候補Aの音声を生成', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('モデルを利用できません');
  await expect(
    candidate.getByRole('button', { name: '調整した声を別設定で保存', exact: true }),
  ).toBeDisabled();
  let releasePreview!: () => void;
  let previewStarted!: () => void;
  const started = new Promise<void>((resolve) => (previewStarted = resolve));
  const release = new Promise<void>((resolve) => (releasePreview = resolve));
  await page.route('**/api/casting/preview', async (route) => {
    previewStarted();
    await release;
    await route.fulfill({ contentType: 'audio/wav', body: wav() }).catch(() => {});
  });
  try {
    await candidate.getByRole('button', { name: '元の設定と候補Aを生成', exact: true }).click();
    await started;
    await page.getByRole('button', { name: '製品比較の生成を中止', exact: true }).click();
  } finally {
    releasePreview();
  }
  await expect(
    candidate.getByRole('button', { name: '調整した声を別設定で保存', exact: true }),
  ).toBeDisabled();
  expect((await exportLibrary(page, library)).entries).toEqual([source]);
});
