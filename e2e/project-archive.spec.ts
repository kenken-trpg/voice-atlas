import { test, expect, type Page, type Download } from '@playwright/test';
import { projectFixture } from '../tests/fixtures/project';
import { pcmWav } from '../tests/fixtures/wav';
import { projectStorageKey, projectLibraryStorageKey, type VoiceProject } from '../shared/project';
import { scriptAudioKey, scriptCandidate } from '../shared/script';
import {
  createProjectArchive,
  parseProjectArchive,
  projectArchiveLines,
} from '../shared/project-archive';
import { makeScriptLibraryEntry } from '../shared/script-library';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function fixture() {
  const project = projectFixture();
  project.documents.script!.lines[0].spokenText = 'ほしよみのとうへ、ようこそ。';
  project.documents.script!.lines[0].readingSource = 'manual';
  return project;
}
async function bytes(download: Download) {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function archiveFile(project = fixture()) {
  return Buffer.from(
    await (
      await createProjectArchive(
        project,
        projectArchiveLines(project).map((line) => ({
          lineId: line.id,
          key: scriptAudioKey(line),
          blob: new Blob([pcmWav([321, -123])]),
          audition: { generation: null },
        })),
      )
    ).arrayBuffer(),
  );
}
async function open(page: Page, project?: VoiceProject, ready = true) {
  if (project)
    await page.addInitScript(
      ({ key, value }) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
      },
      { key: projectStorageKey, value: JSON.stringify(project) },
    );
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: '2026-10-23T00:00:00Z',
        engines: ['VOICEVOX', 'AivisSpeech'].map((engine) => ({
          engine,
          ready,
          detail: ready ? '接続済み' : '未接続',
        })),
        voices: ready
          ? fixture().documents.script!.lines.map((line) => scriptCandidate(line)!.voice)
          : [],
      },
    }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({ json: { ready: false, checkedAt: '2026-10-23T00:00:00Z', models: [] } }),
  );
  let calls = 0;
  await page.route('**/api/casting/preview', (route) => {
    calls++;
    return route.fulfill({
      contentType: 'audio/wav',
      body: Buffer.from(pcmWav(Array(2400).fill(calls * 100))),
      headers: {
        'X-Voice-Atlas-Generation': encodeURIComponent(
          JSON.stringify({
            engine: route.request().postDataJSON().candidate.voice.engine,
            engineVersion: 'archive-current',
            checkedAt: '2026-10-23T00:00:00Z',
          }),
        ),
      },
    });
  });
  await page.goto('/');
  const panel = page.getByRole('region', { name: '作品の保存と復元', exact: true });
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  return {
    panel,
    archive: panel.getByRole('region', { name: '音声付き作品アーカイブ', exact: true }),
    calls: () => calls,
  };
}
async function scriptPanel(page: Page) {
  const panel = page.getByRole('region', { name: '台本の試聴', exact: true });
  if (!(await panel.isVisible())) {
    await page
      .getByRole('button', { name: 'VOICEVOX・AivisSpeechを比較する', exact: true })
      .click();
    await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
    await page.getByText('台本を作成・試聴する', { exact: true }).click();
  }
  return panel;
}
async function savedAudio(page: Page, panel: ReturnType<Page['getByRole']>) {
  const script = await scriptPanel(page);
  await panel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  await script.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(script.locator(':scope > ol audio')).toHaveCount(2);
  await script.getByText('台本音声の保存と再利用', { exact: true }).click();
  await script.getByRole('button', { name: '台本音声をブラウザに保存', exact: true }).click();
  await expect(script).toContainText('2行の音声をこのブラウザに保存しました');
  return script;
}
async function exportArchive(page: Page) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: '音声付き作品アーカイブを書き出す', exact: true }).click();
  return bytes(await event);
}
async function inspect(page: Page, buffer: Buffer) {
  await page
    .getByLabel('作品アーカイブファイル', { exact: true })
    .setInputFiles({ name: 'project.vaarchive', mimeType: 'application/octet-stream', buffer });
}
async function stored(page: Page) {
  return page.evaluate(
    ({ single, library }) => {
      const list = localStorage.getItem(library);
      const raw = localStorage.getItem(single);
      return list ? JSON.parse(list).projects : raw ? [JSON.parse(raw)] : [];
    },
    { single: projectStorageKey, library: projectLibraryStorageKey },
  ) as Promise<VoiceProject[]>;
}
async function audioProjects(page: Page) {
  return page.evaluate(
    async () =>
      new Promise<string[]>((resolve, reject) => {
        const request = indexedDB.open('voice-atlas-script-audio-v1', 1);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('sizes', 'readonly');
          const get = tx.objectStore('sizes').getAll();
          tx.oncomplete = () => {
            db.close();
            resolve(get.result.map((row: { projectId: string }) => row.projectId).sort());
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
        request.onerror = () => reject(request.error);
      }),
  );
}

test('exports saved WAVs and restores into a clean offline browser without generation', async ({
  page,
  browser,
}, testInfo) => {
  const source = fixture();
  const { panel, calls } = await open(page, source);
  await savedAudio(page, panel);
  const buffer = await exportArchive(page);
  const decoded = await parseProjectArchive(new Blob([buffer]));
  expect(decoded.audio).toHaveLength(2);
  expect(decoded.audio[0].audition.generation?.engineVersion).toBe('archive-current');
  expect(calls()).toBe(2);
  const fresh = await browser.newContext({
    viewport: testInfo.project.use.viewport,
    isMobile: testInfo.project.use.isMobile,
    hasTouch: testInfo.project.use.hasTouch,
  });
  try {
    const other = await fresh.newPage();
    const target = await open(other, undefined, false);
    await inspect(other, buffer);
    const confirmation = target.archive.getByRole('group', {
      name: '音声付き作品の復元確認',
      exact: true,
    });
    await expect(confirmation).toContainText('保存音声2行');
    await confirmation.screenshot({ path: testInfo.outputPath('archive-confirmation.png') });
    expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await confirmation
      .getByRole('button', { name: '音声付き作品の復元をキャンセル', exact: true })
      .click();
    expect(await stored(other)).toEqual([]);
    await inspect(other, buffer);
    await target.archive
      .getByRole('button', { name: '確認した音声付き作品を復元', exact: true })
      .click();
    await expect.poll(async () => (await stored(other)).length).toBe(1);
    const restored = (await stored(other))[0];
    expect(restored.id).not.toBe(source.id);
    expect(restored.documents).toEqual(decoded.project.documents);
    const script = await scriptPanel(other);
    await expect(script.locator(':scope > ol audio')).toHaveCount(2);
    await expect(script).toContainText('archive-current');
    const event = other.waitForEvent('download');
    await script.getByRole('link', { name: '第1行のWAVを保存', exact: true }).click();
    expect(await bytes(await event)).toEqual(
      Buffer.from(await decoded.audio[0].blob.arrayBuffer()),
    );
    await other.reload();
    await scriptPanel(other);
    await expect(script.locator(':scope > ol audio')).toHaveCount(2);
    expect(target.calls()).toBe(0);
  } finally {
    await fresh.close();
  }
});

test('carries selected Irodori samples to a new browser and plays them after reload', async ({
  page,
  browser,
}) => {
  test.skip(
    !existsSync(
      resolve(
        '.local-artifacts/irodori-v41-voice-design-20261024/sample_20261024_074100_778062_001.wav',
      ),
    ),
  );
  const seed = projectFixture();
  seed.documents.script!.lines[0].character = '長老';
  seed.documents.script!.lines[1].character = 'ナレーター';
  seed.documents.irodoriSpeakerLinks = [{ speaker: 'ナレーター', character: '長老' }];
  await page.addInitScript(
    ({ key, value }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    { key: projectStorageKey, value: JSON.stringify(seed) },
  );
  await page.goto('/');
  const voices = page.getByRole('region', { name: 'Irodori生成済みの声を比較' });
  await voices.getByRole('button', { name: 'この端末の検証音声を読み込む' }).click();
  await expect(voices.locator('audio')).toHaveCount(6);
  await voices.getByRole('button', { name: '作品の候補に保存' }).first().click();
  await voices.getByRole('button', { name: '作品の候補に保存' }).first().click();
  const comparison = voices.getByRole('region', { name: 'キャラクターごとのIrodori比較' });
  await comparison.getByRole('textbox', { name: '比較するキャラクター名' }).fill('長老');
  await comparison.getByRole('checkbox', { name: '老魔術師' }).check();
  await comparison.getByRole('checkbox', { name: '企業幹部' }).check();
  await comparison.getByRole('textbox', { name: 'Irodoriの比較メモ' }).fill('落ち着いた声');
  await comparison.getByRole('button', { name: 'この声に仮配役' }).first().click();
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: '音声付き作品アーカイブを書き出す' }).click();
  const buffer = await bytes(await event);
  const parsed = await parseProjectArchive(new Blob([buffer]));
  expect(parsed.project.documents.irodoriCandidates).toEqual(['old_mage', 'executive']);
  expect(parsed.project.documents.irodoriComparisons).toEqual([
    { character: '長老', voiceIds: ['old_mage', 'executive'], note: '落ち着いた声' },
  ]);
  expect(parsed.project.documents.irodoriAssignments).toEqual([
    { character: '長老', voiceId: 'old_mage', reason: '落ち着いた声' },
  ]);
  expect(parsed.project.documents.irodoriSpeakerLinks).toEqual([
    { speaker: 'ナレーター', character: '長老' },
  ]);
  expect(parsed.irodoriAudio).toHaveLength(4);
  const fresh = await browser.newContext();
  try {
    const other = await fresh.newPage();
    await other.goto('/');
    await other.getByText('作品を保存・復元する', { exact: true }).click();
    const damaged = Buffer.from(buffer);
    damaged[damaged.length - 1] ^= 1;
    await inspect(other, damaged);
    const archive = other.getByRole('region', { name: '音声付き作品アーカイブ' });
    await expect(archive.getByRole('alert')).toContainText('Irodoriの候補音声が破損');
    await inspect(other, buffer);
    await expect(archive.getByRole('group', { name: '音声付き作品の復元確認' })).toContainText(
      'Irodori候補音声4件',
    );
    await other.evaluate((key) => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException('full', 'QuotaExceededError');
        original.call(this, name, value);
      };
    }, projectLibraryStorageKey);
    await archive.getByRole('button', { name: '確認した音声付き作品を復元' }).click();
    await expect(archive.getByRole('alert')).toContainText('保存容量');
    await other.reload();
    const restored = other.getByRole('region', { name: 'Irodori生成済みの声を比較' });
    await expect(restored.locator('audio')).toHaveCount(0);
    await other.getByText('作品を保存・復元する', { exact: true }).click();
    await inspect(other, buffer);
    await archive.getByRole('button', { name: '確認した音声付き作品を復元' }).click();
    await expect(restored.locator('audio')).toHaveCount(5);
    await other.reload();
    await expect(restored.locator('audio')).toHaveCount(5);
    await expect(restored.getByText('この作品の候補：2件 / 3件')).toBeVisible();
    await expect(restored.getByRole('heading', { name: '長老：老魔術師' })).toBeVisible();
    await expect(restored.getByText('比較メモ：落ち着いた声')).toBeVisible();
    await restored.getByRole('button', { name: '比較を開く' }).click();
    await expect(restored.locator('audio')).toHaveCount(9);
    const script = await scriptPanel(other);
    await expect(script.getByRole('listitem', { name: '台本の第1行' })).toContainText(
      'Irodori仮配役：長老 → 老魔術師',
    );
    await expect(script.getByRole('listitem', { name: '台本の第2行' })).toContainText(
      'Irodori仮配役：長老 → 老魔術師',
    );
    await expect(script.locator('audio[aria-label="第1行のIrodori仮配役音声"]')).toBeVisible();
    await expect(script.locator('audio[aria-label="第2行のIrodori仮配役音声"]')).toBeVisible();
  } finally {
    await fresh.close();
  }
});

