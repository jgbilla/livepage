// End-to-end smoke tests: `pnpm test:e2e`.
//
// Locally this starts `pnpm dev:memory` (throwaway in-memory database) unless something is already
// listening on 5173. CI starts the production build against a real Postgres first and sets
// LIVEPAGE_BASE, so no server is started here.
import { defineConfig, devices } from '@playwright/test';

const base = process.env.LIVEPAGE_BASE ?? 'http://localhost:5173';

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]] : 'list',
  outputDir: 'e2e-results',
  use: {
    baseURL: base,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    storageState: 'e2e-results/.auth/a.json', // Writer A (see e2e/global-setup.ts)
  },
  webServer: process.env.LIVEPAGE_BASE
    ? undefined
    : { command: 'pnpm dev:memory', url: `${base}/api/health`, reuseExistingServer: true, timeout: 120_000 },
});
