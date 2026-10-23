import { spawn } from 'node:child_process';
import { access, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { irodoriEvaluationSchema, makeIrodoriPlan } from '../shared/irodori-evaluation';
import { baselineWarnings, memoryReport } from './irodori-memory';

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string' },
      python: { type: 'string' },
      config: { type: 'string' },
      output: { type: 'string' },
      plan: { type: 'boolean' },
      preflight: { type: 'boolean' },
      'inspect-run': { type: 'string' },
      'recover-run': { type: 'string' },
      'allow-legacy-run': { type: 'boolean' },
      'memory-report': { type: 'string', multiple: true },
      'memory-baseline': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(`npm run evaluate:irodori -- [--repo ../Irodori-TTS] [--python /path/to/python]
引数なし: Pythonと依存パッケージの診断のみ。モデルの読み込み・取得は行いません。
--config 設定.json --plan: 生成する条件と件数を表示。ファイル保存・生成はしません。
--config 設定.json --output 新しい出力先 --preflight: モデルを読み込まず、依存環境・ローカルファイル・tokenizer・出力容量を確認。
--config 設定.json --output 新しい出力先: ローカルモデルで評価音声を順次生成。
--inspect-run 既存の出力先: 記録と保存済みWAVを点検。変更はしません。
--recover-run 既存の出力先: 停止済みのrunningランをinterruptedに整理。元の記録をバックアップします。
古いPIDなしのランだけ、停止を別途確認して --allow-legacy-run を追加します。
--memory-report 出力先 [--memory-report 別の出力先]: 実測メモリーと生成時間を比較表示。
--config 設定.json --output 新しい出力先 --memory-baseline 既存の出力先: 過去ランから生成前の注意を表示。
設定例・必要な準備・測定値の範囲は docs/irodori-evaluation.md を参照してください。`);
    return;
  }
  if (values['memory-report']) {
    if (
      values.config ||
      values.output ||
      values.plan ||
      values.preflight ||
      values.repo ||
      values.python ||
      values['inspect-run'] ||
      values['recover-run'] ||
      values['memory-baseline'] ||
      values['allow-legacy-run']
    )
      throw new Error('--memory-report はほかの操作と併用できません。');
    console.log(JSON.stringify(await memoryReport(values['memory-report']), null, 2));
    return;
  }
  const runPath = values['inspect-run'] ?? values['recover-run'];
  if (values['inspect-run'] && values['recover-run'])
    throw new Error('--inspect-run と --recover-run は併用できません。');
  if (values['allow-legacy-run'] && !values['recover-run'])
    throw new Error('--allow-legacy-run には --recover-run が必要です。');
  if (
    runPath &&
    (values.config ||
      values.output ||
      values.plan ||
      values.preflight ||
      values.repo ||
      values['memory-baseline'])
  )
    throw new Error('既存ランの点検・整理は生成・診断の引数と併用できません。');
  if (runPath) {
    const bridge = fileURLToPath(new URL('./irodori-evaluate.py', import.meta.url));
    const args = [
      bridge,
      values['inspect-run'] ? '--inspect-run' : '--recover-run',
      resolve(runPath),
    ];
    if (values['allow-legacy-run']) args.push('--allow-legacy-run');
    const child = spawn(values.python ?? 'python3', args, {
      shell: false,
      stdio: 'inherit',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    await new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        process.exitCode = code ?? (signal ? 130 : 1);
        done();
      });
    });
    return;
  }
  if ((values.plan || values.output || values.preflight) && !values.config)
    throw new Error('--plan / --output / --preflight には --config が必要です。');
  if (values.plan && values.output) throw new Error('--plan と --output は併用できません。');
  if (values.plan && values.preflight) throw new Error('--plan と --preflight は併用できません。');
  if (values.preflight && !values.output)
    throw new Error('--preflight には検査する --output が必要です。');
  if (values['memory-baseline'] && (!values.config || !values.output || values.plan))
    throw new Error('--memory-baseline には --config と --output が必要です。');
  const repo = resolve(values.repo ?? '../Irodori-TTS');
  let plan: ReturnType<typeof makeIrodoriPlan> | undefined;
  if (values.config) {
    const configPath = resolve(values.config);
    const file = await open(configPath, 'r');
    let bytes: Buffer;
    try {
      if ((await file.stat()).size > 64 * 1024)
        throw new Error('設定ファイルは64KiB以下にしてください。');
      const buffer = Buffer.alloc(64 * 1024 + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > 64 * 1024) throw new Error('設定ファイルは64KiB以下にしてください。');
      bytes = buffer.subarray(0, length);
    } finally {
      await file.close();
    }
    const config = irodoriEvaluationSchema.parse(JSON.parse(bytes.toString('utf8')));
    config.checkpoint = resolve(dirname(configPath), config.checkpoint);
    config.codecPath = resolve(dirname(configPath), config.codecPath);
    if (config.mode === 'reference')
      config.referenceWav = resolve(dirname(configPath), config.referenceWav);
    plan = makeIrodoriPlan(config);
    if (values.plan) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    if (!values.output) throw new Error('生成には新しい --output を指定してください。');
  }
  if (values['memory-baseline'] && plan) {
    const result = await baselineWarnings(values['memory-baseline'], plan.config);
    console.error(
      `基準ラン: ${result.baseline.directory}（${result.baseline.completedSamples}件、生成枠${result.baseline.generationCapSeconds}秒）`,
    );
    for (const warning of result.warnings) console.error(`注意: ${warning}`);
  }
  const venv = resolve(repo, '.venv/bin/python');
  const python =
    values.python ??
    (await access(venv, constants.X_OK).then(
      () => venv,
      () => 'python3',
    ));
  const bridge = fileURLToPath(new URL('./irodori-evaluate.py', import.meta.url));
  const args = [bridge, '--repo', repo];
  if (plan) args.push('--output', resolve(values.output!));
  else args.push('--diagnose');
  if (values.preflight) args.push('--preflight');
  const child = spawn(python, args, {
    shell: false,
    stdio: ['pipe', 'inherit', 'inherit'],
    env: {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    },
  });
  const interrupt = () => child.kill('SIGINT');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    await new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        process.exitCode = code ?? (signal ? 130 : 1);
        done();
      });
      child.stdin.on('error', () => {}); // Early preflight failure can close stdin.
      child.stdin.end(plan ? JSON.stringify(plan) : '');
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}

main().catch((cause) => {
  console.error(
    cause instanceof Error
      ? `Irodoriの評価を開始できませんでした: ${cause.message}`
      : 'Irodoriの評価を開始できませんでした。',
  );
  process.exitCode = 1;
});
