import { makeCastingEvaluation } from './casting';
import { makeLibraryEntry } from '../../shared/voice-library';
import { makeLibraryComparisonRecord } from '../../shared/library-comparison';
import { makeCastingAssignment } from '../../shared/casting-board';
import { emptyScript, makeScriptLine } from '../../shared/script';

export function scriptFixture() {
  const first = makeLibraryEntry(makeCastingEvaluation(), '案内人', '通常', '');
  const second = makeLibraryEntry(makeCastingEvaluation({ outcome: 'b' }), '騎士', '通常', '');
  const record = makeLibraryComparisonRecord({
    entries: [first, second],
    text: '比較文',
    scene: '導入',
    reason: '聞き取りやすい',
    selectedId: first.id,
    auditions: [{ generation: null }, { generation: null }],
  });
  const assignments = [
    makeCastingAssignment(record, '物語', '案内人', '導入'),
    makeCastingAssignment({ ...record, selectedId: second.id }, '物語', '騎士', '導入'),
  ];
  return {
    assignments,
    script: {
      ...emptyScript(),
      title: '導入の会話',
      lines: assignments.map((item, index) => ({
        ...makeScriptLine(item),
        text: index === 0 ? 'ようこそ。' : '案内を頼もう。',
      })),
    },
  };
}
