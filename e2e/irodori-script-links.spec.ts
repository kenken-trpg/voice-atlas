import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeEmptyProject, projectStorageKey, serializeProject } from '../shared/project';
import { scriptFixture } from '../tests/fixtures/script';

const sample = resolve(
  '.local-artifacts/irodori-v41-voice-design-20261024/sample_20261024_074100_778062_001.wav',
);

test('shows matching provisional voices on script rows and saves explicit speaker links', async ({
  page,
}) => {
  test.skip(!existsSync(sample));
  const project = makeEmptyProject('Irodori台本');
  project.documents.irodoriCandidates = ['old_mage', 'executive'];
  project.documents.irodoriAssignments = [
    { character: '長老', voiceId: 'old_mage', reason: '落ち着いた声' },
  ];
  const script = scriptFixture().script;
  script.lines[0].character = '長老';
  script.lines[1].character = 'ナレーター';
  project.documents.script = script;
  await page.addInitScript(
    ({ key, value }) => {
      if (!localStorage.getItem('voice-atlas-project-library-v1') && !localStorage.getItem(key))
        localStorage.setItem(key, value);
    },
    { key: projectStorageKey, value: serializeProject(project) },
  );
  await page.goto('/');
  const voices = page.getByRole('region', { name: 'Irodori生成済みの声を比較' });
  await voices.getByRole('button', { name: 'この端末の検証音声を読み込む' }).click();
  await page.getByRole('button', { name: 'VOICEVOX・AivisSpeechを比較する', exact: true }).click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  const panel = page.getByRole('region', { name: '台本の試聴', exact: true });
  const first = panel.getByRole('listitem', { name: '台本の第1行' });
  const second = panel.getByRole('listitem', { name: '台本の第2行' });
  await expect(first).toContainText('Irodori仮配役：長老 → 老魔術師');
  await expect(first.locator('audio[aria-label="第1行のIrodori仮配役音声"]')).toBeVisible();
  await expect(second).not.toContainText('Irodori仮配役：');
  const links = panel.getByRole('region', { name: '台本発話者とIrodori仮配役' });
  await links.getByRole('combobox', { name: 'ナレーターのIrodori仮配役' }).selectOption('長老');
  await expect(second).toContainText('Irodori仮配役：長老 → 老魔術師');
  await expect(second.locator('audio[aria-label="第2行のIrodori仮配役音声"]')).toBeVisible();
  await voices.getByRole('button', { name: '編集', exact: true }).click();
  await voices.getByRole('combobox', { name: '仮配役の候補声' }).selectOption('executive');
  await voices.getByRole('button', { name: '仮配役を更新' }).click();
  await expect(first).toContainText('Irodori仮配役：長老 → 企業幹部');
  await page.getByText('作品を保存・復元する', { exact: true }).click();
  await page.getByRole('button', { name: '作品をブラウザに保存' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'VOICEVOX・AivisSpeechを比較する', exact: true }).click();
  await page.getByText('キャラクターの採用声ライブラリ', { exact: true }).click();
  await page.getByText('台本を作成・試聴する', { exact: true }).click();
  await expect(first).toContainText('Irodori仮配役：長老 → 企業幹部');
  await expect(second).toContainText('Irodori仮配役：長老 → 企業幹部');
  await expect(links.getByRole('combobox', { name: 'ナレーターのIrodori仮配役' })).toHaveValue(
    '長老',
  );
});