test('shows projected archive capacity and rechecks it before restore', async ({ page }) => {
  const { archive } = await open(page, fixture());
  await inspect(page, await archiveFile());
  const confirmation = archive.getByRole('group', { name: '音声付き作品の復元確認' });
  await expect(confirmation).toContainText('このブラウザの保存音声：現在0.00MiB・0行');
  const putUsage = (bytes: number | null) =>
    page.evaluate(async (bytes) => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('voice-atlas-script-audio-v1', 1);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('sizes', 'readwrite');
          if (bytes === null) tx.objectStore('sizes').delete('synthetic-other-project');
          else
            tx.objectStore('sizes').put({
              id: 'synthetic-other-project',
              projectId: crypto.randomUUID(),
              bytes,
            });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
        request.onerror = () => reject(request.error);
      });
    }, bytes);
  const confirm = confirmation.getByRole('button', { name: '確認した音声付き作品を復元' });
  await putUsage(128 * 1024 ** 2);
  await confirmation.getByRole('button', { name: '保存容量を再確認' }).click();
  await expect(confirmation).toContainText('復元後の見込み128.00MiB');
  await expect(confirm).toBeDisabled();
  await putUsage(null);
  await confirmation.getByRole('button', { name: '保存容量を再確認' }).click();
  await expect(confirm).toBeEnabled();
  await putUsage(128 * 1024 ** 2);
  await confirm.click();
  const discard = confirmation.getByRole('button', {
    name: '未保存の変更を破棄して音声付き作品へ切り替える',
  });
  await expect(discard).toBeVisible();
  await discard.click();
  await expect(archive.getByRole('alert')).toContainText('128MiB・1000行の上限');
  await expect(confirm).toBeDisabled();
  await putUsage(null);
  await confirmation.getByRole('button', { name: '保存容量を再確認' }).click();
  await expect(confirm).toBeEnabled();
  await discard.click();
  await expect.poll(async () => (await stored(page)).length).toBe(2);
});

