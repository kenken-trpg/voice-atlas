import { describe, expect, it } from 'vitest';
import { scriptFixture } from './fixtures/script';
import {
  emptyScript,
  makeScriptLine,
  parseScript,
  serializeScript,
  scriptAudioKey,
  scriptCandidate,
  maxScriptBytes,
} from '../shared/script';
import { castingCandidateSchema } from '../shared/casting';

describe('voice scripts', () => {
  it('copies assignments and roundtrips native parameters and line order independently of the board', () => {
    const { assignments, script } = scriptFixture();
    assignments[0].character = '変更';
    assignments[0].comparison.entries[0].evaluation.candidates[0].recipe.speedScale = 0.5;
    const restored = parseScript(serializeScript(script));
    expect(restored).toEqual(script);
    expect(restored.lines[0].assignment!.character).toBe('案内人');
    expect(scriptCandidate(restored.lines[0])!.recipe.speedScale).toBe(1);
    expect(scriptCandidate(restored.lines[1])!.voice.engine).toBe('VOICEVOX');
    expect(scriptCandidate(restored.lines[1])!.recipe.speedScale).toBe(0.85);
    expect(restored.lines.map((line) => line.text)).toEqual(['ようこそ。', '案内を頼もう。']);
    expect(serializeScript(script)).not.toContain('blob:');
  });
  it('uses stable line IDs for audio while text, voice and native parameter changes invalidate audio', () => {
    const { script } = scriptFixture();
    const line = script.lines[0],
      original = scriptAudioKey(line);
    expect(scriptAudioKey([...script.lines].reverse()[1])).toBe(original);
    expect(scriptAudioKey({ ...line, character: '別の発話者' })).toBe(original);
    expect(scriptAudioKey({ ...line, character: undefined })).toBe(original);
    expect(scriptAudioKey({ ...line, text: '別のセリフ' })).not.toBe(original);
    expect(scriptAudioKey({ ...line, id: crypto.randomUUID() })).not.toBe(original);
    expect(scriptAudioKey({ ...line, assignment: script.lines[1].assignment })).not.toBe(original);
    const changed = structuredClone(line);
    changed.assignment!.comparison.entries[0].evaluation.candidates[0].recipe.speedScale = 0.7;
    expect(scriptAudioKey(changed)).not.toBe(original);
  });
  it('supports incomplete drafts but rejects malformed assignments, duplicate lines and unsupported versions', () => {
    const script = { ...emptyScript(), lines: [makeScriptLine()] };
    expect(parseScript(serializeScript(script)).lines[0].assignment).toBeNull();
    expect(scriptCandidate(script.lines[0])).toBeNull();
    expect(() =>
      serializeScript({ ...script, lines: [script.lines[0], script.lines[0]] }),
    ).toThrow();
    expect(() => parseScript(JSON.stringify({ ...script, version: 2 }))).toThrow();
    const raw = scriptFixture().script;
    raw.lines[0].assignment!.comparison.selectedId = crypto.randomUUID();
    expect(() => serializeScript(raw)).toThrow();
  });
  it('enforces 20 lines, 300 characters per line, title and UTF-8 byte limits', () => {
    const script = { ...emptyScript(), lines: Array.from({ length: 20 }, () => makeScriptLine()) };
    expect(parseScript(serializeScript(script)).lines).toHaveLength(20);
    expect(() =>
      serializeScript({ ...script, lines: [...script.lines, makeScriptLine()] }),
    ).toThrow();
    expect(() =>
      serializeScript({ ...script, lines: [{ ...script.lines[0], text: 'あ'.repeat(301) }] }),
    ).toThrow();
    expect(() => serializeScript({ ...script, title: 'あ'.repeat(101) })).toThrow();
    expect(() => parseScript('あ'.repeat(Math.ceil(maxScriptBytes / 3) + 1))).toThrow();
  });
  it('retains retired voices as historical scripts while refusing operational generation', () => {
    const { script } = scriptFixture();
    const entry = script.lines[1].assignment!.comparison.entries[1];
    const candidate = entry.evaluation.candidates[1];
    if (candidate.voice.engine !== 'VOICEVOX') throw new Error('fixture');
    candidate.voice.voiceId = 'removed-voice';
    const loaded = parseScript(serializeScript(script));
    expect(castingCandidateSchema.safeParse(scriptCandidate(loaded.lines[1])).success).toBe(false);
  });
});
