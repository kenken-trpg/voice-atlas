import { test, expect } from '@playwright/test';
import { projectFixture } from '../tests/fixtures/project';
import { validateProject } from '../shared/project';

const scenarios = [
  { rows: 2, seconds: 1, sampleRate: 24000 },
  { rows: 10, seconds: 10, sampleRate: 48000 },
  { rows: 20, seconds: 34, sampleRate: 48000 },
];

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
      text: `${index + 1}行目。塔の入口で仲間を待っています。`,
    }));
    const source = validateProject(project);
    const audioBytes = scenario.rows * (44 + scenario.seconds * scenario.sampleRate * 2);
    expect(audioBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    const cdp = await context.newCDPSession(page);
    const cpuSlowdown = testInfo.project.name === 'mobile' ? 4 : 1;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdown });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname;
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
      if (path === '/api/casting/voices')
        return route.fulfill({ json: { checkedAt: source.createdAt, engines: [], voices: [] } });
      if (path === '/api/casting/aivis-models')
        return route.fulfill({ json: { ready: false, checkedAt: source.createdAt, models: [] } });
      return route.abort('blockedbyclient');
    });
    await page.goto('/benchmarks/archive-probe.html');
    await expect(page.getByText('Archive benchmark probe')).toBeVisible();
    const result = await page.evaluate(
      async ({ project, scenario }) => {
        const storePath = '/src/lib/script-audio-store.ts';
        const archivePath = '/shared/project-archive.ts';
        const restorePath = '/src/lib/project-archive.ts';
        const { saveProjectArchiveAudio, loadScriptAudio } = (await import(
          storePath
        )) as typeof import('../src/lib/script-audio-store');
        const { createProjectArchive, parseProjectArchive, projectArchiveLines } = (await import(
          archivePath
        )) as typeof import('../shared/project-archive');
        const { restoreProjectArchive } = (await import(
          restorePath
        )) as typeof import('../src/lib/project-archive');
        const lines = projectArchiveLines(project);
        const tasks: { start: number; duration: number }[] = [];
        const longTaskSupported = PerformanceObserver.supportedEntryTypes.includes('longtask');
        if (longTaskSupported)
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              tasks.push({ start: entry.startTime, duration: entry.duration });
          }).observe({ type: 'longtask', buffered: true });
        const steps: {
          name: string;
          elapsedMs: number;
          longestTaskMs: number;
          jsHeapUsedBytes: number | null;
          storageUsageBytes: number | null;
        }[] = [];
        async function measure(name: string, action: () => Promise<void>) {
          const start = performance.now();
          await action();
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
          const matching = tasks.filter((task) => task.start >= start);
          const memory = performance as Performance & { memory?: { usedJSHeapSize: number } };
          steps.push({
            name,
            elapsedMs: performance.now() - start,
            longestTaskMs: Math.max(0, ...matching.map((task) => task.duration)),
            jsHeapUsedBytes: memory.memory?.usedJSHeapSize ?? null,
            storageUsageBytes: (await navigator.storage.estimate()).usage ?? null,
          });
        }
        const audio = lines.map((line, index) => {
          const frames = scenario.seconds * scenario.sampleRate;
          const bytes = new Uint8Array(44 + frames * 2);
          const view = new DataView(bytes.buffer);
          bytes.set([82, 73, 70, 70], 0); // RIFF
          view.setUint32(4, bytes.length - 8, true);
          bytes.set([87, 65, 86, 69, 102, 109, 116, 32], 8); // WAVEfmt
          view.setUint32(16, 16, true);
          view.setUint16(20, 1, true);
          view.setUint16(22, 1, true);
          view.setUint32(24, scenario.sampleRate, true);
          view.setUint32(28, scenario.sampleRate * 2, true);
          view.setUint16(32, 2, true);
          view.setUint16(34, 16, true);
          bytes.set([100, 97, 116, 97], 36); // data
          view.setUint32(40, frames * 2, true);
          bytes[44] = index + 1;
          return {
            line,
            blob: new Blob([bytes], { type: 'audio/wav' }),
            audition: { generation: null },
          };
        });
        let archive!: Blob;
        let parsed!: Awaited<ReturnType<typeof parseProjectArchive>>;
        let restoredId = '';
        await measure('save-source-audio', () => saveProjectArchiveAudio(project.id, audio));
        await measure('export', async () => {
          const saved = await loadScriptAudio(project.id, lines);
          if (saved.length !== scenario.rows) throw new Error('保存音声の件数が一致しません。');
          archive = await createProjectArchive(project, saved);
        });
        await measure('inspect', async () => {
          parsed = await parseProjectArchive(archive);
        });
        await measure('restore', async () => {
          const restored = await restoreProjectArchive(
            parsed,
            (next) => {
              localStorage.setItem('voice-atlas-archive-benchmark-restored', JSON.stringify(next));
            },
            new AbortController().signal,
          );
          restoredId = restored.id;
        });
        const restored = await loadScriptAudio(restoredId, projectArchiveLines(parsed.project));
        if (
          restoredId === project.id ||
          restored.length !== scenario.rows ||
          restored.reduce((sum, item) => sum + item.blob.size, 0) !==
            audio.reduce((sum, item) => sum + item.blob.size, 0)
        )
          throw new Error('復元後の音声が一致しません。');
        return {
          steps,
          archiveBytes: archive.size,
          inputAudioBytes: audio.reduce((sum, item) => sum + item.blob.size, 0),
          restoredRows: restored.length,
          longTaskSupported,
        };
      },
      { project: source, scenario },
    );
    expect(result.restoredRows).toBe(scenario.rows);
    expect(result.inputAudioBytes).toBe(audioBytes);
    expect(errors).toEqual([]);
    await testInfo.attach('archive-measurements', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          profile: testInfo.project.name,
          repeat: testInfo.repeatEachIndex,
          browser: browser.version(),
          cpuSlowdown,
          scenario,
          ...result,
        },
        null,
        2,
      ),
    });
  });
}
