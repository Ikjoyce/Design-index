import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibrary } from '../packages/database/src/index.js';
import type { Library } from '../packages/database/src/index.js';
import { createApp } from '../apps/server/src/app.js';
import { MAX_UPLOAD_BYTES } from '../packages/shared/src/index.js';
import type { CaptureResult } from '../packages/shared/src/index.js';
import { imageFixture, temporaryLibrary } from './helpers.js';

const base = 'http://127.0.0.1:4317';
const token = 'test-token-not-a-real-credential';
let directory: string;
let library: Library;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  directory = await temporaryLibrary();
  library = openLibrary(join(directory, 'design-index.sqlite'));
  app = createApp({ library, libraryDir: directory, token, port: 4317 });
});
afterEach(async () => { library.close(); await rm(directory, { recursive: true, force: true }); });

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return app.request(`${base}${path}`, { ...init, headers });
}

async function upload(bytes?: Buffer, fields: { title?: string; note?: string } = {}) {
  const body = new FormData();
  const input = bytes ?? await imageFixture();
  body.set('image', new File([new Uint8Array(input)], '../../escape.png', { type: 'image/png' }));
  body.set('title', fields.title ?? 'A purple reference');
  body.set('note', fields.note ?? 'Beautiful accent');
  return request('/api/items', { method: 'POST', body });
}

