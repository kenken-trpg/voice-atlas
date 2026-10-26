import { scriptAudioKey, type ScriptLine } from './script';

// Keys come from successfully generated or restored audio in this editing session.
// Keep only the conditions, so invalidated audio blobs can still be released.
export function scriptGenerationReasons(line: ScriptLine, previousKey?: string): string[] {
  if (!previousKey) return ['未生成'];
  const before = JSON.parse(previousKey) as unknown[];
  const after = JSON.parse(scriptAudioKey(line)) as unknown[];
  const reasons: string[] = [];
  if (before[1] !== after[1]) reasons.push('読み上げ文変更');
  if (JSON.stringify(before[2]) !== JSON.stringify(after[2])) reasons.push('声変更');
  if (JSON.stringify(before[3]) !== JSON.stringify(after[3])) reasons.push('調声変更');
  return reasons.length ? reasons : ['音声なし（生成時の条件に戻っています）'];
}
