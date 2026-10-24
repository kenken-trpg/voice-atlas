import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { loadConfig } from './config';
import { analyzeCharacter } from './services';

const help = `DeepSeekの画像解析を実APIで評価します（API利用料が発生します）。
使い方: npm run evaluate:vision -- --run [--case no-subject|single-subject|two-subject] [--image /path/to/image.png]
--run を指定した場合だけ送信します。--case を省略すると生成した3画像を評価し、画像を指定すると追加します。
結果は標準出力だけに表示し、スクリプトはAPIキー・画像・入力パスを出力しません。npmは実行コマンドと入力パスを表示します。`;

function scene(figures: 0 | 1 | 2): string {
  const person = (x: number, face: string, body: string) => `
    <circle cx="${x}" cy="190" r="78" fill="${face}" stroke="#26354a" stroke-width="8"/>
    <circle cx="${x - 25}" cy="182" r="7" fill="#26354a"/>
    <circle cx="${x + 25}" cy="182" r="7" fill="#26354a"/>
    <path d="M ${x - 20} 217 Q ${x} 237 ${x + 20} 217" fill="none" stroke="#26354a" stroke-width="6"/>
    <path d="M ${x - 100} 400 Q ${x - 100} 280 ${x} 280 Q ${x + 100} 280 ${x + 100} 400 Z" fill="${body}" stroke="#26354a" stroke-width="8"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="512" viewBox="0 0 768 512">
    <rect width="768" height="512" fill="#dceefa"/>
    <circle cx="640" cy="85" r="40" fill="#fff2a8"/>
    <path d="M0 408 Q190 335 384 410 T768 400 V512 H0Z" fill="#98bf88"/>
    ${figures === 1 ? person(384, '#f8c96a', '#597cbb') : ''}
    ${figures === 2 ? person(245, '#f8c96a', '#597cbb') + person(523, '#e9b6c8', '#9364a5') : ''}
  </svg>`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      run: { type: 'boolean' },
      case: { type: 'string' },
      image: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || !values.run) {
    console.log(help);
    return;
  }
  const config = loadConfig();
  if (!config.deepseekKey) throw new Error('DEEPSEEK_API_KEYを設定してください。');
  if (values.case && !['no-subject', 'single-subject', 'two-subject'].includes(values.case))
    throw new Error('--case は no-subject・single-subject・two-subject から選んでください。');
  const cases: Array<{ name: string; expectedSubjectFound: boolean; bytes: Buffer }> = [];
  for (const [name, figures, expectedSubjectFound] of [
    ['no-subject', 0, false],
    ['single-subject', 1, true],
    ['two-subject', 2, false],
  ] as const) {
    if (values.case && values.case !== name) continue;
    cases.push({
      name,
      expectedSubjectFound,
      bytes: await sharp(Buffer.from(scene(figures)))
        .png()
        .toBuffer(),
    });
  }
  if (values.image) {
    let bytes: Buffer;
    try {
      bytes = await readFile(values.image);
    } catch {
      throw new Error('画像ファイルを読み込めませんでした。');
    }
    cases.push({
      name: 'supplied-image',
      expectedSubjectFound: true,
      bytes,
    });
  }
  if (!cases.length) throw new Error('評価する画像がありません。--case の指定を確認してください。');
  const report = [];
  for (const item of cases) {
    let apiRequests = 0;
    const started = Date.now();
    try {
      const metadata = await sharp(item.bytes).metadata();
      if (!['png', 'jpeg', 'webp'].includes(metadata.format || ''))
        throw new Error('PNG・JPEG・WebPの画像を指定してください。');
      const result = await analyzeCharacter(
        config,
        {
          provider: 'deepseek',
          inputMode: 'image',
          image: `data:image/${metadata.format};base64,${item.bytes.toString('base64')}`,
          characterText: '',
          direction: '',
          consent: true,
        },
        async (url, init) => {
          apiRequests++;
          return fetch(url, init);
        },
      );
      report.push({
        case: item.name,
        expectedSubjectFound: item.expectedSubjectFound,
        subjectFound: result.subjectFound,
        passed: result.subjectFound === item.expectedSubjectFound,
        apiRequests,
        elapsedMs: Date.now() - started,
        summary: result.summary,
        cues: result.cues,
      });
    } catch (error) {
      report.push({
        case: item.name,
        expectedSubjectFound: item.expectedSubjectFound,
        passed: false,
        apiRequests,
        elapsedMs: Date.now() - started,
        error: error instanceof Error ? error.message : '解析に失敗しました。',
      });
    }
  }
  console.log(JSON.stringify({ model: config.deepseekModel, results: report }, null, 2));
  if (report.some((item) => !item.passed)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : '評価を開始できませんでした。');
  process.exitCode = 1;
});
