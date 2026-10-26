import { makeCastingEvaluation } from './casting';
import { makeLibraryEntry } from '../../shared/voice-library';
import { makeLibraryComparisonRecord } from '../../shared/library-comparison';
import { makeCastingAssignment } from '../../shared/casting-board';
import { emptyScript, makeScriptLine } from '../../shared/script';
import { elevenLabsRecipeSchema } from '../../shared/elevenlabs';

export function elevenLabsScriptFixture() {
  const old = makeCastingEvaluation();
  const cloud = {
    voice: {
      engine: 'ElevenLabs' as const,
      voiceId: 'saved_cloud_voice',
      name: '案内の声',
      style: 'default',
    },
    recipe: elevenLabsRecipeSchema.parse({
      engine: 'ElevenLabs',
      modelId: 'saved-japanese',
      stability: 0.8,
      similarityBoost: 0.6,
      style: 0.2,
      useSpeakerBoost: true,
      seed: 42,
    }),
  };
  const evaluation = makeCastingEvaluation({
    ...old,
    candidates: [cloud, old.candidates[1]],
    generations: [null, old.generations[1]],
  });
  const entries = [
    makeLibraryEntry(evaluation, '案内人', '通常', ''),
    makeLibraryEntry({ ...evaluation, outcome: 'b' }, '騎士', '通常', ''),
  ] as const;
  const record = makeLibraryComparisonRecord({
    entries: [...entries],
    text: '比較した台詞',
    scene: '導入',
    reason: '案内役に合う',
    selectedId: entries[0].id,
    auditions: [{ generation: null }, { generation: null }],
  });
  const assignments = [
    makeCastingAssignment(record, '物語', '案内人', '導入'),
    makeCastingAssignment({ ...record, selectedId: entries[1].id }, '物語', '騎士', '導入'),
  ];
  const script = {
    ...emptyScript(),
    title: 'クラウドとローカルの会話',
    lines: [
      {
        ...makeScriptLine(assignments[0]),
        text: '星詠みの塔へ。',
        spokenText: 'ほしよみのとうへ。',
        readingSource: 'manual' as const,
      },
      { ...makeScriptLine(assignments[1]), text: '案内を頼もう。' },
      { ...makeScriptLine(assignments[0]), text: 'こちらです。' },
    ],
  };
  return { cloud, entries, record, assignments, script };
}
