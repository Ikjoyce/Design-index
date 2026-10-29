import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createCaptureService, saveCapturedPage } from '../apps/server/src/capture.js';
import { createApp } from '../apps/server/src/app.js';
import type { CapturedPage } from '../packages/capture/src/index.js';
import { openLibrary } from '../packages/database/src/index.js';
import type { Library } from '../packages/database/src/index.js';
import type { UrlCaptureRequest } from '../packages/shared/src/browser.js';
import { imageFixture, temporaryLibrary } from './helpers.js';

let library: Library, directory: string, captured: CapturedPage, service: ReturnType<typeof createCaptureService>;
const request: UrlCaptureRequest = { url: 'https://example.com/design', title: '', note: 'Saved for typography', colorScheme: 'dark' };
beforeEach(async () => {
  directory = await temporaryLibrary(); library = openLibrary(join(directory, 'design-index.sqlite'));
  const png = await imageFixture();
  captured = { title: 'Captured fixture', finalUrl: request.url, fullPage: png, viewport: png, mobile: png,
    facts: { fonts: ['Arial'], styles: [], colors: [{ hex: '#7C5CFF', weight: 1 }], animations: [], transitions: [], libraries: [], warnings: [], truncated: false } };
  service = createCaptureService({ library, libraryDir: directory, port: 14317, capturer: { capture: async () => captured } });
});
afterEach(async () => { await service.stop(); library.close(); await rm(directory, { recursive: true, force: true }); });

it('persists three untouched views and CSS-first palette without calling AI', async () => {
  const queued = service.queue(request); await service.runOnce();
  const result = service.list().find((job) => job.id === queued.id)!;
  expect(result.status).toBe('completed');
  const item = library.getItem(result.itemId!)!;
  expect(item).toMatchObject({ type: 'url', title: 'Captured fixture', note: request.note, sourceUrl: request.url, facts: captured.facts });
  expect(item.assets.map((asset) => asset.kind).sort()).toEqual(['full_page', 'mobile', 'preview', 'viewport']);
  expect(item.palette[0]).toMatchObject({ hex: '#7C5CFF', source: 'css' });
  expect(library.getAsset(item.id, 'original')?.kind).toBe('full_page');
  expect(library.intelligence.usage().calls).toBe(0);
  expect(library.intelligence.queueCount()).toBe(1);
});

it('deduplicates unchanged captures while preserving edits and does not create orphan files', async () => {
  const first = await saveCapturedPage(library, directory, captured, request);
  library.updateItem(first.item.id, { title: 'My edited title', note: 'Keep my note' });
  const second = await saveCapturedPage(library, directory, captured, request);
  expect(second.deduplicated).toBe(true); expect(second.item.title).toBe('My edited title');
  expect(await readdir(join(directory, 'images'))).toHaveLength(1);
  await expect(saveCapturedPage(library, directory, { ...captured, finalUrl: 'https://example.com/other' }, request, () => false)).rejects.toThrow(/cancelled/);
  expect(await readdir(join(directory, 'images'))).toHaveLength(1);
});

it('protects all library ports and accepts only exact local approvals', () => {
  for (const port of [4317, 5173, 14317]) expect(() => service.updateSettings({ approvedLocalOrigins: [`http://localhost:${port}`] })).toThrow(/library/);
  expect(() => service.queue({ ...request, url: 'http://localhost:3000' })).toThrow();
  service.updateSettings({ approvedLocalOrigins: ['http://localhost:3000/'] });
  expect(service.settings().approvedLocalOrigins).toEqual(['http://localhost:3000']);
  expect(service.queue({ ...request, url: 'http://localhost:3000/page' }).status).toBe('queued');
});

it('bounds queues and recovers interrupted captures without stale ownership', () => {
  const queued = service.queue(request), claim = library.captures.claim()!;
  const db = new Database(join(directory, 'design-index.sqlite'));
  db.prepare("UPDATE captures SET lease_until='2000-01-01' WHERE id=?").run(queued.id); db.close();
  expect(library.captures.claim()).toBeUndefined();
  expect(library.captures.owns(claim)).toBe(false);
  expect(service.list()[0]?.error).toContain('Interrupted');
  for (let index = 0; index < 20; index++) service.queue(request);
  expect(() => service.queue(request)).toThrow(/full/);
});

it('cancels a running capture and does not save late browser results', async () => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  service = createCaptureService({ library, libraryDir: directory, port: 14317, capturer: { capture: async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return captured; } } });
  const job = service.queue(request); const work = service.runOnce(); await started;
  service.cancel(job.id); release(); await work;
  expect(service.list()[0]).toMatchObject({ status: 'failed', error: 'Capture cancelled.', itemId: null });
  expect(library.search({}).total).toBe(0);
});

it('authenticates capture APIs and serves captured assets without proxying source URLs', async () => {
  const app = createApp({ library, libraryDir: directory, port: 4317, token: 'test-token', captures: service });
  expect((await app.request('http://127.0.0.1:4317/api/captures')).status).toBe(401);
  const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  expect((await app.request('http://127.0.0.1:4317/api/captures', { method: 'POST', headers, body: JSON.stringify({ ...request, url: 'http://169.254.169.254' }) })).status).toBe(400);
  const response = await app.request('http://127.0.0.1:4317/api/captures', { method: 'POST', headers, body: JSON.stringify(request) });
  expect(response.status).toBe(202); await service.runOnce();
  const itemId = service.list()[0]!.itemId;
  for (const kind of ['full_page', 'mobile', 'viewport', 'original']) {
    const asset = await app.request(`http://127.0.0.1:4317/api/items/${itemId}/assets/${kind}`, { headers });
    expect(asset.status).toBe(200); expect(Buffer.from(await asset.arrayBuffer())).toEqual(captured.viewport);
  }
});
