import { readFile, stat } from 'node:fs/promises';
import { arch, platform, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import type { IrodoriEvaluationConfig } from '../shared/irodori-evaluation';

type Memory = {
  processMaxRssBytes?: number | null;
  mpsDriverAllocatedBytes?: number | null;
  cudaPeakAllocatedBytes?: number | null;
};
type Sample = { elapsedMs?: number; durationSeconds?: number; memory?: Memory };
type Run = {
  format: string;
  version: number;
  status: string;
  plan: { config: IrodoriEvaluationConfig };
  machine?: { platform?: string; arch?: string };
  assets?: { checkpoint?: { sha256?: string } };
  afterLoadMemory?: Memory;
  samples: Sample[];
};

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function max(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length ? Math.max(...present) : null;
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function difference(current: number | null, first: number | null, comparable: boolean) {
  return comparable && current !== null && first !== null ? current - first : null;
}
function currentPlatformName() {
  return platform() === 'darwin' ? 'Darwin' : platform() === 'linux' ? 'Linux' : platform();
}

export async function readIrodoriRun(path: string): Promise<{ directory: string; run: Run }> {
  const directory = resolve(path);
  const file = join(directory, 'manifest.json');
  const details = await stat(file);
  if (details.size > 8 * 1024 * 1024) throw new Error('manifest.jsonは8MiB以下にしてください。');
  const run = JSON.parse(await readFile(file, 'utf8')) as Run;
  if (
    run.format !== 'voice-atlas-irodori-run' ||
    run.version !== 1 ||
    !Array.isArray(run.samples) ||
    !run.plan?.config?.device ||
    !run.plan.config.mode
  )
    throw new Error(`${file}: Irodori評価ランv1の記録ではありません。`);
  return { directory, run };
}

export function summarizeRun(directory: string, run: Run) {
  const memories = [run.afterLoadMemory, ...run.samples.map((sample) => sample.memory)];
  const elapsed = run.samples
    .map((sample) => finite(sample.elapsedMs))
    .filter((n): n is number => n !== null);
  const seconds = run.plan.config.seconds ?? 30;
  return {
    directory,
    status: run.status,
    mode: run.plan.config.mode,
    device: run.plan.config.device,
    generationCapSeconds: seconds,
    completedSamples: run.samples.length,
    medianGenerationMs: median(elapsed),
    maxObservedMpsDriverAllocatedBytes: max(
      memories.map((item) => finite(item?.mpsDriverAllocatedBytes)),
    ),
    maxObservedCudaPeakAllocatedBytes: max(
      memories.map((item) => finite(item?.cudaPeakAllocatedBytes)),
    ),
    maxObservedProcessRssBytes: max(memories.map((item) => finite(item?.processMaxRssBytes))),
    checkpointSha256: run.assets?.checkpoint?.sha256 ?? null,
    machine: run.machine ?? null,
  };
}

export async function memoryReport(paths: string[]) {
  if (!paths.length) throw new Error('比較するランを1件以上指定してください。');
  const runs = await Promise.all(paths.map(readIrodoriRun));
  const summaries = runs.map(({ directory, run }) => summarizeRun(directory, run));
  const first = summaries[0];
  const comparisons = summaries.slice(1).map((current) => {
    const reasons: string[] = [];
    if (current.mode !== first.mode || current.device !== first.device)
      reasons.push('mode/deviceが異なる');
    if (
      current.machine?.platform !== first.machine?.platform ||
      current.machine?.arch !== first.machine?.arch
    )
      reasons.push('OS/CPU構成が異なる');
    if (!current.checkpointSha256 || current.checkpointSha256 !== first.checkpointSha256)
      reasons.push('checkpointが異なるか未確認');
    if (current.generationCapSeconds !== first.generationCapSeconds)
      reasons.push('生成枠の秒数が異なる');
    if (current.status !== 'completed' || first.status !== 'completed')
      reasons.push('未完了のランが含まれる');
    return {
      baseline: first.directory,
      current: current.directory,
      comparable: reasons.length === 0,
      reasons,
      medianGenerationMsDifference: difference(
        current.medianGenerationMs,
        first.medianGenerationMs,
        reasons.length === 0,
      ),
      maxObservedMpsDriverAllocatedBytesDifference: difference(
        current.maxObservedMpsDriverAllocatedBytes,
        first.maxObservedMpsDriverAllocatedBytes,
        reasons.length === 0,
      ),
      maxObservedCudaPeakAllocatedBytesDifference: difference(
        current.maxObservedCudaPeakAllocatedBytes,
        first.maxObservedCudaPeakAllocatedBytes,
        reasons.length === 0,
      ),
      maxObservedProcessRssBytesDifference: difference(
        current.maxObservedProcessRssBytes,
        first.maxObservedProcessRssBytes,
        reasons.length === 0,
      ),
    };
  });
  return {
    format: 'voice-atlas-irodori-memory-report',
    version: 1,
    host: { platform: platform(), arch: arch(), physicalMemoryBytes: totalmem() },
    runs: summaries,
    comparisons,
    note: 'MPSは生成直後の観測値でピークではありません。RSSとMPSは重複し得るため合算しません。CUDAはtorch割り当てピークです。異なるモデル・端末・生成枠の値は直接比較できません。',
  };
}

export async function baselineWarnings(path: string, config: IrodoriEvaluationConfig) {
  const { directory, run } = await readIrodoriRun(path);
  const summary = summarizeRun(directory, run);
  if (summary.completedSamples === 0) throw new Error('基準ランには完成した音声がありません。');
  if (summary.device !== config.device || summary.mode !== config.mode)
    throw new Error('基準ランと今回のdevice/modeが異なります。');
  const warnings: string[] = [];
  const sameHost = run.machine?.platform === currentPlatformName() && run.machine.arch === arch();
  if (!sameHost)
    warnings.push('基準ランと現在のOSまたはCPU構成が異なり、メモリー観測値は直接比較できません。');
  if (run.plan.config.checkpoint !== config.checkpoint)
    warnings.push('基準ランと今回のcheckpointパスが異なり、メモリー観測値は直接比較できません。');
  if (summary.status !== 'completed')
    warnings.push('基準ランは未完了です。保存された音声までの観測値だけを使います。');
  if (config.seconds > summary.generationCapSeconds)
    warnings.push(
      `今回の生成枠${config.seconds}秒は基準ランの${summary.generationCapSeconds}秒より長く、負荷は未測定です。`,
    );
  if (sameHost && config.device === 'mps' && summary.maxObservedMpsDriverAllocatedBytes !== null) {
    const proportion = summary.maxObservedMpsDriverAllocatedBytes / totalmem();
    if (proportion >= 0.65)
      warnings.push(
        `基準ランのMPSドライバー割り当て最大観測値は物理メモリーの約${Math.round(proportion * 100)}%です。ピークや総使用量ではなく、長い生成でメモリー圧縮・swapが増える可能性があります。`,
      );
  }
  return { baseline: summary, warnings };
}
