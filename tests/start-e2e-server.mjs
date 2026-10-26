import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../apps/server/dist/server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = join(tmpdir(), 'opencode');
await mkdir(temporaryRoot, { recursive: true });
const libraryDir = await mkdtemp(join(temporaryRoot, 'design-index-e2e-'));
const running = await startServer({ libraryDir, port: 14317, webDir: join(root, 'apps', 'web', 'dist') });
console.log(`Isolated test library: ${running.url}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await running.stopServer();
    await rm(libraryDir, { recursive: true, force: true });
    process.exit(0);
  });
}
