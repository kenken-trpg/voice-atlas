import { z } from 'zod';
import { loopbackUrl } from '../config';
import { AppError, remoteBytes, remoteJson, maxWavBytes, type Fetcher } from '../remote';

import { aivisRecipeSchema } from '../../shared/aivis';
export { aivisRecipeSchema, type AivisRecipe } from '../../shared/aivis';
const styleId = z.number().int().min(-2147483648).max(2147483647);
const speakersSchema = z.array(
  z.object({
    name: z.string().min(1).max(200),
    speaker_uuid: z.uuid(),
    styles: z.array(
      z.object({ name: z.string().min(1).max(200), id: styleId, type: z.string().optional() }),
    ),
  }),
);
export type AivisSpeaker = z.infer<typeof speakersSchema>[number];
const targetSchema = z.strictObject({
  speakerUuid: z.uuid(),
  styleName: z.string().min(1).max(200),
});
const querySchema = z
  .object({
    accent_phrases: z.array(z.unknown()),
    outputSamplingRate: z.number().int().min(8000).max(192000),
    outputStereo: z.boolean(),
  })
  .catchall(z.unknown());

// Experimental client: kept separate from production recipes/evaluation formats.
export function createAivisClient(rawUrl: string, fetcher: Fetcher = fetch) {
  const baseUrl = loopbackUrl(rawUrl);
  async function listSpeakers(): Promise<AivisSpeaker[]> {
    const result = speakersSchema.safeParse(
      await remoteJson(`${baseUrl}/speakers`, {}, 2500, fetcher),
    );
    if (!result.success)
      throw new AppError(502, 'AivisSpeechの話者一覧の形式を確認できませんでした。');
    return result.data.map((speaker) => ({
      ...speaker,
      styles: speaker.styles.filter((style) => !style.type || style.type === 'talk'),
    }));
  }
  async function version(): Promise<string | null> {
    try {
      const bytes = await remoteBytes(`${baseUrl}/version`, {}, 1000, fetcher, 1024);
      const parsed = z
        .string()
        .trim()
        .min(1)
        .max(100)
        .regex(/^[^\u0000-\u001f\u007f]+$/)
        .safeParse(JSON.parse(bytes.toString('utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
  return {
    listSpeakers,
    async synthesize(request: {
      target: z.input<typeof targetSchema>;
      text: string;
      recipe: z.input<typeof aivisRecipeSchema>;
    }) {
      const target = targetSchema.parse(request.target);
      const text = z.string().trim().min(1).max(300).parse(request.text);
      const recipe = aivisRecipeSchema.parse(request.recipe);
      // Resolve every time: numeric IDs are engine-local observations, not saved identities.
      const speakers = await listSpeakers();
      const matches = speakers
        .filter(
          (speaker) => speaker.speaker_uuid.toLowerCase() === target.speakerUuid.toLowerCase(),
        )
        .flatMap((speaker) =>
          speaker.styles
            .filter((style) => style.name === target.styleName)
            .map((style) => ({ speaker, style })),
        );
      if (matches.length !== 1)
        throw new AppError(
          409,
          '話者UUIDとスタイル名を一意に照合できませんでした。話者一覧を確認してください。',
        );
      const { speaker, style } = matches[0];
      if (
        speakers.flatMap((item) => item.styles).filter((item) => item.id === style.id).length !== 1
      )
        throw new AppError(409, 'スタイルIDが重複しています。モデル構成を確認してください。');
      const params = new URLSearchParams({ text, speaker: String(style.id) });
      const parsed = querySchema.safeParse(
        await remoteJson(`${baseUrl}/audio_query?${params}`, { method: 'POST' }, 30000, fetcher),
      );
      if (!parsed.success)
        throw new AppError(502, 'AivisSpeechから有効な音声クエリを取得できませんでした。');
      const { engine: _engine, ...parameters } = recipe;
      const wav = await remoteBytes(
        `${baseUrl}/synthesis?speaker=${style.id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...parsed.data, ...parameters, kana: text }),
        },
        60000,
        fetcher,
        maxWavBytes,
      );
      if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE')
        throw new AppError(502, 'AivisSpeechから有効なWAV音声が返りませんでした。');
      return {
        wav,
        evidence: {
          engine: 'AivisSpeech' as const,
          engineVersion: await version(),
          checkedAt: new Date().toISOString(),
          speakerUuid: speaker.speaker_uuid,
          speakerName: speaker.name,
          styleName: style.name,
          observedStyleId: style.id,
          outputSamplingRate: parsed.data.outputSamplingRate,
          outputStereo: parsed.data.outputStereo,
          text,
          recipe,
        },
      };
    },
  };
}
