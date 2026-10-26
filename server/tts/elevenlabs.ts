import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  elevenLabsRecipeSchema,
  elevenLabsModelSchema,
  elevenLabsVoiceIdSchema,
  elevenLabsCursorSchema,
  elevenLabsVoicePageSchema,
} from '../../shared/elevenlabs';
import type { Config } from '../config';
import {
  AppError,
  readBody,
  remoteBytes,
  maxJsonBytes,
  maxWavBytes,
  type Fetcher,
} from '../remote';

const api = 'https://api.elevenlabs.io';
const cacheMs = 30_000;
const cursorMs = 10 * 60_000;
const modelListSchema = z
  .array(
    z.object({
      model_id: z.string().min(1).max(100),
      name: z.string().min(1).max(200).nullish(),
      can_do_text_to_speech: z.boolean().optional(),
      can_use_style: z.boolean().optional(),
      can_use_speaker_boost: z.boolean().optional(),
      maximum_text_length_per_request: z.number().int().positive().optional(),
      languages: z
        .array(z.object({ language_id: z.string().max(20), name: z.string().max(100) }))
        .max(300)
        .optional(),
    }),
  )
  .max(100);
const voiceListSchema = z.object({
  // The first upstream page can include additional default voices beyond page_size.
  voices: z
    .array(
      z.object({
        voice_id: elevenLabsVoiceIdSchema,
        name: z.string().min(1).max(200),
        category: z.string().max(40).nullish(),
      }),
    )
    .max(200),
  has_more: z.boolean(),
  next_page_token: z
    .string()
    .min(1)
    .max(500)
    .regex(/^[^\u0000-\u001f\u007f]+$/)
    .nullish(),
});
type VoicePage = z.infer<typeof elevenLabsVoicePageSchema>;

function upstreamError(status: number, code?: string, permission?: string) {
  if (code === 'missing_permissions' || code === 'insufficient_permissions') {
    const setting =
      permission === 'models_read'
        ? 'Models → Read'
        : permission === 'voices_read'
          ? 'Voices → Read'
          : permission === 'text_to_speech'
            ? 'Text to Speech → Access'
            : 'Models → Read、Voices → Read、Text to Speech → Access';
    return new AppError(
      502,
      `ElevenLabsのAPIキーの権限が不足しています。キーの設定で ${setting} を許可して保存してください。`,
    );
  }
  if (code === 'quota_exceeded')
    return new AppError(
      429,
      'ElevenLabsの利用枠が不足しています。アカウントの残クレジットとAPIキーの利用上限を確認してください。',
    );
  if (code === 'too_many_concurrent_requests' || code === 'concurrent_limit_exceeded')
    return new AppError(
      429,
      'ElevenLabsの同時実行数の上限です。他の生成が終了してから再実行してください。自動再試行は行いません。',
    );
  if (code === 'invalid_api_key')
    return new AppError(
      502,
      'ElevenLabsがAPIキーを無効と判定しました。キーの値全体・有効期限・無効化状態を確認してください（invalid_api_key）。',
    );
  if (status === 401)
    return new AppError(502, 'ElevenLabsの認証に失敗しました。APIキーを確認してください。');
  if (status === 403)
    return new AppError(
      502,
      'ElevenLabsの利用権限がありません。APIキーの権限・声・契約プランを確認してください。',
    );
  if (status === 404)
    return new AppError(
      502,
      '選択したElevenLabsの声またはモデルを利用できません。一覧を更新してください。',
    );
  if (status === 422)
    return new AppError(
      502,
      'ElevenLabsが入力を受け付けませんでした。モデル・調声値・音声形式の利用条件を確認してください。',
    );
  if (status === 429)
    return new AppError(
      429,
      'ElevenLabsの利用枠または同時実行数の上限です。利用状況を確認してから再実行してください。',
    );
  return new AppError(
    502,
    'ElevenLabsで処理に失敗しました。生成済みか利用状況を確認してから再実行してください。自動再試行は行いません。',
  );
}

