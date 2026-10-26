import { test, expect, type Page, type Route } from '@playwright/test';
import { elevenLabsScriptFixture } from '../tests/fixtures/elevenlabs-script';
import { projectFixture } from '../tests/fixtures/project';
import { projectStorageKey } from '../shared/project';
import { scriptCandidate } from '../shared/script';
import { parseProjectArchive } from '../shared/project-archive';
import { pcmWav } from '../tests/fixtures/wav';
import { serializeLibraryComparison } from '../shared/library-comparison';

const base = elevenLabsScriptFixture();
const project = projectFixture();
project.documents.script = base.script;
project.documents.castingBoard.assignments = base.assignments;
const checkedAt = project.createdAt;
async function setup(page: Page, seed = true, ready = true) {
  if (seed)
    await page.addInitScript(
      ({ key, value }) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      },
      { key: projectStorageKey, value: JSON.stringify(project) },
    );
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt,
        engines: ['VOICEVOX', 'ElevenLabs'].map((engine) => ({
          engine,
          ready,
          detail: ready ? '接続済み' : '未接続',
        })),
        // Cloud voices are paged separately and never included in the local inventory.
        voices: ready ? [scriptCandidate(base.script.lines[1])!.voice] : [],
      },
    }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({ json: { ready: false, checkedAt, models: [] } }),
  );
  await page.route('**/api/casting/elevenlabs/models', (route) =>
    route.fulfill({
      json: { ready, detail: ready ? '取得済み' : '未設定', checkedAt, models: [] },
    }),
  );
  await page.route('**/api/casting/elevenlabs/voices?*', (route) =>
    route.fulfill({ json: { voices: [], hasMore: false, nextCursor: null } }),
  );
}
async function openScript(page: Page) {
  await page.getByRole('button', { name: '台本へ進む', exact: true }).click();
  return page.getByRole('region', { name: '台本の試聴', exact: true });
}
async function wav(route: Route) {
  const body = route.request().postDataJSON();
  await route.fulfill({
    contentType: 'audio/wav',
    body: Buffer.from(pcmWav(Array(2400).fill(100))),
    headers: {
      'X-Voice-Atlas-Generation': encodeURIComponent(
        JSON.stringify({
          engine: body.candidate.voice.engine,
          engineVersion: null,
          checkedAt,
          ...(body.candidate.voice.engine === 'ElevenLabs'
            ? { modelId: body.candidate.recipe.modelId, outputFormat: 'pcm_22050', seed: 42 }
            : {}),
        }),
      ),
    },
  });
}
const reviewFor = (page: Page) =>
  page.getByRole('group', { name: 'ElevenLabsへの台本送信確認', exact: true });
async function confirm(page: Page) {
  await reviewFor(page)
    .getByRole('button', { name: '確認した行をElevenLabsへ送信して生成', exact: true })
    .click();
}

test('takes a chosen ElevenLabs comparison through casting and into an explicitly confirmed script request', async ({
  page,
}) => {
  await setup(page, false);
  const calls: unknown[] = [];
  await page.route('**/api/casting/preview', async (route) => {
    calls.push(route.request().postDataJSON());
    await wav(route);
  });
  await page.goto('/');
  await page.getByRole('button', { name: '配役へ進む', exact: true }).click();
  await page.getByLabel('設定比較JSONファイル').setInputFiles({
    name: 'chosen-cloud.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      serializeLibraryComparison({
        format: 'voice-atlas-library-comparison',
        version: 1,
        createdAt: checkedAt,
        entries: null,
        text: '',
        scene: '',
        reason: '',
        selectedId: null,
        records: [base.record],
      }),
    ),
  });
  const board = page.getByRole('region', { name: 'キャスティング表', exact: true });
  await board.getByLabel('キャスティングの比較記録').selectOption(base.record.id);
  await board.getByLabel('キャスティングの作品名').fill('物語');
  await board.getByRole('button', { name: 'キャスティングを確定して保存', exact: true }).click();
  const panel = await openScript(page);
  await panel.getByRole('button', { name: '台本に行を追加', exact: true }).click();
  await panel
    .getByLabel('第1行の声', { exact: true })
    .selectOption({ label: '物語 / 案内人 / 導入' });
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('配役した声で話します。');
  await panel.getByRole('button', { name: '第1行を生成', exact: true }).click();
  expect(calls).toHaveLength(0);
  await confirm(page);
  await expect(panel.locator(':scope > ol audio')).toHaveCount(1);
  expect(calls).toEqual([{ candidate: base.cloud, text: '配役した声で話します。' }]);
});

