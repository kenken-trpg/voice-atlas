import { describe, it, expect } from 'vitest';
import { makeCastingEvaluation } from './fixtures/casting';
import {
  libraryCandidate,
  loadLibraryCandidate,
  makeLibraryEntry,
  parseLibrary,
  serializeLibrary,
  makeVoiceVariation,
  libraryText,
  libraryGeneration,
} from '../shared/voice-library';
import { castingKey } from '../shared/casting';
import { evaluationWithModelInfo } from './fixtures/aivis-model-info';

describe('character voice library', () => {
  it('derives VOICEVOX settings using its own native recipe and generation information', () => {
    const parent = makeLibraryEntry(makeCastingEvaluation({ outcome: 'b' }), '騎士', '通常', '');
    const candidate = structuredClone(libraryCandidate(parent));
    candidate.recipe.speedScale = 0.65;
    const generation = {
      engine: 'VOICEVOX' as const,
      engineVersion: 'test-vv',
      checkedAt: parent.createdAt,
    };
    const variant = makeVoiceVariation(
      parent,
      {
        candidate,
        text: 'ゆっくり伝える。',
        generation,
        profile: parent.evaluation.profile,
        characterInput: null,
        reason: '説明用に話速を下げた',
      },
      '説明',
      '',
    );
    const restored = parseLibrary(serializeLibrary([variant]))[0];
    expect(libraryCandidate(restored).recipe).toMatchObject({
      engine: 'VOICEVOX',
      speedScale: 0.65,
    });
    expect(libraryCandidate(restored).recipe).not.toHaveProperty('tempoDynamicsScale');
    expect(libraryGeneration(restored)).toEqual(generation);
    expect(libraryCandidate(parent).recipe.speedScale).toBe(0.85);
  });
  it('reads v1 and writes v2, retaining derived settings without fabricating another adoption', () => {
    const parent = makeLibraryEntry(evaluationWithModelInfo(), '案内人', '通常', '');
    const legacy = JSON.stringify({
      format: 'voice-atlas-voice-library',
      version: 1,
      entries: [parent],
    });
    expect(parseLibrary(legacy)).toEqual([parent]);
    const candidate = structuredClone(libraryCandidate(parent));
    candidate.recipe.speedScale = 0.7;
    const variation = makeVoiceVariation(
      parent,
      {
        candidate,
        text: '長い説明です。',
        generation: null,
        profile: parent.evaluation.profile,
        characterInput: parent.evaluation.characterInput,
        reason: '長文用に遅く',
      },
      '長文説明用',
      'メモ',
    );
    expect(variation.id).not.toBe(parent.id);
    expect(variation.evaluation).toEqual(parent.evaluation);
    expect(libraryCandidate(variation).recipe.speedScale).toBe(0.7);
    expect(libraryText(variation)).toBe('長い説明です。');
    expect(libraryGeneration(variation)).toBeNull();
    expect(variation.variation?.parent.candidate).toEqual(libraryCandidate(parent));
    expect(libraryCandidate(parent).recipe.speedScale).toBe(1);
    const encoded = serializeLibrary([parent, variation]);
    expect(JSON.parse(encoded).version).toBe(2);
    expect(parseLibrary(encoded)).toEqual([parent, variation]);
    const loaded = loadLibraryCandidate({}, null, variation, 0);
    expect(loaded.candidates[loaded.key].recipe.speedScale).toBe(0.7);
    expect(loaded.text).toBe('長い説明です。');
    expect(libraryCandidate(variation).modelInfo?.modelVersion).toBe('1.2.3');
  });
  it('preserves immediate parent snapshots through repeated derivation and independent deletion', () => {
    const parent = makeLibraryEntry(makeCastingEvaluation(), '案内人', '通常', '');
    const snapshot = {
      candidate: libraryCandidate(parent),
      text: '派生のセリフ',
      generation: null,
      profile: parent.evaluation.profile,
      characterInput: null,
      reason: '用途の変更',
    };
    const first = makeVoiceVariation(parent, snapshot, '説明', '');
    if (snapshot.candidate.recipe.engine === 'ElevenLabs') throw new Error('Expected local recipe');
    const second = makeVoiceVariation(
      first,
      {
        ...snapshot,
        candidate: {
          ...snapshot.candidate,
          recipe: { ...snapshot.candidate.recipe, speedScale: 0.6 },
        },
      },
      '長文',
      '',
    );
    expect(second.variation?.parent.id).toBe(first.id);
    expect(parseLibrary(serializeLibrary([second]))[0]).toEqual(second);
    first.settingName = '後から編集';
    first.evaluation.reason = '変更';
    expect(second.variation?.parent.settingName).toBe('説明');
    expect(second.evaluation.reason).toBe(parent.evaluation.reason);
  });
  it('rejects invalid variation provenance, engines, links and v1 files containing v2 data', () => {
    const parent = makeLibraryEntry(evaluationWithModelInfo(), '案内人', '通常', '');
    const variation = makeVoiceVariation(
      parent,
      {
        candidate: libraryCandidate(parent),
        text: 'セリフ',
        generation: null,
        profile: parent.evaluation.profile,
        characterInput: null,
        reason: '変更理由',
      },
      '説明',
      '',
    );
    const self = structuredClone(variation);
    self.id = parent.id;
    expect(() => serializeLibrary([self])).toThrow();
    const wrong = structuredClone(variation);
    wrong.variation!.candidate = parent.evaluation.candidates[1];
    expect(() => serializeLibrary([wrong])).toThrow();
    const gen = structuredClone(variation);
    gen.variation!.generation = {
      engine: 'VOICEVOX',
      engineVersion: null,
      checkedAt: parent.createdAt,
    };
    expect(() => serializeLibrary([gen])).toThrow();
    const link = structuredClone(variation);
    link.variation!.candidate.modelInfo!.links = ['javascript:alert(1)'];
    expect(() => serializeLibrary([link])).toThrow();
    expect(() =>
      parseLibrary(
        JSON.stringify({ format: 'voice-atlas-voice-library', version: 1, entries: [variation] }),
      ),
    ).toThrow();
  });
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
    if (a.recipe.engine === 'ElevenLabs') throw new Error('Expected local recipe');
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
