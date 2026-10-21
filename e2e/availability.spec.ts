import { test, expect } from '@playwright/test';
import { voices, catalogReviewedAt } from '../shared/catalog';
import { makeRecipe } from '../shared/recommend';
import { neutralProfile } from '../shared/schema';

const providers = {
  ollama: { ready: false, model: 'test', detail: '未接続' },
  openai: { ready: false, model: 'test' },
  anthropic: { ready: false, model: 'test' },
  gemini: { ready: false, model: 'test' },
};
function connection(ids: string[], ready = true) {
  return {
    ...providers,
    voicevox: {
      ready,
      detail: ready ? '接続済み' : '未接続',
      availableVoiceIds: ids,
      checkedAt: '2026-10-21T00:00:00Z',
    },
  };
}

test('shows availability per style, filters playable candidates and refreshes without losing tuning', async ({
  page,
}) => {
  let caps = connection(['vv-metan', 'vv-ryusei', 'vv-ryusei-whisper']);
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') posts++;
  });
  await page.route('**/api/capabilities', (route) => route.fulfill({ json: caps }));
  await page.goto('/');
  await page.getByRole('button', { name: '凛と、落ち着いて' }).click();
  const cards = page.locator('.voice-card');
  await expect(cards).toHaveCount(24);
  await expect(cards.filter({ hasText: '試聴可能' })).toHaveCount(3);
  await expect(cards.filter({ hasText: '未導入' })).toHaveCount(17);
  await expect(cards.filter({ hasText: 'アプリ内試聴対象外' })).toHaveCount(4);
  const metanWhisper = cards
    .filter({ has: page.getByRole('heading', { name: '四国めたん', exact: true }) })
    .filter({ hasText: 'ささやき' });
  await metanWhisper.click();
  const detail = page.getByRole('region', { name: '調声レシピ' });
  await expect(detail.locator('.availability-badge')).toHaveText('未導入');
  await expect(detail.getByRole('button', { name: 'VOICEVOXで音声を生成' })).toBeDisabled();
  await expect(detail.locator('.availability-help')).toContainText('音声ライブラリを確認');
  await page.locator('#recipe-speedScale').fill('0.87');
  await page.getByLabel('試聴可能のみ', { exact: true }).check();
  await expect(cards).toHaveCount(3);
  await page.getByLabel('ソフトで絞り込む').selectOption('COEIROINK');
  await expect(page.getByRole('heading', { name: 'この条件の候補はありません' })).toBeVisible();
  await page.getByLabel('ソフトで絞り込む').selectOption('all');
  caps = connection(['vv-metan', 'vv-metan-whisper']);
  await page.getByRole('button', { name: '接続を再確認', exact: true }).click();
  await expect(cards).toHaveCount(2);
  await expect(cards.filter({ hasText: '四国めたん' })).toHaveCount(2);
  await expect(page.locator('#recipe-speedScale')).toHaveValue('0.87');
  await expect(detail.locator('.availability-badge')).toHaveText('試聴可能');
  await expect(detail.getByRole('button', { name: 'VOICEVOXで音声を生成' })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('availability.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(posts).toBe(0);
});

