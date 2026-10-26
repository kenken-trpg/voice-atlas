import { parseArgs } from 'node:util';
import { loadConfig } from './config';
import { elevenLabsClient } from './tts/elevenlabs';
import { elevenLabsRecipeSchema, elevenLabsVoiceIdSchema } from '../shared/elevenlabs';
import { castingSynthesize } from './tts/casting';
import { runListeningEvaluation } from './listening-evaluation';

async function main() {
  const { values } = parseArgs({
    options: {
      generate: { type: 'boolean' },
      'voice-id': { type: 'string' },
      'model-id': { type: 'string' },
      search: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(`npm run probe:elevenlabs
引数なし: モデル一覧と声一覧の最初の50件を確認します。音声は生成しません。
任意: --search 声の検索語
生成: --generate --voice-id VOICE_ID --model-id MODEL_ID --output .local-artifacts/elevenlabs/run-1
生成時は共通の評価台詞6文をElevenLabsへ送信し、アカウントの利用枠を消費します。
新しい出力ディレクトリーにWAV・待ち時間・サイズ・生成条件・失敗箇所を保存します。自動再試行は行いません。`);
    return;
  }
  if (!values.generate && (values['voice-id'] || values['model-id'] || values.output))
    throw new Error(
      '音声生成には --generate を指定してください。台詞をElevenLabsへ送信し、利用枠を消費します。',
    );
  if (values.generate && (!values['voice-id'] || !values['model-id'] || !values.output))
    throw new Error('--generate には --voice-id・--model-id・--output が必要です。');
  const config = loadConfig();
  const client = elevenLabsClient(config);
  if (!values.generate) {
    const models = await client.listModels();
    const page = await client.listVoices(values.search ?? '', null);
    console.log(JSON.stringify({ models, voices: page.voices, hasMore: page.hasMore }, null, 2));
    return;
  }
  const voiceId = elevenLabsVoiceIdSchema.parse(values['voice-id']);
  const recipe = elevenLabsRecipeSchema.parse({
    engine: 'ElevenLabs',
    modelId: values['model-id'],
  });
  const result = await runListeningEvaluation(
    config,
    {
      candidate: {
        voice: { engine: 'ElevenLabs', voiceId, name: voiceId, style: 'default' },
        recipe,
      },
      output: values.output!,
    },
    (settings, candidate, text, fetcher) =>
      castingSynthesize(settings, candidate, text, fetcher, client),
  );
  console.log(
    JSON.stringify({
      status: result.status,
      samples: result.samples.length,
      output: values.output,
      listening: result.listening.status,
    }),
  );
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error && error.name !== 'ZodError'
      ? error.message
      : '入力の形式・範囲を確認してください。',
  );
  process.exitCode = 1;
});
