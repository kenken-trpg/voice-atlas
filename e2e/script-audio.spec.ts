import { test, expect, type Page, type Locator, type Download } from '@playwright/test';
import { scriptFixture } from '../tests/fixtures/script';
import { pcmWav } from '../tests/fixtures/wav';
import { scriptCandidate, serializeScript } from '../shared/script';
import { readPcmWav } from '../shared/wav';
const fixture = scriptFixture();
async function open(page: Page) {
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
  const panel = page.getByRole('region', { name: '台本の試聴', exact: true });
  await panel.getByLabel('台本JSONファイル').setInputFiles({
    name: 'script.json',
    mimeType: 'application/json',
    buffer: Buffer.from(serializeScript(fixture.script)),
  });
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toHaveValue('ようこそ。');
  return { panel, output: panel.getByRole('region', { name: '台本の結合WAV', exact: true }) };
}
async function expand(page: Page) {
  await page.getByRole('button', { name: 'VOICEVOX・AivisSpeechを比較する', exact: true }).click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
}
async function bytes(download: Download) {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function download(page: Page, output: Locator, name: string) {
  const event = page.waitForEvent('download');
  await output.getByRole('link', { name, exact: true }).click();
  return await event;
}
function mockAudio(page: Page) {
  return page.route('**/api/casting/preview', (route) => {
    const { candidate } = route.request().postDataJSON();
    const vv = candidate.voice.engine === 'VOICEVOX';
    return route.fulfill({
      contentType: 'audio/wav',
      body: Buffer.from(
        vv ? pcmWav(Array(882).fill(2000), 44100, 2) : pcmWav(Array(240).fill(1000), 24000),
      ),
      headers: {
        'X-Voice-Atlas-Generation': encodeURIComponent(
          JSON.stringify({
            engine: candidate.voice.engine,
            engineVersion: vv ? 'vv-current' : 'aivis-current',
            checkedAt: fixture.assignments[0].assignedAt,
          }),
        ),
      },
    });
  });
}
test('joins mixed-product WAVs with exact gaps, exports matching evidence and invalidates only the joined output', async ({
  page,
}, testInfo) => {
  let calls = 0;
  await page.on('request', (request) => {
    if (request.url().endsWith('/api/casting/preview')) calls++;
  });
  await mockAudio(page);
  const { panel, output } = await open(page);
  await expect(output.getByRole('button', { name: '台本の全行をWAVに結合' })).toBeDisabled();
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  await panel.getByLabel('結合WAVの行間', { exact: true }).fill('250');
  await output.getByRole('button', { name: '台本の全行をWAVに結合' }).click();
  await expect(output.getByRole('link', { name: '台本全体のWAVを保存' })).toBeVisible();
  const wavDownload = await download(page, output, '台本全体のWAVを保存');
  const wav = readPcmWav(await bytes(wavDownload));
  expect([wav.sampleRate, wav.channels, wav.frames]).toEqual([48000, 1, 12960]);
  expect(wav.samples.getInt16(0, true)).toBe(1000);
  expect(wav.samples.getInt16(480 * 2, true)).toBe(0);
  expect(wav.samples.getInt16(12480 * 2, true)).toBe(2000);
  const infoDownload = await download(page, output, '結合音声の出力記録JSONを保存');
  const info = JSON.parse((await bytes(infoDownload)).toString());
  expect(info.wavFileName).toBe(wavDownload.suggestedFilename());
  expect(infoDownload.suggestedFilename()).toBe(info.wavFileName.replace('.wav', '.json'));
  expect(
    info.lines.map((line: { startFrame: number; endFrame: number }) => [
      line.startFrame,
      line.endFrame,
    ]),
  ).toEqual([
    [0, 480],
    [12480, 12960],
  ]);
  expect(
    info.lines.map(
      (line: { audition: { generation: { engineVersion: string } } }) =>
        line.audition.generation.engineVersion,
    ),
  ).toEqual(['aivis-current', 'vv-current']);
  expect(info.script.lines[1].assignment.character).toBe('騎士');
  await output.screenshot({ path: testInfo.outputPath('script-audio.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.getByLabel('結合WAVの行間', { exact: true }).fill('0');
  await expect(output.getByRole('link')).toHaveCount(0);
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await output.getByRole('button', { name: '台本の全行をWAVに結合' }).click();
  await expect(output.getByRole('status')).toContainText('0.020秒');
  await panel.getByRole('button', { name: '第2行を上へ', exact: true }).click();
  await expect(output.getByRole('link')).toHaveCount(0);
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await output.getByRole('button', { name: '台本の全行をWAVに結合' }).click();
  await expect(output.getByRole('link', { name: '台本全体のWAVを保存' })).toBeVisible();
  const reordered = readPcmWav(await bytes(await download(page, output, '台本全体のWAVを保存')));
  expect(reordered.samples.getInt16(0, true)).toBe(2000);
  await panel.getByLabel('台本名', { exact: true }).fill('変更した台本');
  await expect(output.getByRole('link')).toHaveCount(0);
  await panel.getByRole('button', { name: '台本をブラウザに保存', exact: true }).click();
  await page.reload();
  await expand(page);
  await expect(panel.getByLabel('結合WAVの行間', { exact: true })).toHaveValue('0');
  await expect(panel.locator('audio')).toHaveCount(0);
  expect(calls).toBe(2);
});
test('refuses unsupported WAVs without losing row downloads and succeeds after regenerating the failed row', async ({
  page,
}) => {
  let invalid = true;
  await page.route('**/api/casting/preview', (route) => {
    const vv = route.request().postDataJSON().candidate.voice.engine === 'VOICEVOX';
    const wav = pcmWav(Array(240).fill(1000));
    if (vv && invalid) new DataView(wav.buffer).setUint16(20, 3, true);
    return route.fulfill({ contentType: 'audio/wav', body: Buffer.from(wav) });
  });
  const { panel, output } = await open(page);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await output.getByRole('button', { name: '台本の全行をWAVに結合' }).click();
  await expect(output.getByRole('alert')).toContainText('16bit PCM');
  await expect(output.getByRole('link')).toHaveCount(0);
  await expect(panel.getByRole('link', { name: '第1行のWAVを保存', exact: true })).toBeVisible();
  invalid = false;
  await panel.getByRole('button', { name: '第2行を再生成', exact: true }).click();
  await expect(output.getByRole('button', { name: '台本の全行をWAVに結合' })).toBeEnabled();
  await output.getByRole('button', { name: '台本の全行をWAVに結合' }).click();
  await expect(output.getByRole('link', { name: '台本全体のWAVを保存' })).toBeVisible();
  await panel.getByLabel('第1行のセリフ', { exact: true }).fill('変更');
  await expect(output.getByRole('link')).toHaveCount(0);
  await expect(output.getByRole('button', { name: '台本の全行をWAVに結合' })).toBeDisabled();
});
test('cancels preparation and enforces input byte limits while preserving generated row audio', async ({
  page,
}) => {
  await mockAudio(page);
  const { panel, output } = await open(page);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator('audio')).toHaveCount(2);
  await page.evaluate(() => {
    const original = window.Worker;
    const state = window as unknown as {
      releaseJoin: (() => void) | null;
      joinTerminated: boolean;
    };
    state.releaseJoin = null;
    state.joinTerminated = false;
    window.Worker = class extends original {
      postMessage(message: unknown) {
        state.releaseJoin = () => super.postMessage(message);
      }
      terminate() {
        state.joinTerminated = true;
        super.terminate();
      }
    };
    (window as unknown as { restoreJoin: () => void }).restoreJoin = () => {
      window.Worker = original;
      state.releaseJoin?.();
    };
  });
  await output.getByRole('button', { name: '台本の全行をWAVに結合' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => typeof (window as unknown as { releaseJoin: unknown }).releaseJoin),
    )
    .toBe('function');
  await expect(panel.getByLabel('第1行のセリフ', { exact: true })).toBeDisabled();
  await output.getByRole('button', { name: '台本の結合を中止' }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { joinTerminated: boolean }).joinTerminated),
    )
    .toBe(true);
  await page.evaluate(() => (window as unknown as { restoreJoin: () => void }).restoreJoin());
  await expect(output.getByRole('alert')).toContainText('中止');
  await expect(output.getByRole('link')).toHaveCount(0);
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await page.evaluate(() => {
    const original = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!;
    Object.defineProperty(Blob.prototype, 'size', {
      get: () => 65 * 1024 * 1024,
      configurable: true,
    });
    (window as unknown as { restoreSize: () => void }).restoreSize = () => {
      Object.defineProperty(Blob.prototype, 'size', original);
    };
  });
  await output.getByRole('button', { name: '台本の全行をWAVに結合' }).click();
  await expect(output.getByRole('alert')).toContainText('64MiB');
  await page.evaluate(() => (window as unknown as { restoreSize: () => void }).restoreSize());
  await output.getByRole('button', { name: '台本の全行をWAVに結合' }).click();
  await expect(output.getByRole('link', { name: '台本全体のWAVを保存' })).toBeVisible();
});

test('keeps row audio after worker startup failure and retries with a fresh worker', async ({
  page,
}) => {
  await mockAudio(page);
  const { panel, output } = await open(page);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  const urls = await panel
    .locator(':scope > ol audio')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src')));
  await page.evaluate(() => {
    const original = window.Worker;
    window.Worker = class extends original {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        queueMicrotask(() => this.dispatchEvent(new ErrorEvent('error', { cancelable: true })));
      }
    };
    (window as unknown as { restoreWorker: () => void }).restoreWorker = () => {
      window.Worker = original;
    };
  });
  await output.getByRole('button', { name: '台本の全行をWAVに結合' }).click();
  await expect(output.getByRole('alert')).toContainText('起動・実行できません');
  expect(
    await panel
      .locator(':scope > ol audio')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('src'))),
  ).toEqual(urls);
  await page.evaluate(() => (window as unknown as { restoreWorker: () => void }).restoreWorker());
  await output.getByRole('button', { name: '台本の全行をWAVに結合' }).click();
  await expect(output.getByRole('link', { name: '台本全体のWAVを保存' })).toBeVisible();
});

test('terminates the pending join when the script panel closes and preserves row audio on reopening', async ({
  page,
}) => {
  await mockAudio(page);
  const { panel, output } = await open(page);
  await panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await page.evaluate(() => {
    const state = window as unknown as {
      joinPending: boolean;
      joinTerminated: boolean;
      restoreWorker: () => void;
    };
    const original = window.Worker;
    state.joinPending = false;
    state.joinTerminated = false;
    window.Worker = class extends original {
      postMessage() {
        state.joinPending = true;
      }
      terminate() {
        state.joinTerminated = true;
        super.terminate();
      }
    };
    state.restoreWorker = () => {
      window.Worker = original;
    };
  });
  await output.getByRole('button', { name: '台本の全行をWAVに結合' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { joinPending: boolean }).joinPending))
    .toBe(true);
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { joinTerminated: boolean }).joinTerminated),
    )
    .toBe(true);
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  await expect(panel.locator(':scope > ol audio')).toHaveCount(2);
  await expect(output.getByRole('link')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { restoreWorker: () => void }).restoreWorker());
  await output.getByRole('button', { name: '台本の全行をWAVに結合' }).click();
  await expect(output.getByRole('link', { name: '台本全体のWAVを保存' })).toBeVisible();
});
