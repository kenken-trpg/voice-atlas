import { test, expect, type Page } from '@playwright/test';
import { voices } from '../shared/catalog';

const checkedAt = '2026-10-26T01:00:00.000Z';
const local = {
  engine: 'VOICEVOX',
  voiceId: voices[0].id,
  name: voices[0].name,
  style: voices[0].style,
};
const cloudVoice = (voiceId: string, name: string) => ({
  engine: 'ElevenLabs',
  voiceId,
  name,
  style: 'default',
  category: 'premade',
});
const first = cloudVoice('cloud_first', '検索前の声');
const found = cloudVoice('cloud_found', '日本語の案内役');
const more = cloudVoice('cloud_more', '次の声');
const nextCursor = '11111111-1111-4111-8111-111111111111';
const models = [
  {
    modelId: 'english',
    name: 'English',
    canUseStyle: false,
    canUseSpeakerBoost: false,
    maxCharacters: 300,
    languages: [{ id: 'en', name: 'English' }],
  },
  {
    modelId: 'japanese',
    name: '日本語モデル',
    canUseStyle: true,
    canUseSpeakerBoost: true,
    maxCharacters: 10000,
    languages: [{ id: 'ja', name: 'Japanese' }],
  },
];
function wav() {
  const bytes = Buffer.alloc(484);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(22050, 24);
  bytes.writeUInt32LE(44100, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(440, 40);
  return bytes;
}
async function downloadSession(page: Page) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '比較セッションJSONを保存', exact: true }).click();
  const stream = await (await pending).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}

test('requires model selection, searches and pages voices, previews explicitly, and restores native settings', async ({
  page,
}) => {
  const requests: {
    candidate: { voice: { engine: string }; recipe: Record<string, unknown> };
    text: string;
  }[] = [];
  const pageQueries: URLSearchParams[] = [];
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt,
        engines: [
          { engine: 'VOICEVOX', ready: true, detail: '接続済み' },
          { engine: 'AivisSpeech', ready: false, detail: '未接続' },
          { engine: 'ElevenLabs', ready: true, detail: '接続済み（クラウド）' },
        ],
        voices: [local],
      },
    }),
  );
  await page.route('**/api/casting/elevenlabs/models', (route) =>
    route.fulfill({
      json: { ready: true, detail: 'モデル一覧を取得しました。', checkedAt, models },
    }),
  );
  await page.route('**/api/casting/elevenlabs/voices?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    pageQueries.push(query);
    const searching = query.get('search') === '案内役';
    const paging = query.has('cursor');
    return route.fulfill({
      json: {
        voices: paging ? [more] : searching ? [found] : [first],
        hasMore: searching && !paging,
        nextCursor: searching && !paging ? nextCursor : null,
      },
    });
  });
  await page.route('**/api/casting/preview', async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({
      contentType: 'audio/wav',
      body: wav(),
      headers: {
        'X-Voice-Atlas-Generation': encodeURIComponent(
          JSON.stringify({
            engine: body.candidate.voice.engine,
            engineVersion: null,
            checkedAt,
            ...(body.candidate.voice.engine === 'ElevenLabs'
              ? { modelId: body.candidate.recipe.modelId, outputFormat: 'pcm_22050', seed: null }
              : {}),
          }),
        ),
      },
    });
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  const panel = page.getByRole('region', { name: '製品横断の比較', exact: true });
  const picker = panel.getByRole('region', { name: 'ElevenLabsの声を選ぶ', exact: true });
  await expect(picker.getByText('検索前の声', { exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: '比較候補に追加' })).toBeDisabled();
  await expect(page.locator('#elevenlabs-model')).toHaveValue('');
  expect(requests).toHaveLength(0);
  await page.locator('#elevenlabs-model').selectOption('japanese');
  await page.locator('#elevenlabs-search').fill('案内役');
  await picker.getByRole('button', { name: 'ElevenLabsの声を検索', exact: true }).click();
  await expect(picker.getByText('日本語の案内役', { exact: true })).toBeVisible();
  await expect(picker.getByText('検索前の声', { exact: true })).toHaveCount(0);
  await picker.getByRole('button', { name: '次の声を表示' }).click();
  await expect(picker.getByText('次の声', { exact: true })).toBeVisible();
  expect(pageQueries.at(-1)?.get('search')).toBe('案内役');
  expect(pageQueries.at(-1)?.get('cursor')).toBe(nextCursor);
  await picker
    .getByRole('listitem')
    .filter({ hasText: '日本語の案内役' })
    .getByRole('button')
    .click();
  await expect(page.locator('#casting-B-model')).toHaveValue('japanese');
  await page.locator('#casting-B-stability').fill('0.8');
  await page.locator('#casting-B-similarityBoost').fill('0.6');
  await expect(page.locator('#casting-B-speedScale')).toHaveCount(0);
  expect(requests).toHaveLength(0);
  await panel
    .getByRole('button', { name: 'ElevenLabsへ送信して製品比較のA・Bを生成', exact: true })
    .click();
  await expect(panel.getByLabel('製品比較候補Bの試聴', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1].candidate.recipe).toMatchObject({
    engine: 'ElevenLabs',
    modelId: 'japanese',
    stability: 0.8,
    similarityBoost: 0.6,
  });
  expect(requests[1].candidate.recipe).not.toHaveProperty('speedScale');
  await panel.getByRole('radio', { name: 'Bを採用', exact: true }).check();
  await panel.getByRole('button', { name: '製品比較の評価を記録', exact: true }).click();
  const session = await downloadSession(page);
  expect(session.evaluations[0].generations[1]).toMatchObject({
    engine: 'ElevenLabs',
    modelId: 'japanese',
    outputFormat: 'pcm_22050',
  });
  expect(
    session.candidates.find(
      (candidate: { voice: { engine: string } }) => candidate.voice.engine === 'ElevenLabs',
    ).recipe.stability,
  ).toBe(0.8);
  await page.locator('#casting-B-model').selectOption('english');
  await expect(page.locator('#casting-B-style')).toHaveCount(0);
  await panel.getByLabel('比較セッションJSONファイル').setInputFiles({
    name: 'casting.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(session)),
  });
  await expect(page.locator('#casting-B-model')).toHaveValue('japanese');
  await expect(page.locator('#casting-B-stability')).toHaveValue('0.8');
  await expect(panel.locator('audio')).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('elevenlabs.png'), fullPage: true });
});

