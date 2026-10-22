import { defineConfig, devices } from '@playwright/test';

// Kept outside the normal E2E suite: timings need an idle, single-worker browser.
export default defineConfig({
  testDir: './benchmarks',
  testMatch: 'script-load.spec.ts',
  fullyParallel: false,
  workers: 1,
  repeatEach: 3,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['./benchmarks/reporter.ts']],
  outputDir: '.local-artifacts/script-benchmark/runs',
  use: { baseURL: 'http://127.0.0.1:3212', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run start',
    url: 'http://127.0.0.1:3212/api/health',
    reuseExistingServer: false,
    env: {
      PORT: '3212',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      OLLAMA_BASE_URL: 'http://127.0.0.1:1',
      VOICEVOX_BASE_URL: 'http://127.0.0.1:1',
      AIVIS_BASE_URL: 'http://127.0.0.1:1',
    },
  },
});
