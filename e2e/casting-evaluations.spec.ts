import { test, expect, type Page, type Locator } from '@playwright/test';
import { makeCastingEvaluation, makeCastingSession } from '../tests/fixtures/casting';
import { makeCastingDataset } from '../shared/casting-dataset';
import { castingKey } from '../shared/casting';
const base = makeCastingEvaluation();
const third = { ...base.candidates[0].voice, style: 'ささやき' };
const connected = {
  checkedAt: base.recordedAt,
  engines: [
    { engine: 'AivisSpeech', ready: true, detail: '接続済み' },
    { engine: 'VOICEVOX', ready: true, detail: '接続済み' },
  ],
  voices: [...base.candidates.map((item) => item.voice), third],
};
function file(value: unknown, name = 'history.json') {
  return { name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value)) };
}
async function open(page: Page, inventory = connected) {
  await page.route('**/api/casting/voices', (route) => route.fulfill({ json: inventory }));
  await page.goto('/');
  await page.getByRole('button', { name: 'VOICEVOX・AivisSpeechを比較する', exact: true }).click();
  const workspace = page.getByRole('region', { name: '製品横断の比較', exact: true });
  await expect(workspace.locator('#casting-A')).toBeVisible();
  await workspace.getByRole('button', { name: '製品比較の履歴を集計する', exact: true }).click();
  return {
    workspace,
    archive: page.getByRole('region', { name: '製品比較の履歴集計', exact: true }),
  };
}
async function exportText(page: Page, target: Locator, name: string) {
  const event = page.waitForEvent('download');
  await target.getByRole('button', { name, exact: true }).click();
  const stream = await (await event).createReadStream();
  const buffers: Buffer[] = [];
  for await (const chunk of stream) buffers.push(Buffer.from(chunk));
  return Buffer.concat(buffers).toString('utf8');
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

test('merges sessions and archives, filters adoption and exports all records without changing current work', async ({
  page,
}) => {
  let posts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST') posts++;
  });
  const { workspace, archive } = await open(page);
  await page.locator('#casting-A-tempoDynamicsScale').fill('1.7');
  await page.locator('#casting-text').fill('現在の作業');
  const same = makeCastingEvaluation({ reason: '明るい', outcome: 'b' });
  same.candidates[1] = { ...structuredClone(same.candidates[0]), voice: third };
  same.generations[1] = null;
  const vv = makeCastingEvaluation({ reason: '声の低さ', outcome: 'b' });
  const tie = makeCastingEvaluation({ reason: '同程度', outcome: 'tie' });
  await archive
    .getByLabel('製品比較集計用JSONファイル')
    .setInputFiles([
      file(makeCastingSession([base, same]), 'session.json'),
      file(makeCastingDataset([base, vv, tie]), 'archive.json'),
    ]);
  await expect(archive.getByText('集計した製品比較：4件', { exact: true })).toBeVisible();
  await expect(
    archive.getByText('採用した製品 — VOICEVOX：1件 ／ AivisSpeech：2件', { exact: true }),
  ).toBeVisible();
  await expect(archive.getByRole('status').filter({ hasText: '重複1件' })).toBeVisible();
  await archive.getByLabel('採用した製品', { exact: true }).selectOption('AivisSpeech');
  await expect(archive.getByText('表示条件に合う製品比較：2件', { exact: true })).toBeVisible();
  await archive.getByLabel('製品の組み合わせ', { exact: true }).selectOption('cross');
  await archive
    .getByLabel('製品比較の理由・セリフ・設定で検索', { exact: true })
    .fill('静かな案内役');
  await expect(archive.getByText('表示条件に合う製品比較：1件', { exact: true })).toBeVisible();
  const csv = await exportText(page, archive, '製品比較の絞り込み結果をCSVで保存');
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv).toContain('"a_tempoDynamicsScale"');
  expect(csv).toContain('落ち着きとテンポが合う。');
  expect(csv).not.toContain('声の低さ');
  const saved = JSON.parse(await exportText(page, archive, '製品比較の集計全体をJSONで保存'));
  expect(saved.records).toHaveLength(4);
  expect(saved.records[0]).not.toHaveProperty('score');
  await archive.getByRole('button', { name: '製品比較の集計をクリア', exact: true }).click();
  await archive.getByLabel('製品比較集計用JSONファイル').setInputFiles(file(saved));
  await expect(archive.getByText('表示条件に合う製品比較：4件', { exact: true })).toBeVisible();
  await expect(page.locator('#casting-A-tempoDynamicsScale')).toHaveValue('1.7');
  await expect(page.locator('#casting-text')).toHaveValue('現在の作業');
  expect(posts).toBe(0);
  await workspace.getByRole('button', { name: '製品比較の履歴集計を閉じる', exact: true }).click();
  await workspace.getByRole('button', { name: '製品比較の履歴を集計する', exact: true }).click();
  await expect(archive.getByText('集計した製品比較：4件', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath('casting-evaluation-archive.png'),
    fullPage: true,
  });
});

