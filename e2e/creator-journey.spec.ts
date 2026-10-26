import { test, expect, type Page, type Download } from '@playwright/test';
import { voices } from '../shared/catalog';
import { makeRecipe } from '../shared/recommend';
import { neutralProfile } from '../shared/schema';
import { makeCastingEvaluation } from '../tests/fixtures/casting';
import { makeLibraryEntry, libraryCandidate } from '../shared/voice-library';
import {
  makeLibraryComparisonRecord,
  serializeLibraryComparison,
} from '../shared/library-comparison';
import { parseProjectArchive } from '../shared/project-archive';
import { pcmWav } from '../tests/fixtures/wav';

const work = '星読みの塔';
const people = ['案内人', '騎士', '店主'];
const initial = makeCastingEvaluation();
const entries = [
  makeLibraryEntry(initial, people[0], '通常', ''),
  makeLibraryEntry(makeCastingEvaluation({ outcome: 'b' }), people[1], '通常', ''),
  makeLibraryEntry(
    makeCastingEvaluation({
      outcome: 'b',
      candidates: [
        initial.candidates[0],
        {
          voice: {
            engine: 'VOICEVOX',
            voiceId: voices[1].id,
            name: voices[1].name,
            style: voices[1].style,
          },
          recipe: { ...makeRecipe(neutralProfile, voices[1]), engine: 'VOICEVOX' },
        },
      ],
    }),
    people[2],
    '通常',
    '',
  ),
];
const records = entries.map((entry, index) =>
  makeLibraryComparisonRecord({
    entries: [entry, entries[(index + 1) % entries.length]],
    text: '声選びの共通文',
    scene: '導入',
    reason: `${people[index]}の役柄に合わせて選択`,
    selectedId: entry.id,
    auditions: [{ generation: null }, { generation: null }],
  }),
);
const comparisonFile = {
  name: 'casting-decisions.json',
  mimeType: 'application/json',
  buffer: Buffer.from(
    serializeLibraryComparison({
      format: 'voice-atlas-library-comparison',
      version: 1,
      createdAt: initial.recordedAt,
      entries: null,
      text: '',
      scene: '',
      reason: '',
      selectedId: null,
      records,
    }),
  ),
};

async function mockEngines(page: Page, ready: boolean) {
  let generations = 0;
  await page.route('**/api/casting/voices', (route) =>
    route.fulfill({
      json: {
        checkedAt: initial.recordedAt,
        engines: ['VOICEVOX', 'AivisSpeech'].map((engine) => ({
          engine,
          ready,
          detail: ready ? '接続済み' : '未接続',
        })),
        voices: ready ? entries.map((entry) => libraryCandidate(entry).voice) : [],
      },
    }),
  );
  await page.route('**/api/casting/aivis-models', (route) =>
    route.fulfill({ json: { ready: false, checkedAt: initial.recordedAt, models: [] } }),
  );
  await page.route('**/api/casting/preview', (route) => {
    generations++;
    return route.fulfill({
      contentType: 'audio/wav',
      body: Buffer.from(pcmWav(Array(2400).fill(generations * 100))),
    });
  });
  return () => generations;
}

async function scriptPanel(page: Page) {
  await page.getByRole('button', { name: '台本へ進む', exact: true }).click();
  return page.getByRole('region', { name: '台本の試聴', exact: true });
}

