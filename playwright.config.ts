import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  outputDir: join(tmpdir(), 'opencode', `design-index-playwright-${Date.now()}`),
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chrome',
    baseURL: 'http://127.0.0.1:14317',
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node tests/start-e2e-server.mjs',
    url: 'http://127.0.0.1:14317/api/health',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