test('rejects a bad batch atomically and enforces file count without changing editing state', async ({
  page,
}) => {
  const { archive } = await open(page);
  await archive
    .getByLabel('製品比較集計用JSONファイル')
    .setInputFiles(file(makeCastingSession([base])));
  const next = makeCastingEvaluation({ reason: '新しい記録' }),
    invalid = structuredClone(next);
  invalid.candidates[0].recipe.engine = 'VOICEVOX';
  await archive
    .getByLabel('製品比較集計用JSONファイル')
    .setInputFiles([
      file(makeCastingSession([next]), 'valid.json'),
      file(makeCastingSession([invalid]), 'invalid.json'),
    ]);
  await expect(archive.getByRole('alert')).toContainText('変更していません');
  await expect(archive.getByText('集計した製品比較：1件', { exact: true })).toBeVisible();
  await archive
    .getByLabel('製品比較集計用JSONファイル')
    .setInputFiles(
      Array.from({ length: 21 }, (_, i) => file(makeCastingSession([next]), `${i}.json`)),
    );
  await expect(archive.getByRole('alert')).toContainText('一回20ファイル');
  await expect(archive.getByText('集計した製品比較：1件', { exact: true })).toBeVisible();
  await archive
    .getByLabel('製品比較集計用JSONファイル')
    .setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await expect(archive.getByRole('alert')).toContainText('有効なJSONでない');
  await expect(archive.getByText('集計した製品比較：1件', { exact: true })).toBeVisible();
});

test('reuses adopted settings and context, preserves current history and requires fresh audio', async ({
  page,
}) => {
  let posts = 0;
  await page.route('**/api/casting/preview', (route) => {
    posts++;
    return route.fulfill({ contentType: 'audio/wav', body: wav() });
  });
  const { workspace, archive } = await open(page);
  await page.locator('#casting-A-tempoDynamicsScale').fill('1.7');
  await page.locator('#casting-B-tempoDynamicsScale').fill('0.42');
  await page.locator('#casting-text').fill('現在のセリフ');
  await workspace.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }).click();
  await expect(
    workspace.getByRole('button', { name: '製品比較の評価を記録', exact: true }),
  ).toBeEnabled();
  await workspace.getByRole('radio', { name: 'Bを採用', exact: true }).check();
  await page.locator('#casting-reason').fill('現在の評価');
  await workspace.getByRole('button', { name: '製品比較の評価を記録', exact: true }).click();
  expect(posts).toBe(2);
  await archive
    .getByLabel('製品比較集計用JSONファイル')
    .setInputFiles(file(makeCastingSession([base])));
  await expect(workspace.locator('audio')).toHaveCount(2);
  await archive.getByRole('button', { name: 'この採用声で比較を再開', exact: true }).click();
  await expect(page.locator('#casting-A-tempoDynamicsScale')).toHaveValue('0.72');
  await expect(page.locator('#casting-B-speedScale')).toHaveValue('0.85');
  await expect(page.locator('#casting-text')).toHaveValue(base.text);
  await expect(
    workspace.getByText('保存対象の声：AivisSpeech · 評価用話者 / ノーマル', { exact: true }),
  ).toBeVisible();
  await expect(workspace.locator('audio')).toHaveCount(0);
  await expect(
    workspace.getByRole('button', { name: '製品比較の評価を記録', exact: true }),
  ).toBeDisabled();
  expect(posts).toBe(2);
  const saved = JSON.parse(await exportText(page, workspace, '比較セッションJSONを保存'));
  expect(saved.evaluations).toHaveLength(1);
  expect(saved.comparisonContext).toEqual({
    profile: base.profile,
    characterInput: base.characterInput,
  });
  expect(
    saved.candidates.find((item: { voice: { style: string } }) => item.voice.style === 'ささやき')
      .recipe.tempoDynamicsScale,
  ).toBe(0.42);
  await workspace
    .getByLabel('比較セッションJSONファイル', { exact: true })
    .setInputFiles(file(saved));
  await workspace.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }).click();
  await expect(
    workspace.getByRole('button', { name: '製品比較の評価を記録', exact: true }),
  ).toBeEnabled();
  await workspace.getByRole('radio', { name: 'Aを採用', exact: true }).check();
  await workspace.getByRole('button', { name: '製品比較の評価を記録', exact: true }).click();
  const again = JSON.parse(await exportText(page, workspace, '比較セッションJSONを保存'));
  expect(again.evaluations).toHaveLength(2);
  expect(again.evaluations[1].profile.pitch).toBe(17);
  expect(again.evaluations[1].characterInput.text).toBe('静かな案内役');
  await expect(archive.getByText('集計した製品比較：1件', { exact: true })).toBeVisible();
  expect(
    JSON.parse(await exportText(page, archive, '製品比較の集計全体をJSONで保存')).records[0],
  ).toEqual(base);
  await archive
    .getByRole('button', { name: '現在の製品比較記録を追加（2件）', exact: true })
    .click();
  await expect(archive.getByText('集計した製品比較：3件', { exact: true })).toBeVisible();
});

