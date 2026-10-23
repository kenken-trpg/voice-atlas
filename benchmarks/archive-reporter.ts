import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { resolve } from 'node:path';

type Step = {
  name: string;
  elapsedMs: number;
  longestTaskMs: number;
  jsHeapUsedBytes: number | null;
  storageUsageBytes: number | null;
};
type Sample = {
  profile: string;
  scenario: { rows: number; seconds: number; sampleRate: number };
  browser: string;
  cpuSlowdown: number;
  inputAudioBytes: number;
  archiveBytes: number;
  steps: Step[];
};

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[at] : (sorted[at - 1] + sorted[at]) / 2;
}
function mib(value: number | null) {
  return value === null ? 'n/a' : (value / 1024 ** 2).toFixed(1);
}

export default class ArchiveBenchmarkReporter implements Reporter {
  private samples: Sample[] = [];
  private settings: { profile: string; repeatEach: number }[] = [];
  private failed: string[] = [];
  onBegin(config: FullConfig) {
    this.settings = config.projects.map((project) => ({
      profile: project.name,
      repeatEach: project.repeatEach,
    }));
  }
  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== 'passed') {
      this.failed.push(`${test.titlePath().join(' / ')}: ${result.status}`);
      return;
    }
    const attachment = result.attachments.find((item) => item.name === 'archive-measurements');
    if (!attachment) {
      this.failed.push(`${test.titlePath().join(' / ')}: 測定結果なし`);
      return;
    }
    this.samples.push(
      JSON.parse(attachment.body?.toString() ?? readFileSync(attachment.path!, 'utf8')),
    );
  }
  onEnd(result: FullResult) {
    const stamp = new Date().toISOString();
    const directory = resolve('.local-artifacts/archive-benchmark', stamp.replace(/[:.]/g, '-'));
    mkdirSync(directory, { recursive: true });
    const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    const report = {
      format: 'voice-atlas-archive-benchmark',
      version: 1,
      createdAt: stamp,
      status: result.status,
      revision: git(['rev-parse', 'HEAD']),
      dirty: Boolean(git(['status', '--porcelain'])),
      settings: this.settings,
      environment: {
        node: process.version,
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      limitations: [
        'Synthetic PCM in Chromium with the real archive functions and IndexedDB; no TTS engine or audio listening.',
        'Functions are loaded from the Vite development server. Timings exclude UI clicks, download transfer, module loading, and WAV generation.',
        'Mobile is iPhone 13 viewport/touch emulation with 4x page CPU slowdown, not a physical phone. IndexedDB and browser internals may not be throttled equally.',
        'JS heap is a checkpoint and excludes Blob backing, IndexedDB, browser native memory and peak process memory. Storage usage is a browser estimate.',
        'Each run has a fresh browser context. Measurements include two animation frames and observer delivery; no universal pass/fail time threshold.',
      ],
      failed: this.failed,
      samples: this.samples,
    };
    writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2));
    const groups = new Map<string, Sample[]>();
    for (const sample of this.samples) {
      const key = `${sample.profile} / ${sample.scenario.rows}行×${sample.scenario.seconds}秒 / ${sample.scenario.sampleRate}Hz`;
      groups.set(key, [...(groups.get(key) ?? []), sample]);
    }
    const lines = [
      '# 音声入り作品アーカイブ負荷測定',
      '',
      `日時: ${stamp} / 状態: ${result.status} / revision: ${report.revision} / dirty: ${report.dirty}`,
      '',
      ...report.limitations.map((value) => `- ${value}`),
      '',
      '| 条件 | 入力音声 MiB | アーカイブ MiB | 操作 | 回数 | 中央値 ms | 最大 ms | 最長メインスレッドタスク ms | 最大観測 JS heap MiB | 最大保存使用量 MiB |',
      '| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ];
    for (const [key, samples] of groups) {
      for (const name of samples[0].steps.map((step) => step.name)) {
        const steps = samples.map((sample) => sample.steps.find((step) => step.name === name)!);
        const present = (field: 'jsHeapUsedBytes' | 'storageUsageBytes') =>
          steps.map((step) => step[field]).filter((value): value is number => value !== null);
        const heaps = present('jsHeapUsedBytes'),
          storage = present('storageUsageBytes');
        lines.push(
          `| ${key} | ${mib(samples[0].inputAudioBytes)} | ${mib(samples[0].archiveBytes)} | ${name} | ${steps.length} | ${median(steps.map((step) => step.elapsedMs)).toFixed(1)} | ${Math.max(...steps.map((step) => step.elapsedMs)).toFixed(1)} | ${Math.max(...steps.map((step) => step.longestTaskMs)).toFixed(1)} | ${mib(heaps.length ? Math.max(...heaps) : null)} | ${mib(storage.length ? Math.max(...storage) : null)} |`,
        );
      }
    }
    if (this.failed.length)
      lines.push('', '失敗または未測定:', ...this.failed.map((value) => `- ${value}`));
    writeFileSync(`${directory}/report.md`, `${lines.join('\n')}\n`);
    console.log(`\nアーカイブ負荷測定: ${directory}/report.md`);
  }
}
