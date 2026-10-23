import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, arch, totalmem } from 'node:os';
import { resolve } from 'node:path';

type Sample = {
  profile: string;
  scenario: { rows: number; seconds: number; sampleRate: number };
  steps: { name: string; elapsedMs: number; longestTaskMs: number; jsHeapUsedBytes: number }[];
};

export default class ScriptBenchmarkReporter implements Reporter {
  samples: Sample[] = [];
  settings: { profile: string; repeatEach: number }[] = [];
  onBegin(config: FullConfig) {
    this.settings = config.projects.map((project) => ({
      profile: project.name,
      repeatEach: project.repeatEach,
    }));
  }
  onTestEnd(_test: TestCase, result: TestResult) {
    if (result.status !== 'passed') return;
    const attachment = result.attachments.find((a) => a.name === 'script-measurements');
    if (attachment)
      this.samples.push(
        JSON.parse(attachment.body?.toString() ?? readFileSync(attachment.path!, 'utf8')),
      );
  }
  onEnd(result: FullResult) {
    const stamp = new Date().toISOString();
    const directory = resolve('.local-artifacts/script-benchmark', stamp.replace(/[:.]/g, '-'));
    mkdirSync(directory, { recursive: true });
    const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    const report = {
      format: 'voice-atlas-script-benchmark',
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
        'Synthetic PCM with mocked generation API; does not measure engine speed or speech quality.',
        'Mobile is Chromium viewport/touch emulation with 4x page CPU slowdown, not a physical mobile device. Worker CPU slowdown is not verified.',
        'Intervals include Playwright actions, scrolling, assertion polling, and two animation frames. Open/restore exclude navigation.',
        'Page JS heap is a checkpoint, not peak process memory; worker heap, Blob, audio decoder, GPU and native allocations are excluded. Storage estimates are approximate.',
        'One worker, fresh browser context per repeat. Repeat counts are in settings and the table. No timing pass/fail thresholds.',
      ],
      samples: this.samples,
    };
    writeFileSync(`${directory}/report.json`, JSON.stringify(report, null, 2));
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const groups = new Map<string, Sample[]>();
    for (const sample of this.samples) {
      const key = `${sample.profile} / ${sample.scenario.rows} rows / ${sample.scenario.seconds}s / ${sample.scenario.sampleRate}Hz`;
      groups.set(key, [...(groups.get(key) ?? []), sample]);
    }
    const lines = [
      '# 台本負荷測定',
      '',
      `日時: ${stamp} / 状態: ${result.status} / revision: ${report.revision} / dirty: ${report.dirty}`,
      '',
      ...report.limitations.map((s) => `- ${s}`),
      '',
      '| 条件 | 操作 | 回数 | 中央値 ms | 最大 ms | 最長メインスレッドタスク ms | 最大観測 JS heap MiB |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
    ];
    for (const [key, samples] of groups) {
      for (const name of samples[0].steps.map((step) => step.name)) {
        const steps = samples.map((sample) => sample.steps.find((step) => step.name === name)!);
        lines.push(
          `| ${key} | ${name} | ${steps.length} | ${median(steps.map((s) => s.elapsedMs)).toFixed(1)} | ${Math.max(...steps.map((s) => s.elapsedMs)).toFixed(1)} | ${Math.max(...steps.map((s) => s.longestTaskMs)).toFixed(1)} | ${(Math.max(...steps.map((s) => s.jsHeapUsedBytes)) / 1024 ** 2).toFixed(1)} |`,
        );
      }
    }
    writeFileSync(`${directory}/report.md`, `${lines.join('\n')}\n`);
    console.log(`\n台本負荷測定: ${directory}/report.md`);
  }
}
