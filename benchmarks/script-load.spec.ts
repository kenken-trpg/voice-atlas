import { test, expect, type Page } from '@playwright/test';
import { projectFixture } from '../tests/fixtures/project';
import { pcmWav } from '../tests/fixtures/wav';
import { projectStorageKey } from '../shared/project';
import { scriptCandidate } from '../shared/script';
import { maxJoinInputBytes } from '../shared/wav';

type BrowserProbe = {
  scriptProbe: { start: number; longTasks: { start: number; duration: number }[] };
};

const scenarios = [
  { rows: 10, seconds: 10, sampleRate: 24000 },
  { rows: 20, seconds: 10, sampleRate: 24000 },
  { rows: 20, seconds: 30, sampleRate: 48000 },
  { rows: 20, seconds: 40, sampleRate: 48000 },
];

async function expand(page: Page) {
  await page.getByRole('button', { name: 'VOICEVOX・AivisSpeechを比較する', exact: true }).click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  return page.getByRole('region', { name: '台本の試聴', exact: true });
}

for (const scenario of scenarios) {
  test(`${scenario.rows} rows / ${scenario.seconds}s / ${scenario.sampleRate}Hz`, async ({
    page,
    context,
    browser,
  }, testInfo) => {
    const project = projectFixture();
    const template = project.documents.script!.lines[0];
    project.documents.script!.lines = Array.from({ length: scenario.rows }, (_, index) => ({
      ...structuredClone(template),
      id: crypto.randomUUID(),
      text: `${index + 1}行目。${'塔の入口で仲間を待っています。'.repeat(20)}`.slice(0, 300),
    }));
    const raw = JSON.stringify(project);
    const wav = Buffer.from(
      pcmWav(Array(scenario.seconds * scenario.sampleRate).fill(1000), scenario.sampleRate),
    );
    const inputBytes = wav.length * scenario.rows;
    const overCapacity = inputBytes > maxJoinInputBytes;
    const cdp = await context.newCDPSession(page);
    const cpuSlowdown = testInfo.project.name === 'mobile' ? 4 : 1;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });
    await cdp.send('Performance.enable');
    const steps: Record<string, unknown>[] = [];
    let requests = 0;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(
      ({ key, raw }) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, raw);
        const probe = { start: 0, longTasks: [] as { start: number; duration: number }[] };
        (window as unknown as BrowserProbe).scriptProbe = probe;
        if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              probe.longTasks.push({ start: entry.startTime, duration: entry.duration });
          }).observe({ type: 'longtask', buffered: true });
        }
      },
      { key: projectStorageKey, raw },
    );
    // Every browser request is local or mocked; the benchmark cannot invoke an engine/cloud API.
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/casting/voices')
        return route.fulfill({
          json: {
            checkedAt: project.createdAt,
            engines: ['VOICEVOX', 'AivisSpeech'].map((engine) => ({
              engine,
              ready: true,
              detail: 'benchmark mock',
            })),
            voices: [scriptCandidate(template)!.voice],
          },
        });
      if (path === '/api/casting/preview') {
        requests++;
        return route.fulfill({ contentType: 'audio/wav', body: wav });
      }
      if (path === '/api/casting/aivis-models')
        return route.fulfill({ json: { ready: false, checkedAt: project.createdAt, models: [] } });
      if (path === '/api/capabilities')
        return route.fulfill({
          json: {
            ollama: { ready: false, textReady: false },
            openai: { ready: false },
            anthropic: { ready: false },
            gemini: { ready: false },
            voicevox: { ready: false },
          },
        });
      return route.abort('blockedbyclient');
    });

    async function measure(name: string, action: () => Promise<void>) {
      await page.evaluate(() => {
        (window as unknown as BrowserProbe).scriptProbe.start = performance.now();
      });
      await action();
      // Flush rendering and observer delivery before reading the interval.
      const timing = await page.evaluate(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const { start, longTasks } = (window as unknown as BrowserProbe).scriptProbe;
        const entries = longTasks.filter((entry) => entry.start >= start);
        return {
          elapsedMs: performance.now() - start,
          longTasks: entries.length,
          longTaskMs: entries.reduce((sum, entry) => sum + entry.duration, 0),
          longestTaskMs: Math.max(0, ...entries.map((entry) => entry.duration)),
        };
      });
      const metrics = (await cdp.send('Performance.getMetrics')).metrics;
      steps.push({
        name,
        ...timing,
        jsHeapUsedBytes: metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? null,
      });
    }

    await page.goto('/');
    let panel = page.getByRole('region', { name: '台本の試聴', exact: true });
    const generate = () =>
      panel.getByRole('button', { name: '未生成の行を台本順に生成', exact: true });
    await measure('open', async () => {
      panel = await expand(page);
      await expect(panel.locator(':scope > ol > li')).toHaveCount(scenario.rows);
      await expect(generate()).toBeEnabled();
    });
    await measure('edit', async () => {
      const input = panel.getByLabel(`第${scenario.rows}行のセリフ`, { exact: true });
      await input.fill('最後の行を編集してもほかの行の設定を保持します。');
      await expect(input).toHaveValue('最後の行を編集してもほかの行の設定を保持します。');
    });
    await measure('save-project', async () => {
      await page.getByText('作品を保存・復元する', { exact: true }).click();
      const projectPanel = page.getByRole('region', { name: '作品の保存と復元', exact: true });
      await projectPanel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
      await expect(
        projectPanel.getByText('作品はブラウザに保存済みです', { exact: true }),
      ).toBeVisible();
    });
    await measure('generate-mocked', async () => {
      await generate().click();
      await expect(panel.locator(':scope > ol audio')).toHaveCount(scenario.rows);
      await expect(
        panel.getByRole('region', { name: '台本の生成状況', exact: true }),
      ).toContainText('すべて成功');
    });
    expect(requests).toBe(scenario.rows);
    const cache = panel.getByRole('region', { name: '台本音声の保存と再利用', exact: true });
    await panel.getByText('台本音声の保存と再利用', { exact: true }).click();
    await measure('save-audio', async () => {
      await cache.getByRole('button', { name: '台本音声をブラウザに保存', exact: true }).click();
      await expect(panel).toContainText(
        overCapacity ? '容量上限' : `${scenario.rows}行の音声をこのブラウザに保存しました`,
      );
    });
    const output = panel.getByRole('region', { name: '台本の結合WAV', exact: true });
    await measure('join', async () => {
      await output.getByRole('button', { name: '台本の全行をWAVに結合', exact: true }).click();
      if (overCapacity) await expect(output.getByRole('alert')).toContainText('合計64MiB');
      else
        await expect(
          output.getByRole('link', { name: '台本全体のWAVを保存', exact: true }),
        ).toBeVisible();
    });
    await expect(panel.locator(':scope > ol audio')).toHaveCount(scenario.rows);
    expect(requests).toBe(scenario.rows);
    if (!overCapacity) {
      // Validate the large output without loading its full PCM into the test process.
      const event = page.waitForEvent('download');
      await output.getByRole('link', { name: '台本全体のWAVを保存', exact: true }).click();
      const stream = await (await event).createReadStream();
      let header = Buffer.alloc(0),
        size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk);
        if (header.length < 44) header = Buffer.concat([header, bytes]).subarray(0, 44);
        size += bytes.length;
      }
      const frames = scenario.rows * scenario.seconds * 48000 + (scenario.rows - 1) * 14400;
      expect(size).toBe(44 + frames * 2);
      expect(header.toString('ascii', 0, 4)).toBe('RIFF');
      expect(header.readUInt32LE(24)).toBe(48000);
      expect(header.readUInt32LE(40)).toBe(frames * 2);
    }
    // Native storage includes IndexedDB data, unlike JSHeapUsedSize (which excludes Blobs).
    const storage = await page.evaluate(async () => {
      const estimate = await navigator.storage.estimate();
      return { usageBytes: estimate.usage ?? null, quotaBytes: estimate.quota ?? null };
    });
    await page.reload();
    await measure('restore-audio', async () => {
      panel = await expand(page);
      await expect(panel.locator(':scope > ol audio')).toHaveCount(
        overCapacity ? 0 : scenario.rows,
      );
      if (overCapacity) await expect(generate()).toBeEnabled();
      else
        await expect(
          panel.getByRole('button', { name: '第1行を再生成', exact: true }),
        ).toBeEnabled();
      await expect(panel.getByLabel(`第${scenario.rows}行のセリフ`, { exact: true })).toHaveValue(
        '最後の行を編集してもほかの行の設定を保持します。',
      );
    });
    expect(requests).toBe(scenario.rows);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await testInfo.attach('script-measurements', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          profile: testInfo.project.name,
          repeat: testInfo.repeatEachIndex,
          browser: browser.version(),
          cpuSlowdown,
          scenario,
          inputBytes,
          projectJsonBytes: Buffer.byteLength(raw),
          expectedCapacityRejection: overCapacity,
          requests,
          storage,
          longTaskObservationSupported: await page.evaluate(() =>
            PerformanceObserver.supportedEntryTypes.includes('longtask'),
          ),
          steps,
        },
        null,
        2,
      ),
    });
  });
}
