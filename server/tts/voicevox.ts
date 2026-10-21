import { z } from 'zod';
import type { Config } from '../config';
import { recipeSchema, type Voice, type Recipe } from '../../shared/schema';
import { findVoicevoxStyle } from '../../shared/voicevox';
import { engineInfoSchema, type EngineInfo } from '../../shared/evaluation-evidence';
import { AppError, remoteJson, remoteBytes, maxWavBytes, type Fetcher } from '../remote';
import type { TtsAdapter } from './index';

// Optional provenance: failure must not turn successfully generated audio into an error.
export async function getEngineInfo(
  config: Config,
  fetcher: Fetcher = fetch,
): Promise<EngineInfo | null> {
  try {
    const bytes = await remoteBytes(`${config.voicevoxUrl}/version`, {}, 1000, fetcher, 1024);
    const result = engineInfoSchema.safeParse({
      engine: 'VOICEVOX',
      version: JSON.parse(bytes.toString('utf8')),
      checkedAt: new Date().toISOString(),
    });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const speakerSchema = z.array(
  z.object({
    name: z.string(),
    speaker_uuid: z.string(),
    styles: z.array(
      z.object({
        name: z.string(),
        id: z.number().int().nonnegative(),
        type: z.string().optional(),
      }),
    ),
  }),
);
export async function getSpeakers(config: Config, fetcher: Fetcher = fetch) {
  const result = speakerSchema.safeParse(
    await remoteJson(`${config.voicevoxUrl}/speakers`, {}, 2500, fetcher),
  );
  if (!result.success)
    throw new AppError(
      502,
      'VOICEVOXから話者一覧を取得できませんでした。エンジンのバージョンを確認してください。',
    );
  return result.data;
}
export async function synthesize(
  config: Config,
  voice: Voice,
  text: string,
  recipe: Recipe,
  fetcher: Fetcher = fetch,
): Promise<Buffer> {
  if (voice.engine !== 'VOICEVOX')
    throw new AppError(
      400,
      'この話者はアプリ内試聴に対応していません。公式サンプルをご利用ください。',
    );
  const speakers = await getSpeakers(config, fetcher);
  const style = findVoicevoxStyle(speakers, voice);
  if (!style)
    throw new AppError(
      409,
      `接続中のVOICEVOXに「${voice.name} / ${voice.style}」がありません。音声ライブラリを確認してください。`,
    );
  const params = new URLSearchParams({ text, speaker: String(style.id) });
  const queryResult = z
    .record(z.string(), z.unknown())
    .safeParse(
      await remoteJson(
        `${config.voicevoxUrl}/audio_query?${params}`,
        { method: 'POST' },
        30_000,
        fetcher,
      ),
    );
  if (!queryResult.success)
    throw new AppError(502, 'VOICEVOXから有効な音声クエリを取得できませんでした。');
  const query = queryResult.data;
  const wav = await remoteBytes(
    `${config.voicevoxUrl}/synthesis?speaker=${style.id}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...query, ...recipe, outputSamplingRate: 24000, outputStereo: false }),
    },
    60_000,
    fetcher,
    maxWavBytes,
  );
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE')
    throw new AppError(502, 'VOICEVOXから有効なWAV音声が返りませんでした。');
  return wav;
}

export function createVoicevoxAdapter(config: Config, fetcher: Fetcher): TtsAdapter {
  return {
    id: 'VOICEVOX',
    controls: [
      'speedScale',
      'pitchScale',
      'intonationScale',
      'volumeScale',
      'prePhonemeLength',
      'postPhonemeLength',
    ],
    listSpeakers: () => getSpeakers(config, fetcher),
    async synthesize(request) {
      if (request.voice.engine !== 'VOICEVOX')
        throw new AppError(400, '選択した話者はこのエンジンに対応していません。');
      const text = z.string().trim().min(1).max(300).parse(request.text);
      const recipe = recipeSchema.parse(request.recipe);
      const wav = await synthesize(config, request.voice, text, recipe, fetcher);
      const engineInfo = await getEngineInfo(config, fetcher);
      return { wav, engineInfo };
    },
  };
}