test('includes saved-script audio for an older condition and keeps the original project separate', async ({
  page,
}) => {
  const source = fixture();
  source.documents.scriptLibrary.entries = [
    makeScriptLibraryEntry(structuredClone(source.documents.script!), '物語', '導入'),
  ];
  const { panel, calls, archive } = await open(page, source);
  const script = await savedAudio(page, panel);
  await script.getByLabel('第1行の読み上げ文', { exact: true }).fill('編集中だけの別の読み方');
  await panel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  const before = (await stored(page))[0];
  const buffer = await exportArchive(page);
  expect((await parseProjectArchive(new Blob([buffer]))).audio).toHaveLength(2);
  await inspect(page, buffer);
  await archive.getByRole('button', { name: '確認した音声付き作品を復元', exact: true }).click();
  await expect.poll(async () => (await stored(page)).length).toBe(2);
  const projects = await stored(page);
  expect(projects).toHaveLength(2);
  expect(projects.find((p) => p.id === source.id)).toEqual(before);
  const restoredScript = await scriptPanel(page);
  await expect(restoredScript.locator(':scope > ol audio')).toHaveCount(1);
  await restoredScript.getByText('作品・場面ごとの台本ライブラリ', { exact: true }).click();
  await restoredScript.getByRole('button', { name: 'この台本を開く', exact: true }).click();
  await expect(restoredScript.getByLabel('第1行の読み上げ文', { exact: true })).toHaveValue(
    source.documents.script!.lines[0].spokenText!,
  );
  await expect(restoredScript.locator(':scope > ol audio')).toHaveCount(2);
  expect(calls()).toBe(2);
});

