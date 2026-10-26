import { test, expect, type Page, type Locator } from '@playwright/test';
import { scriptFixture } from '../tests/fixtures/script';
import { serializeCastingBoard, castingBoardStorageKey } from '../shared/casting-board';
import { parseScript, serializeScript, scriptCandidate, scriptStorageKey } from '../shared/script';
const fixture = scriptFixture();
const file = (value: unknown) => ({
  name: 'script.json',
  mimeType: 'application/json',
  buffer: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
});
function wav() {
  const bytes = Buffer.alloc(24044);
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
  bytes.writeUInt32LE(24000, 40);
  return bytes;
}
async function open(page: Page, seed = true) {
  if (seed)
    await page.addInitScript(
      ({ key, value }) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      },
      { key: castingBoardStorageKey, value: serializeCastingBoard(fixture.assignments) },
    );
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: fixture.assignments[0].assignedAt,
        engines: [
          { engine: 'AivisSpeech', ready: true, detail: '接続済み' },
          { engine: 'VOICEVOX', ready: true, detail: '接続済み' },
        ],
        voices: fixture.script.lines.map((line) => scriptCandidate(line)!.voice),
      },
    }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({
      json: { ready: false, checkedAt: fixture.assignments[0].assignedAt, models: [] },
    }),
  );
  await page.goto('/');
  await expand(page);
  return page.getByRole('region', { name: '台本の試聴', exact: true });
}
async function expand(page: Page) {
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
}
async function imported(panel: Locator) {
  await panel.getByLabel('台本JSONファイル').setInputFiles(file(serializeScript(fixture.script)));
  await expect(panel.getByLabel('第1行のセリフ')).toHaveValue('ようこそ。');
}
async function exported(page: Page, panel: Locator) {
  const event = page.waitForEvent('download');
  await panel.getByRole('button', { name: '台本JSONを保存', exact: true }).click();
  const stream = await (await event).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return parseScript(Buffer.concat(chunks).toString());
}
test('edits and bulk renames speakers without invalidating generated audio', async ({ page }) => {
  await page.route('**/api/casting/preview', (route) =>
    route.fulfill({
      contentType: 'audio/wav',
      body: wav(),
      headers: {
        'X-Voice-Atlas-Generation': encodeURIComponent(
          JSON.stringify({
            engine: 'AivisSpeech',
            engineVersion: 'speaker-test',
            checkedAt: fixture.assignments[0].assignedAt,
          }),
        ),
      },
    }),
  );
  const panel = await open(page);
  const withSpeakers = {
    ...fixture.script,
    lines: fixture.script.lines.map((line) => ({ ...line, character: '長老' })),
  };
  await panel.getByLabel('台本JSONファイル').setInputFiles(file(serializeScript(withSpeakers)));
  await panel.getByRole('button', { name: '第1行を生成' }).click();
  const player = panel.locator('audio[aria-label="台本の第1行の試聴"]');
  await expect(player).toBeVisible();
  const url = await player.getAttribute('src');
  await panel.getByLabel('第1行の発話者名').fill('魔術師');
  await expect(player).toHaveAttribute('src', url!);
  await panel.getByLabel('第1行の発話者名').fill('');
  await expect(player).toHaveAttribute('src', url!);
  await panel.getByLabel('第1行の発話者名').fill('長老');
  await panel.getByRole('combobox', { name: '一括改名する発話者' }).selectOption('長老');
  await panel.getByRole('textbox', { name: '一括改名後の発話者名' }).fill('語り手');
  await panel.getByRole('button', { name: '2行の発話者名を変更' }).click();
  await expect(panel.getByLabel('第1行の発話者名')).toHaveValue('語り手');
  await expect(panel.getByLabel('第2行の発話者名')).toHaveValue('語り手');
  await expect(player).toHaveAttribute('src', url!);
  await expect(
    panel.getByRole('status').filter({ hasText: '台本：2行 / 音声生成済み1行' }),
  ).toBeVisible();
  expect((await exported(page, panel)).lines.map((line) => line.character)).toEqual([
    '語り手',
    '語り手',
  ]);
});
test('assigns board voices, generates native audio in order, plays the dialogue and retains audio through reordering', async ({
  page,
}, testInfo) => {
  const calls: { text: string; candidate: { recipe: { engine: string; speedScale: number } } }[] =
    [];
  await page.route('**/api/casting/preview', (route) => {
    calls.push(route.request().postDataJSON());
    return route.fulfill({
      contentType: 'audio/wav',
      body: wav(),
      headers: {
        'X-Voice-Atlas-Generation': encodeURIComponent(
          JSON.stringify({
            engine: calls.at(-1)!.candidate.recipe.engine,
            engineVersion: 'script-test',
            checkedAt: fixture.assignments[0].assignedAt,
          }),
        ),
      },
    });
  });
  const panel = await open(page);
  await panel.getByLabel('台本名').fill('導入の会話');
  for (let i = 0; i < 2; i++) {
    await panel.getByRole('button', { name: '台本に行を追加', exact: true }).click();
    await panel
      .getByLabel(`第${i + 1}行の声`, { exact: true })
      .selectOption(fixture.assignments[i].id);
    await panel
      .getByLabel(`第${i + 1}行のセリフ`, { exact: true })
      .fill(fixture.script.lines[i].text);
  }
  const board = page.getByRole('region', { name: 'キャスティング表', exact: true });
  const sourceRow = board.locator(':scope > ol > li').first();
  await sourceRow.getByRole('button', { name: '確定設定を削除', exact: true }).click();
  await sourceRow.getByRole('button', { name: 'この確定設定を削除する', exact: true }).click();
  await expect(panel.getByLabel('第1行の声', { exact: true })).toHaveValue('snapshot');
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  expect(calls.map((call) => call.text)).toEqual(['ようこそ。', '案内を頼もう。']);
  expect(
    calls.map((call) => [call.candidate.recipe.engine, call.candidate.recipe.speedScale]),
  ).toEqual([
    ['AivisSpeech', 1],
    ['VOICEVOX', 0.85],
  ]);
  const firstUrl = await panel.getByLabel('台本の第1行の試聴', { exact: true }).getAttribute('src');
  const downloadEvent = page.waitForEvent('download');
  await panel.getByRole('link', { name: '第1行のWAVを保存', exact: true }).click();
  expect((await downloadEvent).suggestedFilename()).toBe('voice-atlas-script-01.wav');
  await page.evaluate(() => {
    (window as unknown as { plays: string[] }).plays = [];
    document.addEventListener(
      'play',
      (e) => {
        if (e.target instanceof HTMLAudioElement)
          (window as unknown as { plays: string[] }).plays.push(
            e.target.getAttribute('aria-label')!,
          );
      },
      true,
    );
  });
  await panel.getByRole('button', { name: '台本順に連続試聴', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { plays: string[] }).plays))
    .toContain('台本の第1行の試聴');
  // Headless media clocks may pause under load. Advance the first row through
  // the same ended event the browser emits, after observing real playback.
  await panel.getByLabel('台本の第1行の試聴', { exact: true }).evaluate((audio) => {
    audio.dispatchEvent(new Event('ended'));
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { plays: string[] }).plays))
    .toContain('台本の第2行の試聴');
  await panel.getByLabel('台本の第2行の試聴', { exact: true }).evaluate((audio) => {
    audio.dispatchEvent(new Event('ended'));
  });
  await expect(panel.getByRole('button', { name: '台本順に連続試聴', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '台本順に連続試聴', exact: true }).click();
  await panel.getByRole('button', { name: '台本の連続試聴を停止', exact: true }).click();
  await expect(panel.getByRole('button', { name: '台本順に連続試聴', exact: true })).toBeEnabled();
  expect(
    await panel
      .locator('audio')
      .evaluateAll((elements) => elements.every((element) => (element as HTMLAudioElement).paused)),
  ).toBe(true);
  await panel.getByRole('button', { name: '第2行を上へ', exact: true }).click();
  await expect(panel.getByLabel('第2行のセリフ', { exact: true })).toHaveValue('ようこそ。');
  await expect(panel.getByLabel('台本の第2行の試聴', { exact: true })).toHaveAttribute(
    'src',
    firstUrl!,
  );
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('変更したセリフ');
  await expect(panel.locator('audio')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: '台本順に連続試聴', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  expect(calls).toHaveLength(3);
  await panel.getByRole('button', { name: '台本をブラウザに保存', exact: true }).click();
  const saved = await exported(page, panel);
  expect(saved.lines[0].text).toBe('変更したセリフ');
  await panel.getByText('割り当てた声の設定', { exact: true }).first().click();
  await panel.screenshot({ path: testInfo.outputPath('voice-script.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expand(page);
  await expect(panel.locator('audio')).toHaveCount(0);
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('変更したセリフ');
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('編集中');
  await panel.getByLabel('台本JSONファイル').setInputFiles(file(saved));
  await panel.getByRole('button', { name: '台本を保存せず切り替える', exact: true }).click();
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('変更したセリフ');
  expect(calls).toHaveLength(3);
});
test('keeps partial audio, retries failure, cancels on demand or closing and blocks other generators', async ({
  page,
}) => {
  let calls = 0,
    fail = true,
    hold = false;
  let release: (() => void) | undefined;
  await page.route('**/api/casting/preview', async (route) => {
    calls++;
    if (hold)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (fail && calls === 2) return route.fulfill({ status: 502, json: { error: 'テスト失敗' } });
    return route.fulfill({ contentType: 'audio/wav', body: wav() });
  });
  const panel = await open(page);
  await imported(panel);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('第2行');
  await expect(panel.locator('audio')).toHaveCount(1);
  const url = await panel.locator('audio').getAttribute('src');
  fail = false;
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  expect(calls).toBe(3);
  await expect(panel.getByLabel('台本の第1行の試聴', { exact: true })).toHaveAttribute('src', url!);
  hold = true;
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('変更');
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect.poll(() => calls).toBe(4);
  await expect(
    page.getByRole('button', { name: '製品比較のA・Bを生成', exact: true }),
  ).toBeDisabled();
  await panel.getByRole('button', { name: '台本の生成を中止', exact: true }).click();
  await expect(panel.getByRole('button', { name: '台本の生成を中止', exact: true })).toHaveCount(0);
  release?.();
  await expect(panel.locator('audio')).toHaveCount(1);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect.poll(() => calls).toBe(5);
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  release?.();
  await expect(panel).not.toBeVisible();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  await expect(panel.getByRole('button', { name: '台本の生成を中止', exact: true })).toHaveCount(0);
  hold = false;
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  expect(calls).toBe(6);
  await expect(panel.getByText('今回の生成エンジン版：未取得')).toHaveCount(2);
});
test('rejects invalid imports and quota failures atomically and enforces row limits and unavailable voice guards', async ({
  page,
}) => {
  let calls = 0;
  await page.route('**/api/casting/preview', (route) => {
    calls++;
    return route.fulfill({ contentType: 'audio/wav', body: wav() });
  });
  const panel = await open(page);
  await imported(panel);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  await panel.getByLabel('台本JSONファイル').setInputFiles(file({ ...fixture.script, version: 2 }));
  await expect(panel.getByRole('alert')).toContainText('保持');
  await expect(panel.locator('audio')).toHaveCount(2);
  const duplicate = {
    ...fixture.script,
    lines: [fixture.script.lines[0], fixture.script.lines[0]],
  };
  await panel.getByLabel('台本JSONファイル').setInputFiles(file(duplicate));
  await expect(panel.locator('audio')).toHaveCount(2);
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
  });
  await panel
    .getByLabel('台本JSONファイル')
    .setInputFiles(file({ ...fixture.script, title: '失敗する読み込み' }));
  await expect(panel.getByLabel('台本名')).toHaveValue('導入の会話');
  await expect(panel.locator('audio')).toHaveCount(2);
  await panel.getByRole('button', { name: '台本をブラウザに保存', exact: true }).click();
  await expect(panel.locator(':scope > [role="alert"]')).toContainText('保持');
  await page.reload();
  await expand(page);
  for (let i = 2; i < 20; i++)
    await panel.getByRole('button', { name: '台本に行を追加', exact: true }).click();
  await expect(panel.getByRole('button', { name: '台本に行を追加', exact: true })).toBeDisabled();
  await expect(
    panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }),
  ).toBeDisabled();
  await panel.getByRole('button', { name: '第20行を削除', exact: true }).click();
  await expect(panel.getByRole('button', { name: '台本に行を追加', exact: true })).toBeEnabled();
  const unavailable = structuredClone(fixture.script);
  const voice =
    unavailable.lines[1].assignment!.comparison.entries[1].evaluation.candidates[1].voice;
  if (voice.engine !== 'VOICEVOX') throw new Error('fixture');
  voice.voiceId = 'removed-voice';
  await panel.getByLabel('台本JSONファイル').setInputFiles(file(unavailable));
  await panel.getByRole('button', { name: '台本を保存せず切り替える', exact: true }).click();
  await expect(
    panel
      .getByRole('listitem', { name: '台本の第2行', exact: true })
      .getByText(/現行カタログ対象外/),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: '第2行を生成', exact: true })).toBeDisabled();
  expect(calls).toBe(2);
});

