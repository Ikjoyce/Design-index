import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'threads',
    maxWorkers: 4,
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