function wavFromPcm(pcm: Buffer) {
  const prefix = pcm.subarray(0, 32).toString('ascii').trimStart();
  if (
    pcm.length < 2 ||
    pcm.length > maxWavBytes - 44 ||
    pcm.length % 2 !== 0 ||
    /^(?:RIFF|ID3|OggS|fLaC|<!DOCTYPE|<html)/i.test(prefix)
  )
    throw new AppError(502, 'ElevenLabsから有効なPCM音声が返りませんでした。');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(22050, 24);
  header.writeUInt32LE(44100, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function createElevenLabsClient(apiKey: string, fetcher: Fetcher = fetch) {
  const key = apiKey.trim();
  const headers = { 'xi-api-key': key };
  async function request(path: string, init: RequestInit, audio = false) {
    if (!key) throw new AppError(503, 'ElevenLabs APIキーが設定されていません。');
    const checkedFetch: Fetcher = async (url, options) => {
      let response: Response;
      try {
        response = await fetcher(url, options);
      } catch {
        throw new AppError(
          502,
          'ElevenLabsの応答を取得できませんでした。生成済みか利用状況を確認してから再実行してください。自動再試行は行いません。',
        );
      }
      if (!response.ok) {
        let code: string | undefined;
        let permission: string | undefined;
        try {
          const bytes = await readBody(
            response,
            16 * 1024,
            options?.signal ?? AbortSignal.timeout(8000),
          );
          const parsed: unknown = JSON.parse(bytes.toString('utf8'));
          const result = z
            .object({
              detail: z.object({
                status: z.string().optional(),
                code: z.string().optional(),
                message: z.string().optional(),
              }),
            })
            .safeParse(parsed);
          if (result.success) {
            code = result.data.detail.status ?? result.data.detail.code;
            permission = result.data.detail.message
              ?.match(/\bpermission\s+(models_read|voices_read|text_to_speech)\b/i)?.[1]
              .toLowerCase();
          }
        } catch {
          // Unknown, oversized or malformed bodies use the fixed HTTP fallback.
        }
        throw upstreamError(response.status, code, permission);
      }
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      const valid = audio
        ? ['audio/pcm', 'audio/x-pcm', 'audio/raw', 'application/octet-stream'].includes(mime ?? '')
        : mime === 'application/json';
      if (!valid) {
        await response.body?.cancel();
        throw new AppError(502, 'ElevenLabsの応答形式を確認できませんでした。');
      }
      return response;
    };
    return remoteBytes(
      `${api}${path}`,
      { ...init, headers: { ...headers, ...init.headers } },
      audio ? 60_000 : 8000,
      checkedFetch,
      audio ? maxWavBytes - 44 : maxJsonBytes,
    );
  }
  async function json(path: string) {
    const bytes = await request(path, {});
    try {
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new AppError(502, 'ElevenLabsから有効なJSON応答を取得できませんでした。');
    }
  }
  let modelCache:
    { until: number; pending: Promise<z.infer<typeof elevenLabsModelSchema>[]> } | undefined;
  function models() {
    if (modelCache && modelCache.until > Date.now()) return modelCache.pending;
    const pending = (async () => {
      const result = modelListSchema.safeParse(await json('/v1/models'));
      if (!result.success)
        throw new AppError(502, 'ElevenLabsのモデル一覧を確認できませんでした。');
      const models = result.data
        .filter((model) => model.can_do_text_to_speech === true)
        .map((model) =>
          elevenLabsModelSchema.parse({
            modelId: model.model_id,
            name: model.name || model.model_id,
            canUseStyle: model.can_use_style === true,
            canUseSpeakerBoost: model.can_use_speaker_boost === true,
            maxCharacters: Math.min(model.maximum_text_length_per_request ?? 300, 100000),
            languages: (model.languages ?? []).map(({ language_id, name }) => ({
              id: language_id,
              name,
            })),
          }),
        );
      return [...new Map(models.map((model) => [model.modelId, model])).values()];
    })();
    const entry = { until: Date.now() + cacheMs, pending };
    modelCache = entry;
    void pending.catch(() => {
      if (modelCache === entry) modelCache = undefined;
    });
    return pending;
  }
  const cursors = new Map<
    string,
    { search: string; remaining: VoicePage['voices']; upstream: string | null; until: number }
  >();
  const pages = new Map<string, { until: number; pending: Promise<VoicePage> }>();
  return {
    async status() {
      if (!key)
        return {
          ready: false,
          detail: '未設定：ELEVENLABS_API_KEYを設定してサーバーを再起動してください',
        };
      try {
        const available = await models();
        return available.length
          ? {
              ready: true,
              detail: '接続済み（クラウド）：声とモデルの利用権限は各操作時に確認します',
            }
          : { ready: false, detail: '利用できる音声合成モデルがありません。' };
      } catch (error) {
        return {
          ready: false,
          detail:
            error instanceof AppError ? error.message : 'ElevenLabsの接続確認に失敗しました。',
        };
      }
    },
    listModels: models,
    async listVoices(search: string, cursor: string | null): Promise<VoicePage> {
      search = z.string().trim().max(100).parse(search);
      if (cursor !== null) elevenLabsCursorSchema.parse(cursor);
      const cacheKey = JSON.stringify([search, cursor]);
      const cached = pages.get(cacheKey);
      if (cached && cached.until > Date.now()) return cached.pending;
      const pending = (async () => {
        for (const [id, entry] of cursors) if (entry.until <= Date.now()) cursors.delete(id);
        const previous = cursor ? cursors.get(cursor) : undefined;
        if (cursor && (!previous || previous.search !== search))
          throw new AppError(
            400,
            '声一覧のページ情報が無効または期限切れです。検索し直してください。',
          );
        let voices = previous?.remaining ?? [];
        let upstream = previous?.upstream ?? null;
        if (!previous || !voices.length) {
          const params = new URLSearchParams({ page_size: '50', include_total_count: 'false' });
          if (search) params.set('search', search);
          if (upstream) params.set('next_page_token', upstream);
          const parsed = voiceListSchema.safeParse(await json(`/v2/voices?${params}`));
          if (
            !parsed.success ||
            (parsed.data.has_more &&
              (!parsed.data.next_page_token || parsed.data.next_page_token === upstream))
          )
            throw new AppError(502, 'ElevenLabsの声一覧・ページ情報を確認できませんでした。');
          voices = [
            ...new Map(
              parsed.data.voices.map((voice) => [
                voice.voice_id,
                {
                  engine: 'ElevenLabs' as const,
                  voiceId: voice.voice_id,
                  name: voice.name,
                  ...(voice.category ? { category: voice.category } : {}),
                  style: 'default',
                },
              ]),
            ).values(),
          ];
          upstream = parsed.data.has_more ? parsed.data.next_page_token! : null;
        }
        const remaining = voices.slice(50);
        const hasMore = remaining.length > 0 || upstream !== null;
        const nextCursor = hasMore ? randomUUID() : null;
        if (nextCursor) {
          if (cursors.size >= 128) cursors.delete(cursors.keys().next().value!);
          cursors.set(nextCursor, { search, remaining, upstream, until: Date.now() + cursorMs });
        }
        return elevenLabsVoicePageSchema.parse({
          voices: voices.slice(0, 50),
          hasMore,
          nextCursor,
        });
      })();
      if (pages.size >= 32) pages.delete(pages.keys().next().value!);
      const entry = { until: Date.now() + cacheMs, pending };
      pages.set(cacheKey, entry);
      void pending.catch(() => {
        if (pages.get(cacheKey) === entry) pages.delete(cacheKey);
      });
      return pending;
    },
    async synthesize(input: { voiceId: string; text: string; recipe: unknown }) {
      const recipe = elevenLabsRecipeSchema.parse(input.recipe);
      const text = z.string().trim().min(1).max(300).parse(input.text);
      const voiceId = elevenLabsVoiceIdSchema.parse(input.voiceId);
      const model = (await models()).find((item) => item.modelId === recipe.modelId);
      if (!model)
        throw new AppError(
          400,
          '選択したElevenLabsモデルを利用できません。モデル一覧を更新してください。',
        );
      if (text.length > model.maxCharacters)
        throw new AppError(400, '台詞が選択モデルの文字数上限を超えています。');
      if (
        (!model.canUseStyle && recipe.style !== 0) ||
        (!model.canUseSpeakerBoost && recipe.useSpeakerBoost)
      )
        throw new AppError(400, '選択モデルが対応していない調声値です。');
      if (model.modelId === 'eleven_v3' && ![0, 0.5, 1].includes(recipe.stability))
        throw new AppError(400, 'Eleven v3の安定性は0・0.5・1から選んでください。');
      const pcm = await request(
        `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_22050`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            model_id: recipe.modelId,
            voice_settings: {
              stability: recipe.stability,
              similarity_boost: recipe.similarityBoost,
              ...(model.canUseStyle ? { style: recipe.style } : {}),
              ...(model.canUseSpeakerBoost ? { use_speaker_boost: recipe.useSpeakerBoost } : {}),
            },
            ...(recipe.seed === null ? {} : { seed: recipe.seed }),
          }),
        },
        true,
      );
      return {
        wav: wavFromPcm(pcm),
        generation: {
          modelId: recipe.modelId,
          outputFormat: recipe.outputFormat,
          seed: recipe.seed,
        },
      };
    },
  };
}
export type ElevenLabsClient = ReturnType<typeof createElevenLabsClient>;
export function elevenLabsClient(config: Config, fetcher: Fetcher = fetch) {
  return createElevenLabsClient(config.elevenLabsApiKey ?? '', fetcher);
}
