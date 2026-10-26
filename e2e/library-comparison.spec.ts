import { test, expect, type Page, type Locator } from '@playwright/test';
import {
  makeLibraryEntry,
  makeVoiceVariation,
  libraryCandidate,
  serializeLibrary,
} from '../shared/voice-library';
import {
  libraryComparisonStorageKey,
  makeLibraryComparisonRecord,
} from '../shared/library-comparison';
import { evaluationWithModelInfo, modelInfo } from '../tests/fixtures/aivis-model-info';
import { makeCastingEvaluation } from '../tests/fixtures/casting';

const source = makeLibraryEntry(evaluationWithModelInfo(), '案内人', '通常', '元の設定');
const adjusted = structuredClone(libraryCandidate(source));
adjusted.recipe.speedScale = 0.7;
const variant = makeVoiceVariation(
  source,
  {
    candidate: adjusted,
    text: '説明文',
    generation: null,
    profile: source.evaluation.profile,
    characterInput: null,
    reason: '長文用',
  },
  '長文説明用',
  '説明向け',
);
const vv = makeLibraryEntry(makeCastingEvaluation({ outcome: 'b' }), '騎士', '通常', '');
function file(value: unknown) {
  return {
    name: 'settings.json',
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
async function open(page: Page) {
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: source.createdAt,
        engines: [
          { engine: 'AivisSpeech', ready: true, detail: '接続済み' },
          { engine: 'VOICEVOX', ready: true, detail: '接続済み' },
        ],
        voices: [libraryCandidate(source).voice, libraryCandidate(vv).voice],
      },
    }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({
      json: {
        ready: true,
        checkedAt: source.createdAt,
        models: [{ ...modelInfo(), modelVersion: '2.0.0' }],
      },
    }),
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await expect(page.locator('#casting-A')).toBeVisible();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  const library = page.getByRole('region', { name: '採用声ライブラリ', exact: true });
  await library
    .getByLabel('採用声ライブラリJSONファイル')
    .setInputFiles(file(JSON.parse(serializeLibrary([source, variant, vv]))));
  const comparison = page.getByRole('region', { name: '保存した設定の比較', exact: true });
  await comparison.getByLabel('設定比較の登録A').selectOption(source.id);
  await comparison.getByLabel('設定比較の登録B').selectOption(variant.id);
  await comparison.getByRole('button', { name: '選んだ2設定で比較を開始', exact: true }).click();
  return { library, comparison };
}
async function exported(page: Page, comparison: Locator) {
  const event = page.waitForEvent('download');
  await comparison.getByRole('button', { name: '設定比較JSONを保存', exact: true }).click();
  const stream = await (await event).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function choose(comparison: Locator) {
  await comparison.getByRole('radio', { name: /^保存設定Bを使用する/ }).check();
  await comparison.getByLabel('設定比較の使用場面').fill('長い場面説明');
  await comparison.getByLabel('設定比較の選択理由').fill('間を取りやすく、説明が聞きやすい');
}

test('compares two settings of the same voice and preserves chosen ID and snapshots through edits, reload and JSON', async ({
  page,
}, testInfo) => {
  const calls: { candidate: { recipe: { speedScale: number } }; text: string }[] = [];
  await page.route('**/api/casting/preview', (route) => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: 'audio/wav',
      body: wav(),
      headers: {
        'X-Voice-Atlas-Generation': encodeURIComponent(
          JSON.stringify({
            engine: 'AivisSpeech',
            engineVersion: 'engine-test',
            checkedAt: source.createdAt,
          }),
        ),
      },
    });
  });
  const { library, comparison } = await open(page);
  await page.locator('#casting-A-speedScale').fill('1.3');
  await comparison.getByLabel('保存した設定の共通セリフ').fill('この先には古い城があります。');
  await expect(comparison.getByText('B − A：-0.30', { exact: true })).toBeVisible();
  await comparison.getByRole('button', { name: '保存設定のA・Bを生成', exact: true }).click();
  await expect(comparison.getByLabel('保存設定Bの試聴', { exact: true })).toBeVisible();
  expect(calls.map((c) => c.candidate.recipe.speedScale)).toEqual([1, 0.7]);
  expect(calls.map((c) => c.text)).toEqual([
    'この先には古い城があります。',
    'この先には古い城があります。',
  ]);
  const original = library
    .locator(':scope > ol > li')
    .filter({ has: page.locator('strong', { hasText: '案内人 / 通常' }) });
  await original.getByRole('button', { name: '登録を編集', exact: true }).click();
  await library.getByLabel('ライブラリの設定名').fill('あとで改名');
  await library.getByRole('button', { name: '採用声の編集を保存', exact: true }).click();
  await expect(
    comparison.getByRole('heading', { name: 'A：案内人 / 通常（AivisSpeech）', exact: true }),
  ).toBeVisible();
  await choose(comparison);
  await comparison.getByRole('button', { name: '使用する保存設定を記録', exact: true }).click();
  await expect(
    comparison.getByRole('status').filter({ hasText: '保存設定の比較記録：1件' }),
  ).toBeVisible();
  const saved = await exported(page, comparison);
  expect(saved.records[0].selectedId).toBe(variant.id);
  expect(saved.records[0].entries).toEqual([source, variant]);
  expect(saved.records[0].auditions[0].modelInfo.modelVersion).toBe('2.0.0');
  expect(saved.records[0].entries[0].evaluation.candidates[0].modelInfo.modelVersion).toBe('1.2.3');
  await expect(page.locator('#casting-A-speedScale')).toHaveValue('1.3');
  await comparison.screenshot({ path: testInfo.outputPath('library-comparison.png') });
  await page.reload();
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await expect(
    comparison.getByRole('status').filter({ hasText: '保存設定の比較記録：1件' }),
  ).toBeVisible();
  await expect(comparison.getByLabel('保存設定Aの試聴', { exact: true })).toHaveCount(0);
  const current = library
    .locator(':scope > ol > li')
    .filter({ has: page.locator('strong', { hasText: '案内人 / あとで改名' }) });
  await current.getByRole('button', { name: '登録を削除', exact: true }).click();
  await current.getByRole('button', { name: 'この登録を削除する', exact: true }).click();
  await comparison.getByLabel('設定比較JSONファイル').setInputFiles(file(saved));
  await expect(
    comparison.getByRole('button', { name: '使用する保存設定を記録', exact: true }),
  ).toBeDisabled();
  expect((await exported(page, comparison)).records).toEqual(saved.records);
  await comparison.getByRole('button', { name: 'この記録で比較を再開', exact: true }).click();
  await expect(
    comparison.getByRole('heading', { name: 'A：案内人 / 通常（AivisSpeech）', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(calls).toHaveLength(2);
});

test('retains partial audio, retries only failure and invalidates both previews when the common text changes', async ({
  page,
}) => {
  const calls: number[] = [];
  let fail = true;
  await page.route('**/api/casting/preview', (route) => {
    const speed = route.request().postDataJSON().candidate.recipe.speedScale;
    calls.push(speed);
    if (speed === 0.7 && fail)
      return route.fulfill({ status: 502, json: { error: 'Bの生成に失敗' } });
    return route.fulfill({ contentType: 'audio/wav', body: wav() });
  });
  const { comparison } = await open(page);
  await comparison.getByRole('button', { name: '保存設定のA・Bを生成', exact: true }).click();
  await expect(comparison.getByRole('alert')).toContainText('Bの生成に失敗');
  const audioA = await comparison
    .getByLabel('保存設定Aの試聴', { exact: true })
    .getAttribute('src');
  await expect(
    comparison.getByRole('button', { name: '使用する保存設定を記録', exact: true }),
  ).toBeDisabled();
  fail = false;
  await comparison.getByRole('button', { name: '保存設定のA・Bを生成', exact: true }).click();
  await expect(comparison.getByLabel('保存設定Bの試聴', { exact: true })).toBeVisible();
  expect(calls).toEqual([1, 0.7, 0.7]);
  expect(await comparison.getByLabel('保存設定Aの試聴', { exact: true }).getAttribute('src')).toBe(
    audioA,
  );
  await choose(comparison);
  await comparison.getByLabel('保存した設定の共通セリフ').fill('違うセリフ');
  await expect(comparison.getByLabel('保存設定Aの試聴', { exact: true })).toHaveCount(0);
  await expect(comparison.getByLabel('保存設定Bの試聴', { exact: true })).toHaveCount(0);
  await expect(
    comparison.getByRole('button', { name: '使用する保存設定を記録', exact: true }),
  ).toBeDisabled();
  await comparison.getByRole('button', { name: '保存設定のA・Bを生成', exact: true }).click();
  await expect(comparison.getByLabel('保存設定Bの試聴', { exact: true })).toBeVisible();
  await choose(comparison);
  await comparison.getByRole('button', { name: '使用する保存設定を記録', exact: true }).click();
  const saved = await exported(page, comparison);
  expect(saved.records[0].auditions).toEqual([
    { generation: null, modelInfo: expect.any(Object) },
    { generation: null, modelInfo: expect.any(Object) },
  ]);
});

test('shows native cross-product values and preserves current comparison after invalid imports or storage failure', async ({
  page,
}) => {
  await page.route('**/api/casting/preview', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: wav() }),
  );
  const { comparison } = await open(page);
  await comparison.getByLabel('設定比較の登録B').selectOption(vv.id);
  await comparison.getByRole('button', { name: '選んだ2設定で比較を開始', exact: true }).click();
  await expect(
    comparison.getByText('製品によって項目の意味が異なるため、数値の差分・換算は行いません。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(comparison.getByText('A：感情表現の強さ：1.20倍', { exact: true })).toBeVisible();
  await expect(comparison.getByText(/^B − A：/)).toHaveCount(0);
  await comparison.getByLabel('保存した設定の共通セリフ').fill('現在の比較');
  const saved = await exported(page, comparison);
  await comparison
    .getByLabel('設定比較JSONファイル')
    .setInputFiles(file({ ...saved, version: 99 }));
  await expect(comparison.getByRole('alert')).toBeVisible();
  await expect(comparison.getByLabel('保存した設定の共通セリフ')).toHaveValue('現在の比較');
  const same = { ...saved, entries: [source, source] };
  await comparison.getByLabel('設定比較JSONファイル').setInputFiles(file(same));
  await expect(comparison.getByLabel('保存した設定の共通セリフ')).toHaveValue('現在の比較');
  await comparison.getByRole('button', { name: '保存設定のA・Bを生成', exact: true }).click();
  await expect(comparison.getByLabel('保存設定Bの試聴', { exact: true })).toBeVisible();
  await choose(comparison);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('容量不足', 'QuotaExceededError');
    };
  });
  await comparison.getByRole('button', { name: '使用する保存設定を記録', exact: true }).click();
  await expect(comparison.getByRole('alert')).toBeVisible();
  await expect(
    comparison.getByRole('status').filter({ hasText: '保存設定の比較記録：0件' }),
  ).toBeVisible();
  expect(
    await page.evaluate((key) => localStorage.getItem(key), libraryComparisonStorageKey),
  ).toBeNull();
});