test('retains the last voice results after a failed search and allows an empty search result', async ({
  page,
}) => {
  let fail = false;
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt,
        engines: [{ engine: 'ElevenLabs', ready: true, detail: '接続済み' }],
        voices: [],
      },
    }),
  );
  await page.route('**/api/casting/elevenlabs/models', (route) =>
    route.fulfill({ json: { ready: true, detail: '取得済み', checkedAt, models } }),
  );
  await page.route('**/api/casting/elevenlabs/voices?*', (route) =>
    fail
      ? route.fulfill({
          status: 502,
          json: { error: 'ElevenLabsの声一覧を取得できませんでした。' },
        })
      : route.fulfill({
          json: {
            voices: new URL(route.request().url()).searchParams.get('search') ? [] : [first],
            hasMore: false,
            nextCursor: null,
          },
        }),
  );
  await page.goto('/');
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  const picker = page.getByRole('region', { name: 'ElevenLabsの声を選ぶ' });
  await expect(picker.getByText('検索前の声', { exact: true })).toBeVisible();
  fail = true;
  await page.locator('#elevenlabs-search').fill('不明');
  await picker.getByRole('button', { name: 'ElevenLabsの声を検索' }).click();
  await expect(picker.getByRole('alert')).toHaveText('ElevenLabsの声一覧を取得できませんでした。');
  await expect(picker.getByText('検索前の声', { exact: true })).toBeVisible();
  fail = false;
  await picker.getByRole('button', { name: 'ElevenLabsの声を検索' }).click();
  await expect(picker.getByText('検索条件に一致する声がありません。')).toBeVisible();
});

test('preserves restored cloud settings while the server key is absent', async ({ page }) => {
  let cloudReads = 0;
  let previews = 0;
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt,
        engines: [
          {
            engine: 'ElevenLabs',
            ready: false,
            detail: '未設定：ELEVENLABS_API_KEYを設定してください',
          },
        ],
        voices: [],
      },
    }),
  );
  await page.route('**/api/casting/elevenlabs/**', (route) => {
    cloudReads++;
    return route.fulfill({ status: 503, json: { error: '未設定' } });
  });
  await page.route('**/api/casting/preview', (route) => {
    previews++;
    return route.fulfill({ status: 503, json: { error: '未設定' } });
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  const panel = page.getByRole('region', { name: '製品横断の比較', exact: true });
  await expect(panel.getByText('ElevenLabs：未設定', { exact: false })).toBeVisible();
  const recipe = {
    engine: 'ElevenLabs',
    modelId: 'saved-model',
    stability: 0.8,
    similarityBoost: 0.6,
    style: 0.2,
    useSpeakerBoost: true,
    seed: 42,
    outputFormat: 'pcm_22050',
  };
  const key = JSON.stringify(['ElevenLabs', found.voiceId]);
  const saved = {
    format: 'voice-atlas-casting',
    version: 1,
    createdAt: checkedAt,
    text: '以前のセリフ',
    candidates: [{ voice: found, recipe }],
    comparisonKeys: null,
    selectedKey: key,
    evaluations: [],
  };
  await panel.getByLabel('比較セッションJSONファイル').setInputFiles({
    name: 'cloud.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(saved)),
  });
  await expect(page.locator('#casting-A-model')).toHaveValue('saved-model');
  await expect(page.locator('#casting-A-model')).toBeDisabled();
  await expect(page.locator('#casting-A-stability')).toHaveValue('0.8');
  await expect(
    panel.getByRole('button', { name: 'ElevenLabsへ送信して候補Aを試聴' }),
  ).toBeDisabled();
  const exported = await downloadSession(page);
  expect(exported.candidates[0].recipe).toEqual(recipe);
  expect(exported.text).toBe('以前のセリフ');
  expect(cloudReads).toBe(0);
  expect(previews).toBe(0);
});