test('enforces the twenty-row limit for insertion and duplication and copies ungenerated settings', async ({
  page,
}) => {
  const panel = await open(page);
  await imported(panel);
  await panel.getByRole('button', { name: '第1行を複製', exact: true }).click();
  const saved = await exported(page, panel);
  expect(saved.lines[1]).toEqual({ ...saved.lines[0], id: saved.lines[1].id });
  expect(saved.lines[1].id).not.toBe(saved.lines[0].id);
  expect(saved.lines[1].assignment).toEqual(fixture.script.lines[0].assignment);
  await expect(panel.locator(':scope > ol audio')).toHaveCount(0);
  for (let i = 3; i < 20; i++)
    await panel.getByRole('button', { name: '台本に行を追加', exact: true }).click();
  for (const name of [
    '台本に行を追加',
    '第1行を複製',
    '第1行の前に行を挿入',
    '第20行の後に行を挿入',
  ])
    await expect(panel.getByRole('button', { name, exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '第1行を上へ', exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: '第20行を下へ', exact: true })).toBeDisabled();
  await panel.getByRole('button', { name: '第20行を削除', exact: true }).click();
  await expect(panel.getByRole('button', { name: '第1行を複製', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: '台本に行を追加', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: '直前の行削除を取り消す', exact: true }),
  ).toBeDisabled();
  await panel.getByLabel('台本JSONファイル').setInputFiles(file(fixture.script));
  await panel.getByRole('button', { name: '台本の切り替えをキャンセル', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: '直前の行削除を取り消す', exact: true }),
  ).toBeDisabled();
  await panel.getByLabel('台本JSONファイル').setInputFiles(file(fixture.script));
  await panel.getByRole('button', { name: '台本を保存せず切り替える', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: '直前の行削除を取り消す', exact: true }),
  ).toHaveCount(0);
});