describe('local security boundary', () => {
  it('exposes only health and session bootstrap without authentication', async () => {
    expect((await app.request(`${base}/api/health`)).status).toBe(200);
    expect((await app.request(`${base}/api/items`)).status).toBe(401);
    expect((await app.request(`${base}/api/status`)).status).toBe(401);
    const session = await app.request(`${base}/api/session`);
    const cookie = session.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(await session.json()).toEqual({ ready: true });
    expect((await app.request(`${base}/api/items`, { headers: { Cookie: cookie.split(';')[0]! } })).status).toBe(200);
  });

  it('rejects foreign origins and DNS rebinding hosts even with a token', async () => {
    for (const path of ['/api/session', '/api/items']) {
      expect((await request(path, { headers: { Origin: 'https://malicious.example' } })).status).toBe(403);
      expect((await request(path, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
      expect((await request(path, { headers: { Host: 'malicious.example:4317' } })).status).toBe(403);
    }
  });

  it('allows the exact local origin but does not advertise CORS', async () => {
    const response = await request('/api/items', { headers: { Origin: base } });
    expect(response.status).toBe(200);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('image intake and retrieval', () => {
  it('preserves original bytes, extracts an exact fixture palette, and serves authenticated previews', async () => {
    const original = await imageFixture();
    const response = await upload(original);
    expect(response.status).toBe(201);
    const { item, deduplicated } = await response.json() as CaptureResult;
    expect(deduplicated).toBe(false);
    expect(item.status).toBe('queued');
    expect(item.palette[0]?.hex).toBe('#7C5CFF');
    expect(item.palette[0]?.role).toBeNull();
    expect(item.width).toBe(48);
    expect(item.height).toBe(32);
    const asset = library.getAsset(item.id, 'original')!;
    expect(await readFile(join(directory, asset.path))).toEqual(original);
    expect((await app.request(`${base}${item.previewUrl}`)).status).toBe(401);
    const preview = await request(item.previewUrl);
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/webp');
    const downloaded = await request(item.originalUrl);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(original);
    expect(downloaded.headers.get('content-disposition')).toContain('attachment');
    expect((await request(`/images/${item.id}/original.png`)).status).toBe(404);
    const css = await request(`/api/items/${item.id}/palette.css`);
    expect(await css.text()).toContain('--color-1: #7C5CFF');
    const status = await request('/api/status');
    expect(await status.json()).toMatchObject({ queued: 1, analysis: 'not_configured' });
  });

  it('deduplicates identical uploads and never replaces the first note', async () => {
    const first = await (await upload()).json() as CaptureResult;
    const response = await upload(undefined, { title: 'Different', note: 'Do not replace' });
    expect(response.status).toBe(200);
    const duplicate = await response.json() as CaptureResult;
    expect(duplicate.item.id).toBe(first.item.id);
    expect(duplicate.item.note).toBe('Beautiful accent');
    expect(duplicate.deduplicated).toBe(true);
    expect(await readdir(join(directory, 'images'))).toHaveLength(1);
    expect(library.queueCount()).toBe(1);
  });

  it('handles concurrent duplicates without leaving a second directory', async () => {
    const bytes = await imageFixture();
    const results = await Promise.all([upload(bytes), upload(bytes)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 201]);
    expect(library.search().total).toBe(1);
    expect(await readdir(join(directory, 'images'))).toHaveLength(1);
  });

  it('validates actual bytes, not a filename or declared MIME', async () => {
    const response = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'));
    expect(response.status).toBe(422);
    expect((await upload(Buffer.from('not an image'))).status).toBe(422);
    expect(library.search().total).toBe(0);
  });

  it('rejects transparent and truncated captures', async () => {
    const transparent = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#00000000' } }).png().toBuffer();
    expect((await upload(transparent)).status).toBe(422);
    const image = await imageFixture();
    expect((await upload(image.subarray(0, image.length / 2))).status).toBe(422);
  });

  it('accepts JPEG/WebP bytes regardless of the supplied filename and MIME', async () => {
    const fixture = await imageFixture();
    for (const format of ['jpeg', 'webp'] as const) {
      const encoded = await sharp(fixture).toFormat(format).toBuffer();
      const response = await upload(encoded);
      expect(response.status).toBe(201);
      const { item } = await response.json() as CaptureResult;
      expect(library.getAsset(item.id, 'original')?.mime).toBe(`image/${format}`);
    }
  });

  it('corrects EXIF orientation in previews while keeping original bytes unchanged', async () => {
    const original = await sharp(await imageFixture()).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const response = await upload(original);
    expect(response.status).toBe(201);
    const { item } = await response.json() as CaptureResult;
    expect([item.width, item.height]).toEqual([32, 48]);
    const preview = await request(item.previewUrl);
    const metadata = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
    expect([metadata.width, metadata.height]).toEqual([32, 48]);
    expect(Buffer.from(await (await request(item.originalUrl)).arrayBuffer())).toEqual(original);
  });

  it('rejects a decompression-bomb header without allocating the decoded image', async () => {
    const bytes = await imageFixture();
    bytes.writeUInt32BE(10_000, 16);
    bytes.writeUInt32BE(10_000, 20);
    let crc = 0xFFFFFFFF;
    for (const byte of bytes.subarray(12, 29)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
    }
    bytes.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0, 29);
    expect((await upload(bytes)).status).toBe(422);
    expect(library.search().total).toBe(0);
  });

  it('rejects oversized bodies before decoding', async () => {
    const response = await request('/api/items', { method: 'POST', headers: { 'Content-Length': String(MAX_UPLOAD_BYTES + 100_000) }, body: 'too large' });
    expect(response.status).toBe(413);
    expect(library.search().total).toBe(0);
  });

  it('validates title/note fields, edits records, and searches new notes', async () => {
    expect((await upload(undefined, { title: 'x'.repeat(161) })).status).toBe(400);
    const { item } = await (await upload()).json() as CaptureResult;
    const updated = await request(`/api/items/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'New title', note: 'Rounded corners' }) });
    expect(updated.status).toBe(200);
    expect(library.search({ q: 'round' }).total).toBe(1);
    expect(library.search({ q: 'beautiful' }).total).toBe(0);
    expect((await request(`/api/items/${item.id}`, { method: 'PATCH', body: '{}' })).status).toBe(400);
    expect((await request(`/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Missing note' }) })).status).toBe(400);
    expect(library.getItem(item.id)?.note).toBe('Rounded corners');
    expect((await request('/api/items?limit=-1')).status).toBe(400);
    expect((await request(`/api/items?q=${'x'.repeat(201)}`)).status).toBe(400);
  });

  it('returns clean errors for missing files and unknown items', async () => {
    expect((await request('/api/items/missing')).status).toBe(404);
    const { item } = await (await upload()).json() as CaptureResult;
    const asset = library.getAsset(item.id, 'preview')!;
    await rm(join(directory, asset.path));
    const missing = await request(item.previewUrl);
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain(directory.replaceAll('\\', '\\\\'));
  });
});
