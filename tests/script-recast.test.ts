import { describe, expect, it } from 'vitest';
import { scriptFixture } from './fixtures/script';
import {
  makeScriptLine,
  scriptAudioKey,
  scriptCandidate,
  type VoiceScript,
} from '../shared/script';
import {
  scriptCharacter,
  scriptSettingKey,
  recastGroups,
  planScriptRecast,
} from '../shared/script-recast';
import { castingCandidateSchema } from '../shared/casting';
function fixture() {
  const base = scriptFixture();
  const variant = structuredClone(base.assignments[0]);
  variant.id = crypto.randomUUID();
  variant.scene = 'ゆっくり';
  variant.comparison.entries[0].evaluation.candidates[0].recipe.speedScale = 0.7;
  const script: VoiceScript = {
    ...base.script,
    gapMs: 700,
    lines: [
      base.script.lines[0],
      { ...makeScriptLine(variant), character: '案内人', text: '別の設定の案内' },
      base.script.lines[1],
      { ...makeScriptLine(), character: '案内人', text: '未割り当て' },
      { ...makeScriptLine(base.assignments[0]), character: 'ナレーター', text: '別の発話者' },
    ],
  };
  return { ...base, script, variant };
}
describe('script voice recasting', () => {
  it('groups by explicit speaker name or legacy casting name and distinguishes saved recipe versions', () => {
    const { script } = fixture();
    expect(script.lines.map(scriptCharacter)).toEqual([
      '案内人',
      '案内人',
      '騎士',
      '案内人',
      'ナレーター',
    ]);
    expect(recastGroups(script, '案内人').map((group) => group.count)).toEqual([1, 1, 1]);
    const changedVersion = structuredClone(script.lines[0]);
    changedVersion.assignment!.comparison.entries[0].evaluation.candidates[0].recipe.speedScale = 0.9;
    expect(scriptSettingKey(changedVersion)).not.toBe(scriptSettingKey(script.lines[0]));
    expect(scriptCharacter(makeScriptLine())).toBeNull();
  });
  it('replaces all rows of the selected actor, preserves text/order/IDs/gap and freezes the original actor name', () => {
    const { script, assignments } = fixture();
    const plan = planScriptRecast(script, '案内人', 'all', assignments[1]);
    expect(plan.targetedIds).toEqual([script.lines[0].id, script.lines[1].id, script.lines[3].id]);
    expect(plan.changedIds).toEqual(plan.targetedIds);
    expect(plan.audioChangedIds).toEqual(plan.targetedIds);
    expect(plan.script.lines.map(scriptCharacter)).toEqual(script.lines.map(scriptCharacter));
    expect(plan.script.lines.map((line) => [line.id, line.text])).toEqual(
      script.lines.map((line) => [line.id, line.text]),
    );
    expect(plan.script.gapMs).toBe(700);
    expect(plan.script.lines[0].character).toBe('案内人');
    expect(scriptCandidate(plan.script.lines[0])!.voice.engine).toBe('VOICEVOX');
    expect(scriptCandidate(plan.script.lines[0])!.recipe.speedScale).toBe(0.85);
    expect(plan.script.lines[2]).toEqual(script.lines[2]);
    expect(plan.script.lines[4]).toEqual(script.lines[4]);
    expect(scriptCandidate(script.lines[0])!.voice.engine).toBe('AivisSpeech');
  });
  it('replaces only the selected source recipe group including unassigned speaker rows', () => {
    const { script, assignments } = fixture();
    const plan = planScriptRecast(
      script,
      '案内人',
      scriptSettingKey(script.lines[1]),
      assignments[1],
    );
    expect(plan.changedIds).toEqual([script.lines[1].id]);
    expect(scriptAudioKey(plan.script.lines[0])).toBe(scriptAudioKey(script.lines[0]));
    expect(scriptAudioKey(plan.script.lines[4])).toBe(scriptAudioKey(script.lines[4]));
    expect(planScriptRecast(script, '案内人', 'unassigned', assignments[0]).changedIds).toEqual([
      script.lines[3].id,
    ]);
  });
  it('preserves audio for metadata-only reassignment and ignores fully identical assignments', () => {
    const { script, assignments } = fixture();
    const sameVoice = {
      ...assignments[0],
      id: crypto.randomUUID(),
      scene: '別の保存設定',
      character: '別の登録名',
    };
    const plan = planScriptRecast(script, '案内人', scriptSettingKey(script.lines[0]), sameVoice);
    expect(plan.changedIds).toEqual([script.lines[0].id]);
    expect(plan.audioChangedIds).toEqual([]);
    expect(scriptCharacter(plan.script.lines[0])).toBe('案内人');
    expect(scriptAudioKey(plan.script.lines[0])).toBe(scriptAudioKey(script.lines[0]));
    expect(
      planScriptRecast(script, '案内人', scriptSettingKey(script.lines[0]), assignments[0])
        .changedIds,
    ).toEqual([]);
  });
  it('makes independent copies per row and leaves source assignments and scripts unchanged', () => {
    const { script, assignments } = fixture();
    const plan = planScriptRecast(script, '案内人', 'all', assignments[1]);
    plan.script.lines[0].assignment!.character = '編集';
    expect(plan.script.lines[1].assignment!.character).toBe('騎士');
    expect(assignments[1].character).toBe('騎士');
    expect(script.lines[0].assignment!.character).toBe('案内人');
  });
  it('rejects stale/no-match plans and invalid assignments but retains unavailable historical identities', () => {
    const { script, assignments } = fixture();
    expect(() => planScriptRecast(script, '不明', 'all', assignments[0])).toThrow();
    expect(() => planScriptRecast(script, '案内人', 'stale', assignments[0])).toThrow();
    const invalid = structuredClone(assignments[1]);
    invalid.comparison.selectedId = crypto.randomUUID();
    expect(() => planScriptRecast(script, '案内人', 'all', invalid)).toThrow();
    const removed = structuredClone(assignments[1]);
    const voice = removed.comparison.entries[1].evaluation.candidates[1].voice;
    if (voice.engine !== 'VOICEVOX') throw new Error('fixture');
    voice.voiceId = 'removed-voice';
    const plan = planScriptRecast(script, '案内人', 'all', removed);
    expect(castingCandidateSchema.safeParse(scriptCandidate(plan.script.lines[0])).success).toBe(
      false,
    );
  });
});