test('follows continuous playback only when enabled and moves keyboard focus on demand', async ({
  page,
}, testInfo) => {
  await page.route('**/api/casting/preview', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: wav() }),
  );
  const panel = await open(page);
  await imported(panel);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await page.evaluate(() => {
    const state = window as unknown as { followed: string[] };
    state.followed = [];
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) {
      if (this.matches('li[aria-label^="台本の第"]'))
        state.followed.push(this.getAttribute('aria-label')!);
      scroll.call(this, options);
    };
    HTMLMediaElement.prototype.play = async function () {
      this.dispatchEvent(new Event('play'));
    };
  });
  const follow = panel.getByRole('checkbox', {
    name: '連続試聴中の行へ自動スクロール',
    exact: true,
  });
  const jump = panel.getByRole('button', { name: '連続試聴中の行へ移動', exact: true });
  const row = (index: number) =>
    panel.getByRole('listitem', { name: `台本の第${index}行`, exact: true });
  await expect(jump).toBeDisabled();
  await follow.uncheck();
  await panel.getByRole('button', { name: '台本順に連続試聴', exact: true }).click();
  await expect(row(1)).toHaveAttribute('aria-current', 'true');
  expect(await page.evaluate(() => (window as unknown as { followed: string[] }).followed)).toEqual(
    [],
  );
  await jump.click();
  await expect(row(1)).toBeFocused();
  await panel.getByLabel('台本の第1行の試聴', { exact: true }).dispatchEvent('ended');
  await expect(row(2)).toHaveAttribute('aria-current', 'true');
  expect(await page.evaluate(() => (window as unknown as { followed: string[] }).followed)).toEqual(
    ['台本の第1行'],
  );
  await follow.check();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { followed: string[] }).followed))
    .toEqual(['台本の第1行', '台本の第2行']);
  await expect(follow).toBeFocused();
  await jump.click();
  await expect(row(2)).toBeFocused();
  await row(2).screenshot({ path: testInfo.outputPath('playing-row.png') });
  await panel.getByLabel('台本の第2行の試聴', { exact: true }).dispatchEvent('ended');
  await expect(jump).toBeDisabled();
  await expect(row(2)).not.toHaveAttribute('aria-current', 'true');
});