test('rolls back staged audio after settings quota failure and preserves unsaved edits and old audio', async ({
  page,
}) => {
  const { panel, archive, calls } = await open(page, fixture());
  const script = await savedAudio(page, panel);
  const before = await stored(page),
    originalAudio = await audioProjects(page);
  await script.getByLabel('第1行のセリフ', { exact: true }).fill('現在の未保存の編集');
  await inspect(page, await archiveFile());
  await archive.getByRole('button', { name: '確認した音声付き作品を復元', exact: true }).click();
  await expect(archive.getByRole('group', { name: 'アーカイブ復元前の未保存変更' })).toBeVisible();
  await page.evaluate((key) => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException('full', 'QuotaExceededError');
      original.call(this, name, value);
    };
  }, projectLibraryStorageKey);
  await archive
    .getByRole('button', { name: '保存して音声付き作品へ切り替える', exact: true })
    .click();
  await expect(archive.getByRole('alert')).toContainText('保存容量');
  expect(await stored(page)).toEqual(before);
  expect(await audioProjects(page)).toEqual(originalAudio);
  await expect(script.getByLabel('第1行のセリフ', { exact: true })).toHaveValue(
    '現在の未保存の編集',
  );
  expect(calls()).toBe(2);
});

test('aborts an IndexedDB update atomically and can retry the same archive', async ({ page }) => {
  const { panel, archive, calls } = await open(page, fixture());
  await savedAudio(page, panel);
  const before = await stored(page),
    originalAudio = await audioProjects(page);
  await inspect(page, await archiveFile());
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let writes = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'audio' && ++writes === 2)
        throw new DOMException('full', 'QuotaExceededError');
      return original.apply(this, args);
    };
    (window as unknown as { restorePut: () => void }).restorePut = () => {
      IDBObjectStore.prototype.put = original;
    };
  });
  await archive.getByRole('button', { name: '確認した音声付き作品を復元', exact: true }).click();
  await expect(archive.getByRole('alert')).toContainText('保存容量');
  expect(await stored(page)).toEqual(before);
  expect(await audioProjects(page)).toEqual(originalAudio);
  await page.evaluate(() => (window as unknown as { restorePut: () => void }).restorePut());
  await archive.getByRole('button', { name: '確認した音声付き作品を復元', exact: true }).click();
  await expect.poll(async () => (await stored(page)).length).toBe(2);
  await scriptPanel(page);
  await expect(
    page.getByRole('region', { name: '台本の試聴', exact: true }).locator(':scope > ol audio'),
  ).toHaveCount(2);
  expect(calls()).toBe(2);
});