test('cancels on closing the workspace, blocks concurrent generation, and recovers without changing registrations', async ({
  page,
}) => {
  let calls = 0;
  let hold = true;
  let release: (() => void) | undefined;
  await page.route('**/api/casting/preview', async (route) => {
    calls++;
    if (hold)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({ contentType: 'audio/wav', body: wav() }).catch(() => {});
  });
  const { comparison } = await open(page);
  await comparison.getByRole('button', { name: '保存設定のA・Bを生成', exact: true }).click();
  await expect.poll(() => calls).toBe(1);
  await expect(
    page.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }),
  ).toBeDisabled();
  await comparison.getByRole('button', { name: '保存設定の生成を中止', exact: true }).click();
  await expect(
    comparison.getByRole('button', { name: '保存設定のA・Bを生成', exact: true }),
  ).toBeEnabled();
  expect(calls).toBe(1);
  release!();
  await comparison.getByRole('button', { name: '保存設定のA・Bを生成', exact: true }).click();
  await expect.poll(() => calls).toBe(2);
  await page.getByRole('button', { name: '製品横断の比較を閉じる', exact: true }).click();
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await expect(
    comparison.getByRole('button', { name: '保存設定のA・Bを生成', exact: true }),
  ).toBeEnabled();
  release!();
  hold = false;
  await comparison.getByRole('button', { name: '保存設定のA・Bを生成', exact: true }).click();
  await expect(comparison.getByLabel('保存設定Bの試聴', { exact: true })).toBeVisible();
  expect((await exported(page, comparison)).records).toHaveLength(0);
});