async function bytes(download: Download) {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('takes three NPCs and ten lines through casting, audio archive and editing in a new browser', async ({
  page,
  browser,
}, testInfo) => {
  const generated = await mockEngines(page, true);
  await page.goto('/');
  await page
    .getByRole('button', { name: 'VOICEVOX・AivisSpeech・ElevenLabsを比較する', exact: true })
    .click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByLabel('設定比較JSONファイル').setInputFiles(comparisonFile);
  const board = page.getByRole('region', { name: 'キャスティング表', exact: true });
  for (let index = 0; index < records.length; index++) {
    await board.getByLabel('キャスティングの比較記録').selectOption(records[index].id);
    await board.getByLabel('キャスティングの作品名').fill(work);
    await board.getByRole('button', { name: 'キャスティングを確定して保存', exact: true }).click();
    await expect(
      board.getByText(`${work} / ${people[index]} / 導入`, { exact: true }),
    ).toBeVisible();
  }
  const script = page.getByRole('region', { name: '台本の試聴', exact: true });
  await page.getByRole('button', { name: '台本へ進む', exact: true }).click();
  await script.getByLabel('台本名').fill('導入の会話');
  for (let index = 0; index < 10; index++) {
    await script.getByRole('button', { name: '台本に行を追加', exact: true }).click();
    await script
      .getByLabel(`第${index + 1}行の声`, { exact: true })
      .selectOption({ label: `${work} / ${people[index % people.length]} / 導入` });
    await script
      .getByLabel(`第${index + 1}行のセリフ`, { exact: true })
      .fill(`第${index + 1}行のセリフです。`);
  }
  const project = page.getByRole('region', { name: '作品の保存と復元', exact: true });
  await page.getByRole('button', { name: '保存・再開へ進む', exact: true }).click();
  await project.getByLabel('保存する作品名').fill(work);
  await project.getByRole('button', { name: '作品をブラウザに保存', exact: true }).click();
  await expect(project.getByText('作品はブラウザに保存済みです', { exact: true })).toBeVisible();
  await script.getByRole('button', { name: '未生成の行を台本順に生成', exact: true }).click();
  await expect(script.locator(':scope > ol audio')).toHaveCount(10);
  expect(generated()).toBe(10);
  await script.getByText('台本音声の保存と再利用', { exact: true }).click();
  await script.getByRole('button', { name: '台本音声をブラウザに保存', exact: true }).click();
  await expect(script).toContainText('10行の音声をこのブラウザに保存しました');
  const downloadEvent = page.waitForEvent('download');
  await project.getByRole('button', { name: '音声付き作品アーカイブを書き出す' }).click();
  const archive = await bytes(await downloadEvent);
  const decoded = await parseProjectArchive(new Blob([archive]));
  expect(decoded.project.documents.castingBoard.assignments).toHaveLength(3);
  expect(
    decoded.project.documents.castingBoard.assignments.map((assignment) => [
      assignment.project,
      assignment.character,
      assignment.comparison.reason,
    ]),
  ).toEqual(people.map((person) => [work, person, `${person}の役柄に合わせて選択`]));
  expect(decoded.project.documents.script?.lines).toHaveLength(10);
  expect(decoded.project.documents.script?.lines.map((line) => line.assignment?.character)).toEqual(
    Array.from({ length: 10 }, (_, index) => people[index % people.length]),
  );
  expect(decoded.audio).toHaveLength(10);
  await project.screenshot({ path: testInfo.outputPath('creator-journey-source.png') });

  const context = await browser.newContext({
    viewport: testInfo.project.use.viewport,
    isMobile: testInfo.project.use.isMobile,
    hasTouch: testInfo.project.use.hasTouch,
  });
  try {
    const other = await context.newPage();
    const restoredGenerations = await mockEngines(other, false);
    await other.goto('/');
    await other.getByText('作品を保存・復元する', { exact: true }).click();
    const restoredProject = other.getByRole('region', { name: '作品の保存と復元', exact: true });
    await restoredProject.getByLabel('作品アーカイブファイル').setInputFiles({
      name: 'star-tower.vaarchive',
      mimeType: 'application/octet-stream',
      buffer: archive,
    });
    const confirmation = restoredProject.getByRole('group', { name: '音声付き作品の復元確認' });
    await expect(confirmation).toContainText('保存音声10行');
    await restoredProject.getByRole('button', { name: '確認した音声付き作品を復元' }).click();
    await expect(other.locator('.project-panel > summary')).toContainText(`現在の作品：${work}`);
    await other.getByText('作品を保存・復元する', { exact: true }).click();
    await expect(restoredProject.getByLabel('保存する作品名')).toHaveValue(work);
    const restoredScript = await scriptPanel(other);
    await expect(restoredScript.locator(':scope > ol audio')).toHaveCount(10);
    await restoredScript.getByLabel('第1行のセリフ').fill('別のブラウザで編集しました。');
    await expect(restoredScript.locator(':scope > ol audio')).toHaveCount(9);
    await restoredProject
      .getByRole('button', { name: '作品をブラウザに保存', exact: true })
      .click();
    await other.reload();
    const reopened = await scriptPanel(other);
    await expect(reopened.getByLabel('第1行のセリフ')).toHaveValue('別のブラウザで編集しました。');
    await expect(reopened.locator(':scope > ol audio')).toHaveCount(9);
    expect(restoredGenerations()).toBe(0);
    await other.getByText('作品を保存・復元する', { exact: true }).click();
    await restoredProject.screenshot({ path: testInfo.outputPath('creator-journey-restored.png') });
  } finally {
    await context.close();
  }
});
