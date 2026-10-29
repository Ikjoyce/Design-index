import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.js';
import { startServer } from './server.js';

const config = readConfig();
const running = await startServer({
  ...config,
  aiKey: process.env.OPENCODE_GO_API_KEY?.trim() || process.env.ZEN_API_KEY?.trim(),
  refreshModelsOnStart: true,
  development: process.env.NODE_ENV !== 'production' && import.meta.url.endsWith('.ts'),
  webDir: resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
});
console.log(`Design Index API: ${running.url}`);
console.log(`Library folder: ${running.libraryDir}`);
console.log(config.inboxDir ? `Image inbox: ${config.inboxDir}` : 'Image inbox is disabled.');
console.log('New inspiration is processed automatically once sharing consent is saved. Usage limits are managed by OpenCode Go.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    running.stopServer().then(() => process.exit(0)).catch(() => {
      console.error('Could not close the library cleanly.');
      process.exit(1);
    });
  });
}