test('keeps removed identities as history and refuses reuse atomically, while uninstalled AivisSpeech can be restored', async ({
  page,
}) => {
  const { workspace, archive } = await open(page);
  const removed = makeCastingEvaluation({ outcome: 'b' });
  removed.candidates[1].voice = {
    engine: 'VOICEVOX',
    voiceId: 'removed-voice',
    name: '過去の話者',
    style: '通常',
  };
  await page.locator('#casting-text').fill('現在のセリフ');
  await archive
    .getByLabel('製品比較集計用JSONファイル')
    .setInputFiles(file(makeCastingSession([removed])));
  await expect(
    archive.getByText('採用した声：VOICEVOX · 過去の話者 / 通常', { exact: true }),
  ).toBeVisible();
  await archive.getByRole('button', { name: 'この採用声で比較を再開', exact: true }).click();
  await expect(archive.getByRole('alert')).toContainText('現在のカタログと照合できない');
  await expect(page.locator('#casting-text')).toHaveValue('現在のセリフ');
  await archive.getByRole('button', { name: '製品比較の集計をクリア', exact: true }).click();
  await archive
    .getByLabel('製品比較集計用JSONファイル')
    .setInputFiles(file(makeCastingDataset([base])));
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        ...connected,
        engines: connected.engines.map((item) => ({ ...item, ready: false, detail: '未接続' })),
        voices: [],
      },
    }),
  );
  await workspace.getByRole('button', { name: '比較用の接続を再確認', exact: true }).click();
  await expect(workspace.getByText('未接続', { exact: true })).toHaveCount(2);
  await archive.getByRole('button', { name: 'この採用声で比較を再開', exact: true }).click();
  await expect(page.locator('#casting-A-tempoDynamicsScale')).toHaveValue('0.72');
  await expect(
    workspace.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }),
  ).toBeDisabled();
});

test('paginates records and exports the whole filtered set while non-adopted outcomes cannot be resumed', async ({
  page,
}) => {
  const { archive } = await open(page);
  const records = Array.from({ length: 26 }, (_, i) =>
    makeCastingEvaluation({ reason: `ページ評価${i}`, outcome: i === 0 ? 'tie' : 'undecided' }),
  );
  await archive
    .getByLabel('製品比較集計用JSONファイル')
    .setInputFiles(file(makeCastingDataset(records)));
  await expect(archive.locator('.evaluation-records > li')).toHaveCount(25);
  await expect(
    archive.getByRole('button', { name: 'この採用声で比較を再開', exact: true }).first(),
  ).toBeDisabled();
  const csv = await exportText(page, archive, '製品比較の絞り込み結果をCSVで保存');
  expect(csv.trim().split('\r\n')).toHaveLength(27);
  await archive.getByRole('button', { name: '製品比較の次のページ', exact: true }).click();
  await expect(archive.locator('.evaluation-records > li')).toHaveCount(1);
  await archive.getByLabel('製品比較の判断', { exact: true }).selectOption('tie');
  await expect(archive.getByText('表示条件に合う製品比較：1件', { exact: true })).toBeVisible();
});
