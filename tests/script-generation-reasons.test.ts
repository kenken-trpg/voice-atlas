import { describe, expect, it } from 'vitest';
import { scriptGenerationReasons } from '../shared/script-generation-reasons';
import { scriptAudioKey } from '../shared/script';
import { scriptFixture } from './fixtures/script';
import { elevenLabsScriptFixture } from './fixtures/elevenlabs-script';

describe('script generation reasons', () => {
  it('distinguishes a new line from conditions changed since the last audio', () => {
    const { script } = scriptFixture();
    const line = script.lines[0];
    const key = scriptAudioKey(line);
    expect(scriptGenerationReasons(line)).toEqual(['未生成']);
    expect(scriptGenerationReasons({ ...line, text: '変更した台詞' }, key)).toEqual([
      '読み上げ文変更',
    ]);
    const changed = structuredClone(line);
    changed.assignment!.comparison.entries[0].evaluation.candidates[0].recipe.speedScale = 0.7;
    expect(scriptGenerationReasons(changed, key)).toEqual(['調声変更']);
    changed.assignment!.comparison.entries[0].evaluation.candidates[0].voice.name = '別の声';
    changed.text = '変更';
    expect(scriptGenerationReasons(changed, key)).toEqual(['読み上げ文変更', '声変更', '調声変更']);
  });
  it('compares spoken text rather than display text, character names, positions or reading source', () => {
    const line = {
      ...scriptFixture().script.lines[0],
      spokenText: 'よみ',
      readingSource: 'manual' as const,
    };
    const changed = {
      ...line,
      character: '新しい名前',
      text: '表示用の変更',
      readingSource: 'dictionary' as const,
    };
    expect(scriptGenerationReasons(changed, scriptAudioKey(line))).toEqual([
      '音声なし（生成時の条件に戻っています）',
    ]);
  });
  it('includes cloud model and native setting changes and drops resolved differences', () => {
    const line = elevenLabsScriptFixture().script.lines[0];
    const changed = structuredClone(line);
    const candidate = changed.assignment!.comparison.entries[0].evaluation.candidates[0];
    if (candidate.recipe.engine !== 'ElevenLabs') throw new Error('cloud fixture required');
    candidate.recipe.modelId = 'another-model';
    candidate.recipe.stability = 0.3;
    expect(scriptGenerationReasons(changed, scriptAudioKey(line))).toEqual(['調声変更']);
    expect(scriptGenerationReasons(changed, scriptAudioKey(changed))).toEqual([
      '音声なし（生成時の条件に戻っています）',
    ]);
  });
});