test('confirms mixed generation and explicit retries, archives native settings and restores cloud audio offline', async ({
  page,
  browser,
}, testInfo) => {
  await setup(page);
  const calls: { text: string; candidate: typeof base.cloud }[] = [];
  await page.route('**/api/casting/preview', async (route) => {
    calls.push(route.request().postDataJSON());
    if (calls.length === 3)
      await route.fulfill({
        status: 429,
        json: { error: 'ElevenLabsの利用枠を確認してください。' },
      });
    else await wav(route);
  });
  await page.goto('/');
  const panel = await openScript(page);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  const review = reviewFor(page);
  await expect(review).toContainText('今回の生成は3行');
  await expect(review.getByRole('listitem')).toHaveCount(2);
  await expect(review).toContainText('ほしよみのとうへ。');
  await expect(review).toContainText('saved-japanese');
  await expect(review).toContainText('saved_cloud_voice');
  await expect(review).toContainText('利用枠を消費');
  expect(calls).toHaveLength(0);
  await review.screenshot({ path: testInfo.outputPath('cloud-script-confirmation.png') });
  await confirm(page);
  const progress = panel.getByRole('region', { name: '台本の生成状況', exact: true });
  await expect(progress).toContainText('失敗1行');
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  expect(calls.map((call) => call.text)).toEqual([
    'ほしよみのとうへ。',
    '案内を頼もう。',
    'こちらです。',
  ]);
  expect(calls[0].candidate).toEqual(base.cloud);
  const firstUrl = await panel.getByLabel('台本の第1行の試聴', { exact: true }).getAttribute('src');
  await progress.getByRole('button', { name: '失敗した行だけ再試行', exact: true }).click();
  await expect(review.getByRole('listitem')).toHaveCount(1);
  await expect(review).toContainText('第3行');
  expect(calls).toHaveLength(3);
  await confirm(page);
  await expect(panel.locator(':scope > ol audio')).toHaveCount(3);
  expect(calls).toHaveLength(4);
  await expect(panel.getByLabel('台本の第1行の試聴', { exact: true })).toHaveAttribute(
    'src',
    firstUrl!,
  );
  await page.getByRole('button', { name: '保存・再開へ進む', exact: true }).click();
  const projectPanel = page.getByRole('region', { name: '作品の保存と復元', exact: true });
  await projectPanel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  await panel.getByText('台本音声の保存と再利用', { exact: true }).click();
  await panel.getByRole('button', { name: '台本音声をブラウザに保存', exact: true }).click();
  await expect(panel).toContainText('3行の音声をこのブラウザに保存しました');
  const downloading = page.waitForEvent('download');
  await projectPanel
    .getByRole('button', { name: '音声付き作品アーカイブを書き出す', exact: true })
    .click();
  const stream = await (await downloading).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const archive = Buffer.concat(chunks);
  const decoded = await parseProjectArchive(new Blob([archive]));
  expect(scriptCandidate(decoded.project.documents.script!.lines[0])).toEqual(base.cloud);
  expect(decoded.audio[0].audition.generation).toMatchObject({
    engine: 'ElevenLabs',
    modelId: 'saved-japanese',
    seed: 42,
  });
  const context = await browser.newContext({
    viewport: testInfo.project.use.viewport,
    isMobile: testInfo.project.use.isMobile,
    hasTouch: testInfo.project.use.hasTouch,
  });
  try {
    const other = await context.newPage();
    await setup(other, false, false);
    let unexpected = 0;
    await other.route('**/api/casting/preview', (route) => {
      unexpected++;
      return route.fulfill({ status: 503, json: { error: '未接続' } });
    });
    await other.goto('/');
    await other.getByText('作品を保存・復元する', { exact: true }).click();
    const restore = other.getByRole('region', { name: '作品の保存と復元', exact: true });
    await restore.getByLabel('作品アーカイブファイル').setInputFiles({
      name: 'cloud.vaarchive',
      mimeType: 'application/octet-stream',
      buffer: archive,
    });
    await restore.getByRole('button', { name: '確認した音声付き作品を復元', exact: true }).click();
    const restored = await openScript(other);
    await expect(restored.locator(':scope > ol audio')).toHaveCount(3);
    await expect(
      restored.getByRole('button', { name: '第1行を再生成', exact: true }),
    ).toBeDisabled();
    await restored.getByLabel('第3行のセリフ', { exact: true }).fill('編集した文');
    await expect(restored.locator(':scope > ol audio')).toHaveCount(2);
    await expect(
      restored.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }),
    ).toBeDisabled();
    expect(unexpected).toBe(0);
  } finally {
    await context.close();
  }
});

