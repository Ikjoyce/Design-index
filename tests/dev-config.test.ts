import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { expect, it } from 'vitest';
import config from '../apps/web/vite.config.js';
import serverPackage from '../apps/server/package.json';

it('uses native Node watch with the TypeScript loader for the API development entrypoint', () => {
  expect(serverPackage.scripts.dev).toBe('node --watch --env-file-if-exists=../../.env --import tsx src/index.ts');
});

it('keeps the disposable Vite cache outside the checkout so Windows cleanup locks cannot block startup', async () => {
  if (typeof config !== 'function') throw new Error('Expected a Vite config factory.');
  const resolved = await config({ command: 'serve', mode: 'development' });
  expect(resolved.cacheDir).toBeTruthy();
  const withinTemporaryRoot = relative(join(tmpdir(), 'opencode', 'design-index-vite'), resolved.cacheDir!);
  expect(withinTemporaryRoot.startsWith('..')).toBe(false);
  expect(isAbsolute(withinTemporaryRoot)).toBe(false);
  expect(resolved.server?.host).toBe('127.0.0.1');
  expect(resolved.server?.strictPort).toBe(true);
});
