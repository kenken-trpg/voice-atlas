import { parseArgs } from 'node:util';
import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createAivisClient } from './tts/aivis';
import { AppError } from './remote';

async function main() {
  const { values } = parseArgs({
    options: {
      'speaker-uuid': { type: 'string' },
      style: { type: 'string' },
      text: { type: 'string' },
      output: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'npm run probe:aivis -- [--speaker-uuid UUID --style スタイル名 --text セリフ --output .local-artifacts/aivis.wav]\n引数なし: 導入済み話者の一覧。合成には4引数すべてが必要。既存ファイルは上書きしません。\n接続先: AIVIS_BASE_URL（既定 http://127.0.0.1:10101、ループバックHTTP限定）',
    );
    return;
  }
  const options = [values['speaker-uuid'], values.style, values.text, values.output];
  if (options.some((value) => value !== undefined) && options.some((value) => !value))
    throw new Error(
      '合成には --speaker-uuid / --style / --text / --output をすべて指定してください。',
    );
  const client = createAivisClient(process.env.AIVIS_BASE_URL || 'http://127.0.0.1:10101');
  if (!values.output) {
    console.log(
      JSON.stringify({ engine: 'AivisSpeech', speakers: await client.listSpeakers() }, null, 2),
    );
    return;
  }
  const output = resolve(values.output);
  if (!output.endsWith('.wav')) throw new Error('--output は .wav のパスを指定してください。');
  await mkdir(dirname(output), { recursive: true });
  // Reserve both files before spending time on synthesis; never overwrite existing data.
  const wavFile = await open(output, 'wx');
  let metadataFile;
  try {
    metadataFile = await open(`${output}.json`, 'wx');
    const result = await client.synthesize({
      target: { speakerUuid: values['speaker-uuid']!, styleName: values.style! },
      text: values.text!,
      recipe: { engine: 'AivisSpeech' },
    });
    await wavFile.writeFile(result.wav);
    await metadataFile.writeFile(
      JSON.stringify(
        { format: 'voice-atlas-aivis-probe', version: 1, ...result.evidence },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ wav: output, evidence: `${output}.json` }));
  } catch (error) {
    await wavFile.close();
    await unlink(output);
    if (metadataFile) {
      await metadataFile.close();
      await unlink(`${output}.json`);
    }
    throw error;
  } finally {
    await wavFile.close();
    await metadataFile?.close();
  }
}
main().catch((error: unknown) => {
  console.error(
    error instanceof AppError
      ? error.message
      : error instanceof Error
        ? error.message
        : '検証に失敗しました。',
  );
  process.exitCode = 1;
});
