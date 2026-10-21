import { voices } from '../../shared/catalog';
import {
  castingKey,
  type CastingInventory,
  type CastingVoice,
  type CastingCandidate,
} from '../../shared/casting';
import { createTtsAdapter } from './index';
import { createAivisClient } from './aivis';
import { findVoicevoxStyle } from '../../shared/voicevox';
import { AppError, type Fetcher } from '../remote';
import type { Config } from '../config';

export async function castingInventory(
  config: Config,
  fetcher: Fetcher,
): Promise<CastingInventory> {
  const [vv, aivis] = await Promise.allSettled([
    createTtsAdapter(config, 'VOICEVOX', fetcher).listSpeakers(),
    createAivisClient(config.aivisUrl || 'http://127.0.0.1:10101', fetcher).listSpeakers(),
  ]);
  const available: CastingVoice[] = [];
  if (vv.status === 'fulfilled')
    voices
      .filter((voice) => findVoicevoxStyle(vv.value, voice))
      .forEach((voice) =>
        available.push({
          engine: 'VOICEVOX',
          voiceId: voice.id,
          name: voice.name,
          style: voice.style,
        }),
      );
  if (aivis.status === 'fulfilled') {
    const idCounts = new Map<number, number>();
    aivis.value.forEach((speaker) =>
      speaker.styles.forEach((style) => idCounts.set(style.id, (idCounts.get(style.id) || 0) + 1)),
    );
    aivis.value.forEach((speaker) =>
      speaker.styles.forEach((style) => {
        if (idCounts.get(style.id) === 1)
          available.push({
            engine: 'AivisSpeech',
            speakerUuid: speaker.speaker_uuid,
            name: speaker.name,
            style: style.name,
          });
      }),
    );
  }
  const counts = new Map<string, number>();
  available.forEach((voice) =>
    counts.set(castingKey(voice), (counts.get(castingKey(voice)) || 0) + 1),
  );
  return {
    checkedAt: new Date().toISOString(),
    engines: (
      [
        ['VOICEVOX', vv],
        ['AivisSpeech', aivis],
      ] as const
    ).map(([engine, result]) => ({
      engine,
      ready: result.status === 'fulfilled',
      detail:
        result.status === 'fulfilled'
          ? '接続済み'
          : '未接続：アプリまたはエンジンを起動してください',
    })),
    voices: available.filter((voice) => counts.get(castingKey(voice)) === 1).slice(0, 200),
  };
}
export async function castingSynthesize(
  config: Config,
  candidate: CastingCandidate,
  text: string,
  fetcher: Fetcher,
) {
  if (candidate.voice.engine === 'AivisSpeech' && candidate.recipe.engine === 'AivisSpeech') {
    const result = await createAivisClient(
      config.aivisUrl || 'http://127.0.0.1:10101',
      fetcher,
    ).synthesize({
      target: { speakerUuid: candidate.voice.speakerUuid, styleName: candidate.voice.style },
      text,
      recipe: candidate.recipe,
    });
    return {
      wav: result.wav,
      generation: {
        engine: 'AivisSpeech' as const,
        engineVersion: result.evidence.engineVersion,
        checkedAt: result.evidence.checkedAt,
        observedStyleId: result.evidence.observedStyleId,
      },
    };
  }
  if (candidate.voice.engine === 'VOICEVOX' && candidate.recipe.engine === 'VOICEVOX') {
    const voice = voices.find(
      (voice) => voice.id === (candidate.voice as { voiceId: string }).voiceId,
    )!;
    const { engine: _engine, ...recipe } = candidate.recipe;
    const result = await createTtsAdapter(config, 'VOICEVOX', fetcher).synthesize({
      voice,
      text,
      recipe,
    });
    return {
      wav: result.wav,
      generation: {
        engine: 'VOICEVOX' as const,
        engineVersion: result.engineInfo?.version ?? null,
        checkedAt: result.engineInfo?.checkedAt ?? new Date().toISOString(),
      },
    };
  }
  throw new AppError(400, '話者と調声値の製品が一致しません。');
}
