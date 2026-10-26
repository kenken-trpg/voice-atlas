import { parseArgs } from 'node:util';
import { loadConfig } from './config';
import { castingInventory } from './tts/casting';
import { aivisRecipeSchema } from '../shared/aivis';
import { voices } from '../shared/catalog';
import { makeRecipe } from '../shared/recommend';
import { neutralProfile } from '../shared/schema';
import { runListeningEvaluation } from './listening-evaluation';

async function main() {
  const { values } = parseArgs({
    options: {
      engine: { type: 'string' },
      'voice-id': { type: 'string' },
      'speaker-uuid': { type: 'string' },
      style: { type: 'string' },
      output: { type: 'string' },
      'machine-note': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'npm run evaluate:voice\n引数なし: 接続と候補の一覧のみ。音声生成はしません。\nVOICEVOX: --engine VOICEVOX --voice-id vv-ryusei --output .local-artifacts/listening/ryusei\nAivisSpeech: --engine AivisSpeech --speaker-uuid UUID --style スタイル名 --output .local-artifacts/listening/aivis\n共通の6文を製品固有の初期設定で生成し、WAV・待ち時間・生成情報を保存します。出力先は新しいディレクトリーを指定してください。任意: --machine-note 機器の補足',
    );
    return;
  }
  const config = loadConfig();
  if (!Object.values(values).some((value) => value !== undefined)) {
    console.log(JSON.stringify(await castingInventory(config, fetch), null, 2));
    return;
  }
  if (!values.output || !['VOICEVOX', 'AivisSpeech'].includes(values.engine ?? ''))
    throw new Error('--engine と --output、および対象話者を指定してください。');
  if (
    values.engine === 'VOICEVOX'
      ? !values['voice-id'] || !!values['speaker-uuid'] || !!values.style
      : !values['speaker-uuid'] || !values.style || !!values['voice-id']
  )
    throw new Error(
      'VOICEVOXは --voice-id、AivisSpeechは --speaker-uuid と --style を指定してください。',
    );
  const inventory = await castingInventory(config, fetch);
  const voice = inventory.voices.find(
    (item) =>
      item.engine === values.engine &&
      (item.engine === 'VOICEVOX'
        ? item.voiceId === values['voice-id']
        : item.engine === 'AivisSpeech' &&
          item.speakerUuid.toLowerCase() === values['speaker-uuid']?.toLowerCase() &&
          item.style === values.style),
  );
  if (!voice)
    throw new Error('対象の声が接続中のエンジンにありません。引数なしで一覧を確認してください。');
  const catalogVoice =
    voice.engine === 'VOICEVOX' ? voices.find((item) => item.id === voice.voiceId)! : null;
  const candidate = {
    voice,
    recipe: catalogVoice
      ? { ...makeRecipe(neutralProfile, catalogVoice), engine: 'VOICEVOX' as const }
      : aivisRecipeSchema.parse({ engine: 'AivisSpeech' }),
  };
  const result = await runListeningEvaluation(config, {
    candidate,
    output: values.output,
    machineNote: values['machine-note'],
  });
  console.log(
    JSON.stringify({
      status: result.status,
      samples: result.samples.length,
      output: values.output,
      listening: result.listening.status,
    }),
  );
}
main().catch((cause) => {
  console.error(cause instanceof Error ? cause.message : '評価音声を生成できませんでした。');
  process.exitCode = 1;
});