test('cancels individual cloud generation and invalidates confirmation after editing, then regenerates only the changed row', async ({
  page,
}) => {
  await setup(page);
  const calls: string[] = [];
  await page.route('**/api/casting/preview', async (route) => {
    calls.push(route.request().postDataJSON().text);
    await wav(route);
  });
  await page.goto('/');
  const panel = await openScript(page);
  await panel.getByRole('button', { name: '第1行を生成', exact: true }).click();
  await reviewFor(page)
    .getByRole('button', { name: '台本の送信をキャンセル', exact: true })
    .click();
  expect(calls).toHaveLength(0);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(reviewFor(page)).toBeVisible();
  await panel.getByLabel('第2行を生成対象に含める', { exact: true }).uncheck();
  await expect(reviewFor(page)).toHaveCount(0);
  await panel.getByLabel('第2行を生成対象に含める', { exact: true }).check();
  await panel.getByRole('button', { name: '第1行を生成', exact: true }).click();
  await panel.getByLabel('第1行の読み上げ文', { exact: true }).fill('変更したよみ');
  await expect(reviewFor(page)).toContainText('台本が変更されました');
  await expect(
    reviewFor(page).getByRole('button', {
      name: '確認した行をElevenLabsへ送信して生成',
      exact: true,
    }),
  ).toBeDisabled();
  await panel.getByRole('button', { name: '第1行を生成', exact: true }).click();
  await expect(reviewFor(page)).toContainText('変更したよみ');
  await confirm(page);
  await expect(panel.locator(':scope > ol audio')).toHaveCount(1);
  await panel.getByRole('button', { name: '第1行を再生成', exact: true }).click();
  expect(calls).toEqual(['変更したよみ']);
  await confirm(page);
  await expect.poll(() => calls.length).toBe(2);
  await expect(panel.getByRole('button', { name: '第1行を再生成', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '第1行を再生成', exact: true }).click();
  await expect(reviewFor(page)).toBeVisible();
  await panel.getByRole('button', { name: '生成の記録を閉じる', exact: true }).click();
  await expect(reviewFor(page)).toHaveCount(0);
  expect(calls).toHaveLength(2);
  await panel.getByLabel('第1行の読み上げ文', { exact: true }).fill('さらに変更');
  await panel.getByLabel('第2行を生成対象に含める', { exact: true }).uncheck();
  await panel.getByLabel('第3行を生成対象に含める', { exact: true }).uncheck();
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(reviewFor(page).getByRole('listitem')).toHaveCount(1);
  await confirm(page);
  await expect.poll(() => calls).toEqual(['変更したよみ', '変更したよみ', 'さらに変更']);
});
