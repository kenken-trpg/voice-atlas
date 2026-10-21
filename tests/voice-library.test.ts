import { describe, it, expect } from 'vitest';
import { makeCastingEvaluation } from './fixtures/casting';
import {
  libraryCandidate,
  loadLibraryCandidate,
  makeLibraryEntry,
  parseLibrary,
  serializeLibrary,
} from '../shared/voice-library';
import { castingKey } from '../shared/casting';
import { evaluationWithModelInfo } from './fixtures/aivis-model-info';

describe('character voice library', () => {
  it('roundtrips adopted native values and original evidence without sharing mutable objects', () => {
    const source = evaluationWithModelInfo();
    const entry = makeLibraryEntry(source, ' 案内人 ', ' 通常 ', 'メモ');
    expect(entry.characterName).toBe('案内人');
    expect(libraryCandidate(entry).recipe).toMatchObject({ tempoDynamicsScale: 0.72 });
    source.reason = '変更';
    expect(entry.evaluation.reason).not.toBe('変更');
    expect(parseLibrary(serializeLibrary([entry]))).toEqual([entry]);
    expect(libraryCandidate(entry).modelInfo?.modelVersion).toBe('1.2.3');
    expect(() => parseLibrary(' '.repeat(4 * 1024 * 1024 + 1))).toThrow('4MiB');
  });
  it('rejects nonadoptions, duplicate IDs, over-capacity and invalid native values', () => {
    expect(() =>
      makeLibraryEntry(makeCastingEvaluation({ outcome: 'tie' }), '名', '通常', ''),
    ).toThrow();
    const entry = makeLibraryEntry(makeCastingEvaluation(), '名', '通常', '');
    expect(() => serializeLibrary([entry, entry])).toThrow();
    expect(() =>
      serializeLibrary(Array.from({ length: 101 }, () => ({ ...entry, id: crypto.randomUUID() }))),
    ).toThrow();
    const invalid = structuredClone(entry);
    invalid.evaluation.candidates[0].recipe.speedScale = 100;
    expect(() => serializeLibrary([invalid])).toThrow();
  });
  it('replaces only the requested configuration and retains the source evaluation', () => {
    const entry = makeLibraryEntry(makeCastingEvaluation(), '名', '通常', '');
    const [a, b] = entry.evaluation.candidates;
    const original = {
      [castingKey(a.voice)]: { ...a, recipe: { ...a.recipe, speedScale: 1.5 } },
      [castingKey(b.voice)]: b,
    };
    const next = loadLibraryCandidate(
      original,
      [castingKey(a.voice), castingKey(b.voice)],
      entry,
      0,
    );
    expect(next.candidates[castingKey(a.voice)].recipe.speedScale).toBe(a.recipe.speedScale);
    expect(original[castingKey(a.voice)].recipe.speedScale).toBe(1.5);
    expect(next.candidates[castingKey(b.voice)]).toEqual(b);
    expect(next.context.profile.pitch).toBe(17);
    expect(() =>
      loadLibraryCandidate(original, [castingKey(a.voice), castingKey(b.voice)], entry, 1),
    ).toThrow();
  });
  it('keeps unavailable historical voices in storage but rejects obsolete VOICEVOX identities on use', () => {
    const source = makeCastingEvaluation({ outcome: 'b' });
    const voice = source.candidates[1].voice;
    if (voice.engine === 'VOICEVOX') voice.voiceId = 'removed-voice';
    const entry = makeLibraryEntry(source, '名', '通常', '');
    expect(parseLibrary(serializeLibrary([entry]))).toHaveLength(1);
    expect(() => loadLibraryCandidate({}, null, entry, 0)).toThrow();
    const aivis = makeLibraryEntry(makeCastingEvaluation(), '名', '通常', '');
    expect(loadLibraryCandidate({}, null, aivis, 0).pair).toBeNull();
  });
});