async function openManagedWorkspace(page: Page) {
  const previews: string[] = [];
  const listed = [first, { ...found, category: 'generated' }, { ...more, category: 'cloned' }];
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt,
        engines: [
          { engine: 'VOICEVOX', ready: true, detail: '接続済み' },
          { engine: 'ElevenLabs', ready: true, detail: '接続済み' },
        ],
        voices: [local],
      },
    }),
  );
  await page.route('**/api/casting/elevenlabs/models', (route) =>
    route.fulfill({ json: { ready: true, detail: '取得済み', checkedAt, models } }),
  );
  await page.route('**/api/casting/elevenlabs/voices?*', (route) =>
    route.fulfill({ json: { voices: listed, hasMore: false, nextCursor: null } }),
  );
  await page.route('**/api/casting/preview', (route) => {
    const body = route.request().postDataJSON();
    previews.push(body.candidate.voice.voiceId);
    return route.fulfill({
      contentType: 'audio/wav',
      body: wav(),
      headers: {
        'X-Voice-Atlas-Generation': encodeURIComponent(
          JSON.stringify({
            engine: body.candidate.voice.engine,
            engineVersion: null,
            checkedAt,
            ...(body.candidate.voice.engine === 'ElevenLabs'
              ? { modelId: body.candidate.recipe.modelId, outputFormat: 'pcm_22050', seed: null }
              : {}),
          }),
        ),
      },
    });
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  const panel = page.getByRole('region', { name: '製品横断の比較', exact: true });
  const picker = panel.getByRole('region', { name: 'ElevenLabsの声を選ぶ', exact: true });
  const manager = panel.getByRole('region', { name: '追加したElevenLabsの比較候補', exact: true });
  await expect(picker.getByRole('listitem')).toHaveCount(3);
  return { panel, picker, manager, previews };
}

test('shows model capabilities and filters voice cards without generating audio', async ({
  page,
}) => {
  const { panel, picker, manager, previews } = await openManagedWorkspace(page);
  await expect(picker.getByRole('button', { name: '比較候補に追加' }).first()).toBeDisabled();
  await page.locator('#elevenlabs-model').selectOption('japanese');
  const details = picker.getByRole('group', { name: '日本語モデルのモデル情報' });
  await expect(details).toContainText('Japanese');
  await expect(details).toContainText('この画面では300文字まで');
  await expect(details).toContainText('モデル上限：10,000文字');
  await expect(details).toContainText('安定性・類似度・スタイル・話者ブースト');
  await picker.getByLabel('声の種別', { exact: true }).selectOption('generated');
  await expect(picker.getByRole('listitem')).toHaveCount(1);
  await expect(picker.getByRole('listitem')).toContainText(found.name);
  await picker.getByRole('button', { name: '比較候補に追加' }).click();
  await picker.getByLabel('追加状況', { exact: true }).selectOption('unadded');
  await expect(
    picker.getByText('表示条件に一致する声がありません。声の種別・追加状況を変更してください。'),
  ).toBeVisible();
  await picker.getByLabel('声の種別', { exact: true }).selectOption('all');
  await expect(picker.getByRole('listitem')).toHaveCount(2);
  await picker.getByLabel('追加状況', { exact: true }).selectOption('added');
  await expect(picker.getByRole('listitem')).toHaveCount(1);
  await expect(picker.getByRole('listitem')).toContainText(found.name);
  await manager.getByLabel('追加した候補を検索', { exact: true }).fill('日本語モデル');
  await expect(manager.getByRole('listitem')).toHaveCount(1);
  await manager.getByLabel('追加した候補を検索', { exact: true }).fill('見つからない名前');
  await expect(manager.getByText('検索条件に一致する比較候補がありません。')).toBeVisible();
  await manager.getByLabel('追加した候補を検索', { exact: true }).fill('');
  await page.locator('#casting-B-model').selectOption('english');
  const candidateDetails = panel
    .getByRole('region', { name: '製品比較候補B', exact: true })
    .getByRole('group', { name: 'Englishのモデル情報' });
  await expect(candidateDetails).toContainText('English');
  await expect(candidateDetails).toContainText('日本語対応は未確認');
  await expect(candidateDetails).not.toContainText('スタイル');
  await page.locator('#elevenlabs-model').selectOption('english');
  await expect(picker.getByRole('group', { name: 'Englishのモデル情報' })).toContainText(
    '安定性・類似度',
  );
  await picker.getByLabel('追加状況', { exact: true }).selectOption('all');
  await picker.getByLabel('声の並び順', { exact: true }).selectOption('name');
  const displayed = await picker.locator('li strong').allTextContents();
  expect(displayed).toEqual([...displayed].sort((a, b) => a.localeCompare(b, 'ja')));
  expect(previews).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await picker.screenshot({ path: test.info().outputPath('elevenlabs-picker.png') });
});

test('repairs comparison slots when removing candidates and retains other audio and recorded evaluations', async ({
  page,
}) => {
  const { panel, picker, manager, previews } = await openManagedWorkspace(page);
  await page.locator('#elevenlabs-model').selectOption('japanese');
  for (const voice of [first, found, more])
    await picker.getByRole('listitem').filter({ hasText: voice.name }).getByRole('button').click();
  await expect(manager.getByRole('listitem')).toHaveCount(3);
  await page.locator('#casting-B-stability').fill('0.8');
  await panel
    .getByRole('button', { name: 'ElevenLabsへ送信して製品比較のA・Bを生成', exact: true })
    .click();
  await expect(panel.getByLabel('製品比較候補Bの試聴', { exact: true })).toBeVisible();
  await panel.getByRole('radio', { name: 'Bを採用', exact: true }).check();
  await panel.getByRole('button', { name: '製品比較の評価を記録', exact: true }).click();
  const initial = await downloadSession(page);
  expect(initial.evaluations).toHaveLength(1);
  await page.locator('#casting-reason').fill('編集中の理由');
  await manager
    .getByRole('listitem')
    .filter({ hasText: more.name })
    .getByRole('button', { name: '候補から削除' })
    .click();
  await expect(panel.getByLabel('製品比較候補Aの試聴', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('製品比較候補Bの試聴', { exact: true })).toBeVisible();
  await expect(page.locator('#casting-reason')).toHaveValue('編集中の理由');
  await manager
    .getByRole('listitem')
    .filter({ hasText: first.name })
    .getByRole('button', { name: '候補から削除' })
    .click();
  await expect(panel.getByLabel('製品比較候補Aの試聴', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('製品比較候補Bの試聴', { exact: true })).toHaveCount(0);
  await expect(page.locator('#casting-reason')).toHaveValue('');
  const afterRemoval = await downloadSession(page);
  expect(afterRemoval.evaluations).toEqual(initial.evaluations);
  expect(
    afterRemoval.candidates.some(
      (candidate: { voice: { voiceId: string } }) => candidate.voice.voiceId === first.voiceId,
    ),
  ).toBe(false);
  expect(afterRemoval.comparisonKeys).toHaveLength(2);
  expect(new Set(afterRemoval.comparisonKeys).size).toBe(2);
  await manager
    .getByRole('listitem')
    .filter({ hasText: found.name })
    .getByRole('button', { name: '候補Aで比較' })
    .click();
  await expect(page.locator('#casting-A-model')).toHaveValue('japanese');
  await expect(panel.getByLabel('製品比較候補Bの試聴', { exact: true })).toBeVisible();
  await manager
    .getByRole('listitem')
    .filter({ hasText: found.name })
    .getByRole('button', { name: '候補から削除' })
    .click();
  await expect(manager.getByRole('listitem')).toHaveCount(0);
  const localOnly = await downloadSession(page);
  expect(localOnly.candidates).toHaveLength(1);
  expect(localOnly.comparisonKeys).toBeNull();
  expect(localOnly.evaluations).toEqual(initial.evaluations);
  expect(previews).toHaveLength(2);
  await picker
    .getByRole('listitem')
    .filter({ hasText: first.name })
    .getByRole('button', { name: '比較候補に追加' })
    .click();
  await expect(page.locator('#casting-B-stability')).toHaveValue('0.5');
  await expect(panel.getByLabel('製品比較候補Aの試聴', { exact: true })).toBeVisible();
  await expect(panel.getByLabel('製品比較候補Bの試聴', { exact: true })).toHaveCount(0);
  const readded = await downloadSession(page);
  expect(readded.evaluations).toEqual(initial.evaluations);
  await panel.getByLabel('比較セッションJSONファイル').setInputFiles({
    name: 'managed.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(readded)),
  });
  await expect(page.locator('#casting-B-stability')).toHaveValue('0.5');
  await expect(manager.getByRole('listitem')).toHaveCount(1);
  expect(previews).toHaveLength(2);
});
