import { test, expect, type Page, type Locator } from '@playwright/test';
import { scriptFixture } from '../tests/fixtures/script';
import {
  makeScriptLine,
  scriptCandidate,
  scriptStorageKey,
  serializeScript,
} from '../shared/script';
import { serializeCastingBoard, castingBoardStorageKey } from '../shared/casting-board';
import { pcmWav } from '../tests/fixtures/wav';
const base = scriptFixture();
const names = [
  '案内人',
  '騎士',
  '店主',
  '案内人',
  '騎士',
  '店主',
  '案内人',
  '騎士',
  '店主',
  '案内人',
];
const script = {
  ...base.script,
  lines: names.map((character, index) => ({
    ...makeScriptLine(index < 2 ? base.assignments[index] : null),
    character,
    text: `セリフ${index + 1}`,
    ...(index === 2 ? { spokenText: 'せりふさん', readingSource: 'manual' as const } : {}),
  })),
};
async function open(page: Page) {
  await page.addInitScript(
    ({ boardKey, board, scriptKey, script }) => {
      localStorage.setItem(boardKey, board);
      localStorage.setItem(scriptKey, script);
    },
    {
      boardKey: castingBoardStorageKey,
      board: serializeCastingBoard(base.assignments),
      scriptKey: scriptStorageKey,
      script: serializeScript(script),
    },
  );
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: base.assignments[0].assignedAt,
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
    route.fulfill({
      json: { ready: false, checkedAt: base.assignments[0].assignedAt, models: [] },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: '台本へ進む', exact: true }).click();
  const panel = page.getByRole('region', { name: '台本の試聴', exact: true });
  return { panel, casting: panel.getByRole('region', { name: '未配役の一括設定', exact: true }) };
}
async function exported(page: Page, panel: Locator) {
  const pending = page.waitForEvent('download');
  await panel.getByRole('button', { name: '台本JSONを保存', exact: true }).click();
  const stream = await (await pending).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString());
}
test('casts three speakers in a ten-line script, preserves assigned audio, generates only changed rows and undoes the batch', async ({
  page,
}, testInfo) => {
  let calls = 0;
  await page.route('**/api/casting/preview', (route) => {
    calls++;
    return route.fulfill({
      contentType: 'audio/wav',
      body: Buffer.from(pcmWav(Array(2400).fill(1000))),
    });
  });
  const { panel, casting } = await open(page);
  await expect(casting.getByRole('status')).toHaveText('未配役：3人・8行');
  // Generate an already assigned row before applying the batch.
  await panel.getByRole('button', { name: '第1行を生成', exact: true }).click();
  const oldAudio = panel.getByLabel('台本の第1行の試聴', { exact: true });
  await expect(oldAudio).toBeVisible();
  const url = await oldAudio.getAttribute('src');
  for (const [name, assignment] of [
    ['案内人', base.assignments[1]],
    ['騎士', base.assignments[0]],
    ['店主', base.assignments[0]],
  ] as const)
    await casting.getByLabel(`${name}の一括配役`, { exact: true }).selectOption(assignment.id);
  await casting.getByRole('button', { name: '一括配役の対象を確認', exact: true }).click();
  const review = casting.getByRole('group', { name: '一括配役の確認', exact: true });
  await expect(review.getByRole('status')).toHaveText('対象8行 / 設定変更8行 / 音声が変わる8行');
  await expect(review.locator('li')).toHaveCount(8);
  await casting.getByRole('button', { name: '一括配役をキャンセル', exact: true }).click();
  await expect(oldAudio).toHaveAttribute('src', url!);
  expect(calls).toBe(1);
  await casting.getByRole('button', { name: '一括配役の対象を確認', exact: true }).click();
  await casting.screenshot({ path: testInfo.outputPath('batch-casting.png') });
  await casting.getByRole('button', { name: '確認した一括配役を反映', exact: true }).click();
  await expect(casting).toContainText('すべての行に声が割り当てられています');
  await expect(oldAudio).toHaveAttribute('src', url!);
  expect(calls).toBe(1);
  const saved = await exported(page, panel);
  expect(saved.lines.slice(0, 2)).toEqual(script.lines.slice(0, 2));
  expect(saved.lines[2].character).toBe('店主');
  expect(saved.lines[2].spokenText).toBe('せりふさん');
  expect(saved.lines.every((line: { assignment: unknown }) => line.assignment)).toBe(true);
  await panel.getByRole('button', { name: '差し替えた行の未生成音声を生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(9);
  expect(calls).toBe(9);
  await panel.getByRole('button', { name: '直前の声の差し替えを取り消す', exact: true }).click();
  await expect(casting.getByRole('status')).toHaveText('未配役：3人・8行');
  await expect(oldAudio).toHaveAttribute('src', url!);
  expect((await exported(page, panel)).lines).toEqual(script.lines);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('invalidates stale previews and requires explicit overwrite for assigned rows', async ({
  page,
}) => {
  let calls = 0;
  await page.route('**/api/casting/preview', (route) => {
    calls++;
    return route.abort();
  });
  const { panel, casting } = await open(page);
  await casting
    .getByLabel('案内人の一括配役', { exact: true })
    .selectOption(base.assignments[1].id);
  await casting.getByRole('button', { name: '一括配役の対象を確認', exact: true }).click();
  await expect(
    casting.getByRole('group', { name: '一括配役の確認' }).getByRole('status'),
  ).toHaveText('対象3行 / 設定変更3行 / 音声が変わる3行');
  await panel.getByLabel('第4行のセリフ', { exact: true }).fill('確認後の修正');
  await expect(
    casting.getByRole('button', { name: '確認した一括配役を反映', exact: true }),
  ).toHaveCount(0);
  await casting.getByLabel('選んだ発話者の配役済み行も上書きする').check();
  await casting.getByRole('button', { name: '一括配役の対象を確認', exact: true }).click();
  await expect(
    casting.getByRole('group', { name: '一括配役の確認' }).getByRole('status'),
  ).toHaveText('対象4行 / 設定変更4行 / 音声が変わる4行');
  await casting.getByRole('button', { name: '確認した一括配役を反映', exact: true }).click();
  const saved = await exported(page, panel);
  expect(saved.lines[0].assignment.id).toBe(base.assignments[1].id);
  expect(saved.lines[1]).toEqual(script.lines[1]);
  expect(saved.lines[3].text).toBe('確認後の修正');
  expect(saved.lines[2].assignment).toBeNull();
  await panel.getByRole('button', { name: '直前の声の差し替えを取り消す', exact: true }).click();
  await expect(panel.getByLabel('第4行のセリフ', { exact: true })).toHaveValue('確認後の修正');
  expect(calls).toBe(0);
});

test('imports ten lines without voices and resolves three speakers in one batch', async ({
  page,
}) => {
  let calls = 0;
  await page.route('**/api/casting/preview', (route) => {
    calls++;
    return route.fulfill({ contentType: 'audio/wav', body: Buffer.from(pcmWav([100, -100, 200])) });
  });
  const { panel, casting } = await open(page);
  await panel.getByText('テキスト・CSVから台本を取り込む', { exact: true }).click();
  const importer = panel.getByRole('region', { name: '台本の一括取り込み', exact: true });
  const speakers = ['魔術師', '商人', '門番'];
  await importer
    .getByLabel('一括取り込みの入力')
    .fill(
      Array.from({ length: 10 }, (_, i) => `${speakers[i % 3]}：場面のセリフ${i + 1}`).join('\n'),
    );
  await importer.getByRole('button', { name: '取り込み内容を確認', exact: true }).click();
  await expect(
    importer.getByRole('button', { name: '確認した内容を台本に反映', exact: true }),
  ).toBeDisabled();
  await importer.getByLabel('声を選んでいない発話者は未配役のまま取り込む').check();
  await expect(importer.getByRole('status')).toContainText('要修正0行');
  await importer.getByRole('button', { name: '確認した内容を台本に反映', exact: true }).click();
  const discard = panel.getByRole('button', { name: '台本を保存せず切り替える', exact: true });
  if (await discard.isVisible()) await discard.click();
  await expect(casting.getByRole('status')).toHaveText('未配役：3人・10行');
  for (const [i, name] of speakers.entries())
    await casting
      .getByLabel(`${name}の一括配役`, { exact: true })
      .selectOption(base.assignments[i % 2].id);
  await casting.getByRole('button', { name: '一括配役の対象を確認', exact: true }).click();
  await expect(
    casting.getByRole('group', { name: '一括配役の確認' }).getByRole('status'),
  ).toContainText('対象10行');
  await casting.getByRole('button', { name: '確認した一括配役を反映', exact: true }).click();
  await expect(casting).toContainText('すべての行に声が割り当てられています');
  expect(calls).toBe(0);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(10);
  expect(calls).toBe(10);
  const result = await exported(page, panel);
  expect(result.lines.map((line: { character: string }) => line.character)).toEqual(
    Array.from({ length: 10 }, (_, i) => speakers[i % 3]),
  );
});
