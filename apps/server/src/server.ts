import { randomBytes } from 'node:crypto';
import { Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { openLibrary } from '@design-index/database';
import { createApp } from './app.js';

export async function startServer(options: { libraryDir: string; port: number; webDir?: string; development?: boolean }) {
  await mkdir(options.libraryDir, { recursive: true });
  const library = openLibrary(join(options.libraryDir, 'design-index.sqlite'));
  const token = randomBytes(32).toString('hex');
  const app = createApp({ ...options, library, token });
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: options.port });
  if (server instanceof Server) {
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    await writeFile(join(options.libraryDir, 'connection.json'), JSON.stringify({
      url: `http://127.0.0.1:${options.port}`, token,
    }, null, 2), { mode: 0o600 });
  } catch (error) {
    server.close();
    library.close();
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${options.port}`,
    libraryDir: options.libraryDir,
    stopServer(): Promise<void> {
      // Closing the listener drains active requests before closing SQLite.
      stopping ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          try { library.close(); } catch (closeError) { reject(closeError); return; }
          if (error) reject(error);
          else resolve();
        });
      });
      return stopping;
    },
  };
}