for (const action of ['edit', 'cancel'] as const)
  test(`keeps the original project when ${action} happens during audio staging`, async ({
    page,
  }) => {
    const { panel, archive } = await open(page, fixture());
    const script = await savedAudio(page, panel);
    const before = await stored(page),
      originalAudio = await audioProjects(page);
    await inspect(page, await archiveFile());
    await expect(
      archive.getByRole('group', { name: '音声付き作品の復元確認', exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      const original = Blob.prototype.arrayBuffer;
      const state = window as unknown as {
        releaseArchive: (() => void) | null;
        restoreRead: () => void;
      };
      state.releaseArchive = null;
      Blob.prototype.arrayBuffer = async function () {
        if (this.size === 12)
          await new Promise<void>((resolve) => {
            state.releaseArchive = resolve;
          });
        return original.call(this);
      };
      state.restoreRead = () => {
        Blob.prototype.arrayBuffer = original;
        state.releaseArchive?.();
      };
    });
    await archive.getByRole('button', { name: '確認した音声付き作品を復元', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => typeof (window as unknown as { releaseArchive: unknown }).releaseArchive,
        ),
      )
      .toBe('function');
    if (action === 'edit')
      await script.getByLabel('第1行のセリフ', { exact: true }).fill('復元処理中の編集を保持');
    else await archive.getByRole('button', { name: 'アーカイブの処理を中止', exact: true }).click();
    await page.evaluate(() => (window as unknown as { restoreRead: () => void }).restoreRead());
    await expect(archive.getByRole('alert')).toContainText(
      action === 'edit' ? '編集が変わりました' : '中止',
    );
    expect(await stored(page)).toEqual(before);
    expect(await audioProjects(page)).toEqual(originalAudio);
    if (action === 'edit')
      await expect(script.getByLabel('第1行のセリフ', { exact: true })).toHaveValue(
        '復元処理中の編集を保持',
      );
  });

test('rejects corrupt audio and refuses restoration after another tab updates the project', async ({
  page,
}) => {
  const { panel, archive } = await open(page, fixture());
  await panel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  const before = await stored(page);
  const unsupported = await archiveFile();
  const headerLength = unsupported.readUInt32LE(8);
  const header = JSON.parse(unsupported.toString('utf8', 12, 12 + headerLength));
  header.version = 3;
  Buffer.from(JSON.stringify(header)).copy(unsupported, 12);
  await inspect(page, unsupported);
  await expect(archive.getByRole('alert')).toContainText('形式・版');
  expect(await stored(page)).toEqual(before);
  const corrupt = await archiveFile();
  corrupt[corrupt.length - 1] ^= 1;
  await inspect(page, corrupt);
  await expect(archive.getByRole('alert')).toContainText('破損');
  expect(await stored(page)).toEqual(before);
  await inspect(page, await archiveFile());
  const other = await page.context().newPage();
  const target = await open(other);
  await target.panel.getByLabel('保存する作品名').fill('別タブで更新された名前');
  await target.panel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  await archive.getByRole('button', { name: '確認した音声付き作品を復元', exact: true }).click();
  await expect(archive.getByRole('alert')).toContainText('別のタブで作品が変更');
  expect((await stored(page))[0].name).toBe('別タブで更新された名前');
  expect((await stored(page)).length).toBe(1);
  expect(await audioProjects(page)).toEqual([]);
});

test('saves current edits before switching and restores over twenty cached lines across saved scripts', async ({
  page,
}) => {
  const source = fixture();
  const { panel, archive, calls } = await open(page, source);
  const script = await savedAudio(page, panel);
  await script.getByLabel('第1行のセリフ', { exact: true }).fill('切り替える前の編集を保存');
  const incoming = fixture();
  incoming.name = '複数台本の作品';
  const savedScript = structuredClone(incoming.documents.script!);
  savedScript.title = '保存した20行';
  savedScript.lines = Array.from({ length: 20 }, () => ({
    ...structuredClone(savedScript.lines[0]),
    id: crypto.randomUUID(),
  }));
  incoming.documents.scriptLibrary.entries = [
    makeScriptLibraryEntry(savedScript, '物語', '長い場面'),
  ];
  await inspect(page, await archiveFile(incoming));
  await archive.getByRole('button', { name: '確認した音声付き作品を復元', exact: true }).click();
  await archive
    .getByRole('button', { name: '保存して音声付き作品へ切り替える', exact: true })
    .click();
  await expect.poll(async () => (await stored(page)).length).toBe(2);
  const projects = await stored(page);
  expect(
    projects.find((project) => project.id === source.id)!.documents.script!.lines[0].text,
  ).toBe('切り替える前の編集を保存');
  const target = projects.find((project) => project.id !== source.id)!;
  expect((await audioProjects(page)).filter((id) => id === target.id)).toHaveLength(22);
  const restoredScript = await scriptPanel(page);
  await expect(restoredScript.locator(':scope > ol audio')).toHaveCount(2);
  await restoredScript.getByText('作品・場面ごとの台本ライブラリ', { exact: true }).click();
  await restoredScript.getByRole('button', { name: 'この台本を開く', exact: true }).click();
  await expect(restoredScript.locator(':scope > ol audio')).toHaveCount(20);
  expect(calls()).toBe(2);
});

test('refuses a full project library before staging audio', async ({ page }) => {
  const projects = Array.from({ length: 20 }, () => ({ ...fixture(), id: crypto.randomUUID() }));
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: projectLibraryStorageKey,
    value: JSON.stringify({
      format: 'voice-atlas-project-library',
      version: 1,
      projects,
      activeId: projects[0].id,
    }),
  });
  const { panel, archive } = await open(page);
  await panel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  const before = await stored(page);
  await inspect(page, await archiveFile());
  await archive.getByRole('button', { name: '確認した音声付き作品を復元', exact: true }).click();
  await expect(archive.getByRole('alert')).toContainText('20作品まで');
  expect(await stored(page)).toEqual(before);
});

test('exports current settings without copying preview audio that was never saved', async ({
  page,
}) => {
  const { panel, archive, calls } = await open(page, fixture());
  const script = await scriptPanel(page);
  await panel.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  await script.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(script.locator(':scope > ol audio')).toHaveCount(2);
  await script.getByLabel('台本名', { exact: true }).fill('まだ保存していない台本名');
  const result = await parseProjectArchive(new Blob([await exportArchive(page)]));
  expect(result.audio).toHaveLength(0);
  expect(result.project.documents.script!.title).toBe('まだ保存していない台本名');
  await expect(archive.getByRole('status')).toContainText('保存音声0行');
  await expect(script.locator(':scope > ol audio')).toHaveCount(2);
  expect(calls()).toBe(2);
});
