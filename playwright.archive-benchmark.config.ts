import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './benchmarks',
  testMatch: 'archive-load.spec.ts',
  fullyParallel: false,
  workers: 1,
  repeatEach: 3,
  retries: 0,
  timeout: 180_000,
  reporter: [['list'], ['./benchmarks/archive-reporter.ts']],
  outputDir: '.local-artifacts/archive-benchmark/runs',
  use: { baseURL: 'http://127.0.0.1:3213', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:3213/api/health',
    reuseExistingServer: false,
    env: {
      PORT: '3213',
      VOICE_ATLAS_ARCHIVE_BENCHMARK: '1',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      OLLAMA_BASE_URL: 'http://127.0.0.1:1',
      VOICEVOX_BASE_URL: 'http://127.0.0.1:1',
      AIVIS_BASE_URL: 'http://127.0.0.1:1',
    },
  },
});