test('undoes the last deleted row with settings and shared audio while preserving other edits', async ({
  page,
}, testInfo) => {
  let calls = 0;
  await page.route('**/api/casting/preview', (route) => {
    calls++;
    return route.fulfill({ contentType: 'audio/wav', body: wav() });
  });
  const panel = await open(page);
  await imported(panel);
  await panel.getByLabel('第1行の読み上げ文を別に指定', { exact: true }).check();
  await panel.getByLabel('第1行の読み上げ文', { exact: true }).fill('ようこそおいでくださいました');
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await panel.getByRole('button', { name: '第1行を複製', exact: true }).click();
  const before = await exported(page, panel);
  const url = await panel.getByLabel('台本の第1行の試聴', { exact: true }).getAttribute('src');
  await panel.getByRole('button', { name: '第1行を削除', exact: true }).click();
  await expect(panel.getByLabel('台本の第1行の試聴', { exact: true })).toHaveAttribute('src', url!);
  await panel
    .getByRole('region', { name: '直前の行削除の取り消し', exact: true })
    .screenshot({ path: testInfo.outputPath('undo-deleted-line.png') });
  await panel.getByLabel('第2行の発話者名', { exact: true }).fill('編集した名前');
  await panel.getByRole('button', { name: '直前の行削除を取り消す', exact: true }).click();
  await expect(panel.getByRole('listitem', { name: '台本の第1行', exact: true })).toBeFocused();
  await expect(panel.getByLabel('台本の第1行の試聴', { exact: true })).toHaveAttribute('src', url!);
  const restored = await exported(page, panel);
  expect(restored.lines[0]).toEqual(before.lines[0]);
  expect(restored.lines[2].character).toBe('編集した名前');
  await expect(panel.locator(':scope > ol audio')).toHaveCount(3);
  expect(calls).toBe(2);
  await panel.getByRole('button', { name: '第1行を削除', exact: true }).click();
  await panel.getByRole('button', { name: '第2行を削除', exact: true }).click();
  await panel.getByRole('button', { name: '直前の行削除を取り消す', exact: true }).click();
  const latest = await exported(page, panel);
  expect(latest.lines.map((line) => line.id)).toEqual([before.lines[1].id, before.lines[2].id]);
  await panel.getByRole('button', { name: '第1行を削除', exact: true }).click();
  await panel.getByRole('button', { name: '行削除の取り消し記録を破棄', exact: true }).click();
  await expect(
    panel.getByRole('button', { name: '直前の行削除を取り消す', exact: true }),
  ).toHaveCount(0);
  await panel.getByRole('button', { name: '第1行を削除', exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  await expect(
    panel.getByRole('button', { name: '直前の行削除を取り消す', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expand(page);
  await expect(
    panel.getByRole('button', { name: '直前の行削除を取り消す', exact: true }),
  ).toHaveCount(0);
});
