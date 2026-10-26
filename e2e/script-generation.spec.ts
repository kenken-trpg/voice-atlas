import { test, expect, type Page, type Route } from '@playwright/test';
import { projectFixture } from '../tests/fixtures/project';
import { scriptFixture } from '../tests/fixtures/script';
import { projectStorageKey } from '../shared/project';
import { makeScriptLine, scriptCandidate } from '../shared/script';
import { pcmWav } from '../tests/fixtures/wav';

const base = scriptFixture();
const fixture = projectFixture();
fixture.documents.script = {
  ...base.script,
  lines: [
    { ...base.script.lines[0], spokenText: 'ほしよみのとう', readingSource: 'manual' },
    base.script.lines[1],
    { ...makeScriptLine(base.assignments[0]), text: '続けます。' },
  ],
};
const wav = (route: Route) =>
  route.fulfill({ contentType: 'audio/wav', body: Buffer.from(pcmWav(Array(2400).fill(100))) });
async function expand(page: Page) {
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  return page.getByRole('region', { name: '台本の試聴', exact: true });
}
async function setup(page: Page, respond: (route: Route, count: number) => Promise<void>) {
  await page.addInitScript(
    ({ key, value }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    },
    { key: projectStorageKey, value: JSON.stringify(fixture) },
  );
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: fixture.createdAt,
        engines: ['VOICEVOX', 'AivisSpeech'].map((engine) => ({
          engine,
          ready: true,
          detail: '接続済み',
        })),
        voices: base.script.lines.map((line) => scriptCandidate(line)!.voice),
      },
    }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({ json: { ready: false, checkedAt: fixture.createdAt, models: [] } }),
  );
  const calls: string[] = [];
  await page.route('**/api/casting/preview', async (route) => {
    calls.push(route.request().postDataJSON().text);
    await respond(route, calls.length);
  });
  await page.goto('/');
  const panel = await expand(page);
  return {
    panel,
    progress: panel.getByRole('region', { name: '台本の生成状況', exact: true }),
    calls,
  };
}
test('reports partial failure, retries only failed lines, then resumes untouched targets without repeating successful audio', async ({
  page,
}, testInfo) => {
  const { panel, progress, calls } = await setup(page, (route, count) =>
    count === 2
      ? route.fulfill({ status: 502, json: { error: 'テスト用の生成失敗' } })
      : wav(route),
  );
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(progress.getByRole('listitem', { name: '生成記録 開始時の第2行' })).toContainText(
    '失敗',
  );
  await expect(progress.getByRole('listitem', { name: '生成記録 開始時の第3行' })).toContainText(
    '未処理',
  );
  await expect(progress).toContainText('失敗理由：テスト用の生成失敗');
  await expect(progress.getByRole('progressbar')).toHaveAttribute('value', '1');
  await expect(progress.getByRole('progressbar')).toHaveAttribute('max', '3');
  const firstUrl = await panel.getByLabel('台本の第1行の試聴', { exact: true }).getAttribute('src');
  await progress.screenshot({ path: testInfo.outputPath('generation-progress.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await progress.getByRole('button', { name: '失敗した行だけ再試行', exact: true }).click();
  await expect(progress.getByRole('listitem', { name: '生成記録 開始時の第2行' })).toContainText(
    '成功 · 試行2回',
  );
  expect(calls).toEqual(['ほしよみのとう', '案内を頼もう。', '案内を頼もう。']);
  await expect(progress.getByRole('listitem', { name: '生成記録 開始時の第3行' })).toContainText(
    '未処理',
  );
  await expect(
    progress.getByRole('button', { name: '失敗した行だけ再試行', exact: true }),
  ).toBeDisabled();
  await progress.getByRole('button', { name: '未完了の対象行を再開', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(3);
  await expect(progress.getByRole('progressbar')).toHaveAttribute('value', '3');
  expect(calls).toEqual(['ほしよみのとう', '案内を頼もう。', '案内を頼もう。', '続けます。']);
  await expect(panel.getByLabel('台本の第1行の試聴', { exact: true })).toHaveAttribute(
    'src',
    firstUrl!,
  );
});
test('stops the active request, retains queued targets and resumes in the current script order', async ({
  page,
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { panel, progress, calls } = await setup(page, async (route, count) => {
    if (count === 2) await held;
    await wav(route);
  });
  try {
    await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
    await expect(progress.getByRole('listitem', { name: '生成記録 開始時の第2行' })).toContainText(
      '生成中',
    );
    await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toBeDisabled();
    await expect(
      progress.getByRole('button', { name: '未完了の対象行を再開', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }),
    ).toBeDisabled();
    await progress.getByRole('button', { name: '台本の生成を中止', exact: true }).click();
    await expect(progress.getByRole('listitem', { name: '生成記録 開始時の第2行' })).toContainText(
      '中止',
    );
    await expect(progress.getByRole('listitem', { name: '生成記録 開始時の第3行' })).toContainText(
      '未処理',
    );
    await expect(
      progress.getByRole('button', { name: '失敗した行だけ再試行', exact: true }),
    ).toBeDisabled();
    release();
    await expect(panel.locator(':scope > ol audio')).toHaveCount(1);
    await panel.getByRole('button', { name: '第3行を上へ', exact: true }).click();
    await progress.getByRole('button', { name: '未完了の対象行を再開', exact: true }).click();
    await expect(panel.locator(':scope > ol audio')).toHaveCount(3);
    expect(calls).toEqual(['ほしよみのとう', '案内を頼もう。', '続けます。', '案内を頼もう。']);
  } finally {
    release();
  }
});
test('retries a failed regeneration despite existing audio, rejects changed readings and keeps audio on dismiss', async ({
  page,
}) => {
  const { panel, progress, calls } = await setup(page, (route, count) =>
    count === 2 || count === 4
      ? route.fulfill({ status: 502, json: { error: '再生成の失敗' } })
      : wav(route),
  );
  await panel.getByRole('button', { name: '第1行を生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(1);
  const url = await panel.getByLabel('台本の第1行の試聴', { exact: true }).getAttribute('src');
  await panel.getByRole('button', { name: '第1行を再生成', exact: true }).click();
  await expect(progress).toContainText('失敗理由：再生成の失敗');
  await expect(panel.getByLabel('台本の第1行の試聴', { exact: true })).toHaveAttribute('src', url!);
  const retry = progress.getByRole('button', { name: '失敗した行だけ再試行', exact: true });
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('表記だけ変更');
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(progress).toContainText('成功1 / 対象1行');
  await expect(panel.getByLabel('台本の第1行の試聴', { exact: true })).not.toHaveAttribute(
    'src',
    url!,
  );
  await panel.getByRole('button', { name: '第1行を再生成', exact: true }).click();
  await expect(progress).toContainText('失敗理由：再生成の失敗');
  await panel.getByLabel('第1行の読み上げ文', { exact: true }).fill('別のよみ');
  await expect(retry).toBeDisabled();
  await expect(progress).toContainText('この行は変更または削除されています');
  await panel.getByLabel('第1行の読み上げ文', { exact: true }).fill('ほしよみのとう');
  await retry.click();
  await expect(progress).toContainText('成功1 / 対象1行');
  await expect(panel.getByLabel('台本の第1行の試聴', { exact: true })).not.toHaveAttribute(
    'src',
    url!,
  );
  expect(calls).toEqual(Array(5).fill('ほしよみのとう'));
  await progress.getByRole('button', { name: '生成の記録を閉じる', exact: true }).click();
  await expect(progress).toHaveCount(0);
  await expect(panel.locator(':scope > ol audio')).toHaveCount(1);
});
test('keeps records on canceled switching and clears them on a real script replacement or reload', async ({
  page,
}) => {
  const { panel, progress, calls } = await setup(page, (route, count) =>
    count === 2 ? route.fulfill({ status: 502, json: { error: '生成失敗' } }) : wav(route),
  );
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(progress).toContainText('失敗理由：生成失敗');
  await panel.getByLabel('台本名', { exact: true }).fill('編集中');
  const file = {
    name: 'next-script.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...fixture.documents.script, title: '次の台本' })),
  };
  await panel.getByLabel('台本JSONファイル', { exact: true }).setInputFiles(file);
  await panel.getByRole('button', { name: '台本の切り替えをキャンセル', exact: true }).click();
  await expect(progress).toContainText('失敗理由：生成失敗');
  await panel.getByLabel('台本JSONファイル', { exact: true }).setInputFiles(file);
  await panel.getByRole('button', { name: '台本を保存せず切り替える', exact: true }).click();
  await expect(panel.getByLabel('台本名', { exact: true })).toHaveValue('次の台本');
  await expect(progress).toHaveCount(0);
  expect(calls).toHaveLength(2);
  await panel.getByRole('button', { name: '第1行を生成', exact: true }).click();
  await expect(progress).toContainText('成功1 / 対象1行');
  await page.reload();
  await expand(page);
  await expect(progress).toHaveCount(0);
  expect(calls).toHaveLength(3);
});