test('preserves unavailable historical settings, paginates all records and resumes snapshots without synthesis', async ({
  page,
}) => {
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') posts++;
  });
  const { comparison } = await open(page);
  const removed = structuredClone(vv);
  const voice = libraryCandidate(removed).voice;
  if (voice.engine === 'VOICEVOX') voice.voiceId = 'removed-voice';
  const record = makeLibraryComparisonRecord({
    entries: [source, variant],
    text: '履歴のセリフ',
    scene: '場面',
    reason: '当時の選択',
    selectedId: variant.id,
    auditions: [{ generation: null }, { generation: null }],
  });
  const records = Array.from({ length: 26 }, () => ({ ...record, id: crypto.randomUUID() }));
  const saved = {
    format: 'voice-atlas-library-comparison',
    version: 1,
    createdAt: source.createdAt,
    entries: [source, removed],
    text: '保存した作業',
    scene: '',
    reason: '',
    selectedId: null,
    records,
  };
  await comparison.getByLabel('設定比較JSONファイル').setInputFiles(file(saved));
  await expect(comparison.getByText('現行カタログ対象外', { exact: true })).toBeVisible();
  await expect(
    comparison.getByRole('button', { name: '保存設定のA・Bを生成', exact: true }),
  ).toBeDisabled();
  await expect(
    comparison.getByRole('button', { name: 'この記録で比較を再開', exact: true }),
  ).toHaveCount(25);
  await comparison.getByRole('button', { name: '保存設定の次の記録', exact: true }).click();
  await expect(
    comparison.getByRole('button', { name: 'この記録で比較を再開', exact: true }),
  ).toHaveCount(1);
  expect((await exported(page, comparison)).records).toEqual(records);
  await comparison.getByRole('button', { name: 'この記録で比較を再開', exact: true }).click();
  await expect(comparison.getByLabel('保存した設定の共通セリフ')).toHaveValue('履歴のセリフ');
  await expect(
    comparison.getByRole('button', { name: '使用する保存設定を記録', exact: true }),
  ).toBeDisabled();
  expect(posts).toBe(0);
});
