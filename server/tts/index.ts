import type { Recipe, Voice } from '../../shared/schema';
import type { InstalledSpeaker } from '../../shared/voicevox';
import type { EngineInfo } from '../../shared/evaluation-evidence';
import type { Config } from '../config';
import { AppError, type Fetcher } from '../remote';
import { createVoicevoxAdapter } from './voicevox';

// Recipes currently use VOICEVOX units. Another engine must define its own
// validated mapping rather than assuming that these numbers are interchangeable.
export interface TtsAdapter {
  readonly id: Voice['engine'];
  readonly controls: readonly (keyof Recipe)[];
  listSpeakers(): Promise<InstalledSpeaker[]>;
  synthesize(request: { voice: Voice; text: string; recipe: Recipe }): Promise<{
    wav: Buffer;
    engineInfo: EngineInfo | null;
  }>;
}

export function createTtsAdapter(
  config: Config,
  engine: Voice['engine'],
  fetcher: Fetcher = fetch,
): TtsAdapter {
  if (engine === 'VOICEVOX') return createVoicevoxAdapter(config, fetcher);
  throw new AppError(
    400,
    'この話者はアプリ内試聴に対応していません。公式サンプルをご利用ください。',
  );
}
