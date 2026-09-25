import { defineConfig } from '@playwright/test';

// Started by `node run.mjs` (npm run e2e at the repo root), which provides the E2E_* environment.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_UI_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 900 }
  },
  outputDir: './test-results'
});
