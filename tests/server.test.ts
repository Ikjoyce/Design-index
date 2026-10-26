import { createServer } from 'node:net';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startServer } from '../apps/server/src/server.js';
import { temporaryLibrary } from './helpers.js';

let directory: string;
let running: Awaited<ReturnType<typeof startServer>> | undefined;

beforeEach(async () => { directory = await temporaryLibrary(); });
afterEach(async () => {
  await running?.stopServer();
  running = undefined;
  await rm(directory, { recursive: true, force: true });
});

async function unusedPort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP port.');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

it('starts a real loopback server, writes a private client token, and stops idempotently', async () => {
  running = await startServer({ libraryDir: directory, port: await unusedPort() });
  expect((await fetch(`${running.url}/api/health`)).status).toBe(200);
  expect((await fetch(`${running.url}/api/items`)).status).toBe(401);
  const connection = JSON.parse(await readFile(join(directory, 'connection.json'), 'utf8')) as { url: string; token: string };
  expect(connection.url).toBe(running.url);
  expect(connection.token).toMatch(/^[a-f0-9]{64}$/);
  const response = await fetch(`${running.url}/api/items`, { headers: { Authorization: `Bearer ${connection.token}` } });
  expect(response.status).toBe(200);
  const stopping = running.stopServer();
  expect(running.stopServer()).toBe(stopping);
  await stopping;
});

it('cleans up a failed listener startup without disturbing the original server', async () => {
  const port = await unusedPort();
  running = await startServer({ libraryDir: directory, port });
  const secondDirectory = join(directory, 'failed-startup');
  await expect(startServer({ libraryDir: secondDirectory, port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect((await fetch(`${running.url}/api/health`)).status).toBe(200);
  // This also proves Windows file handles were closed on the startup error path.
  await rm(secondDirectory, { recursive: true, force: true });
});
