import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
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
