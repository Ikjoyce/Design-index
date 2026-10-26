import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.js';
import { startServer } from './server.js';

const config = readConfig();
const running = await startServer({
  ...config,
  development: process.env.NODE_ENV !== 'production' && import.meta.url.endsWith('.ts'),
  webDir: resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
});
console.log(`Design Index API: ${running.url}`);
console.log(`Library folder: ${running.libraryDir}`);
console.log('AI analysis is not configured. Image capture and palettes work offline.');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    running.stopServer().then(() => process.exit(0)).catch(() => {
      console.error('Could not close the library cleanly.');
      process.exit(1);
    });
  });
}