test('blocks generation during refresh and clears stale availability on failed connection checks', async ({
  page,
}) => {
  let fail = false;
  let gate: Promise<void> | undefined;
  let release!: () => void;
  await page.route('**/api/capabilities', async (route) => {
    if (gate) await gate;
    if (fail) await route.fulfill({ status: 500, json: { error: 'offline' } });
    else await route.fulfill({ json: connection(['vv-ryusei']) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '凛と、落ち着いて' }).click();
  await page
    .locator('.voice-card')
    .filter({ hasText: '青山龍星' })
    .filter({ hasText: 'ノーマル' })
    .click();
  const generate = page.getByRole('button', { name: 'VOICEVOXで音声を生成' });
  await expect(generate).toBeEnabled();
  await page.locator('#recipe-speedScale').fill('0.89');
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.getByRole('button', { name: '接続を再確認', exact: true }).click();
  await expect(generate).toBeDisabled();
  await expect(page.locator('.voice-card .availability-checking')).toHaveCount(20);
  fail = true;
  release();
  await expect(page.getByRole('alert')).toContainText('接続状態を確認できませんでした');
  await expect(page.locator('.voice-card .availability-disconnected')).toHaveCount(20);
  await expect(generate).toBeDisabled();
  await expect(page.locator('#recipe-speedScale')).toHaveValue('0.89');
  await page.getByLabel('試聴可能のみ', { exact: true }).check();
  await expect(page.getByRole('heading', { name: 'この条件の候補はありません' })).toBeVisible();
  await page.getByRole('button', { name: '絞り込みをリセット' }).click();
  await expect(page.locator('.voice-card')).toHaveCount(24);
});

test('keeps unavailable restored candidates and their adjustments while filtering comparison choices', async ({
  page,
}) => {
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({ json: connection(['vv-ryusei', 'vv-ryusei-whisper']) }),
  );
  const voice = voices.find((item) => item.id === 'vv-metan-whisper')!;
  const parameters = { ...makeRecipe(neutralProfile, voice), speedScale: 0.86 };
  const normal = voices.find((item) => item.id === 'vv-metan')!;
  const saved = {
    format: 'voice-atlas-recipe',
    version: 2,
    createdAt: '2026-10-21T00:00:00Z',
    source: 'manual',
    manuallyAdjusted: true,
    voice,
    profile: neutralProfile,
    parameters,
    sampleText: '復元したセリフです。',
    catalogReviewedAt,
    preferences: { engine: 'VOICEVOX', budget: 'all' },
    candidates: [
      { voiceId: voice.id, parameters },
      { voiceId: normal.id, parameters: makeRecipe(neutralProfile, normal) },
    ],
    comparisonIds: [voice.id, normal.id],
    evaluations: [],
  };
  await page.goto('/');
  await page.getByRole('button', { name: '凛と、落ち着いて' }).click();
  await page.getByLabel('試聴可能のみ', { exact: true }).check();
  await page.getByLabel('レシピJSONファイル').setInputFiles({
    name: 'uninstalled.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(page.locator('.recipe-notice')).toContainText('レシピを復元しました');
  await expect(page.getByLabel('試聴可能のみ', { exact: true })).not.toBeChecked();
  await expect(page.locator('.voice-card.selected')).toContainText('未導入');
  await expect(page.locator('#recipe-speedScale')).toHaveValue('0.86');
  const panel = page.getByRole('region', { name: '2候補の比較試聴' });
  await expect(panel.getByRole('button', { name: 'A・Bの比較音声を生成' })).toBeDisabled();
  await page.getByLabel('試聴可能のみ', { exact: true }).check();
  await expect(panel.getByLabel('候補A', { exact: true })).toHaveValue(voice.id);
  await expect(page.locator('#compare-A-speedScale')).toHaveValue('0.86');
  await expect(panel.getByLabel('候補A', { exact: true }).locator('option')).toHaveCount(3);
  await panel.getByLabel('候補B', { exact: true }).selectOption('vv-ryusei');
  await expect(panel.getByRole('button', { name: 'A・Bの比較音声を生成' })).toBeDisabled();
  await panel.getByLabel('候補A', { exact: true }).selectOption('vv-ryusei-whisper');
  await expect(panel.getByRole('button', { name: 'A・Bの比較音声を生成' })).toBeEnabled();
  await page.getByLabel('試聴可能のみ', { exact: true }).uncheck();
  await panel.getByLabel('候補A', { exact: true }).selectOption(voice.id);
  await expect(page.locator('#compare-A-speedScale')).toHaveValue('0.86');
});

test('distinguishes no installed catalog styles from a disconnected engine', async ({ page }) => {
  let ready = true;
  await page.route('**/api/capabilities', (route) =>
    route.fulfill({ json: connection([], ready) }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '明るく、親しみやすく' }).click();
  await expect(page.locator('.voice-card .availability-missing')).toHaveCount(20);
  await expect(page.locator('.availability-summary')).toContainText('試聴可能 0 / 20候補');
  ready = false;
  await page.getByRole('button', { name: '接続を再確認', exact: true }).click();
  await expect(page.locator('.voice-card .availability-disconnected')).toHaveCount(20);
  await expect(page.locator('.availability-summary')).toContainText('未接続');
});
