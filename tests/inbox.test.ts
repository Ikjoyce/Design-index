import { mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInboxService } from '../apps/server/src/inbox.js';
import { createAiService } from '../apps/server/src/ai.js';
import { createApp } from '../apps/server/src/app.js';
import { readConfig } from '../apps/server/src/config.js';
import * as images from '../apps/server/src/images.js';
import { openLibrary } from '../packages/database/src/index.js';
import type { Library } from '../packages/database/src/index.js';
import { MAX_UPLOAD_BYTES } from '../packages/shared/src/browser.js';
import { analysisFixture, promptFixture } from './analysis-fixtures.js';
import { imageFixture, temporaryLibrary } from './helpers.js';

let root: string, libraryDir: string, inboxDir: string, library: Library, service: ReturnType<typeof createInboxService>;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  root = await temporaryLibrary(); libraryDir = join(root, 'library'); inboxDir = join(root, 'inbox');
  await mkdir(inboxDir); library = openLibrary(join(libraryDir, 'design-index.sqlite'));
  service = createInboxService({ library, libraryDir, inboxDir, settleMs: 20 });
});
afterEach(async () => { await service.stop(); library.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
async function settled() { await service.runOnce(); vi.setSystemTime(Date.now() + 25); await service.runOnce(); }

describe('folder inbox', () => {
  it('imports pre-existing and newly dropped images, preserving source files and deriving a title', async () => {
    const bytes = await imageFixture(); const path = join(inboxDir, 'Quiet dashboard.PNG');
    await writeFile(path, bytes); const before = await stat(path);
    await service.runOnce(); expect(library.search().total).toBe(0); expect(service.status().pending).toBe(1);
    vi.setSystemTime(Date.now() + 25); await service.runOnce();
    const item = library.search().items[0]!;
    expect(item.title).toBe('Quiet dashboard'); expect(item.status).toBe('queued'); expect(item.note).toBe('');
    expect(await readFile(path)).toEqual(bytes); expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
    expect(service.status()).toMatchObject({ enabled: true, directory: inboxDir, pending: 0, imported: 1, failed: 0, error: null });
    expect(library.intelligence.settings().allowImageSharing).toBe(false); expect(library.intelligence.usage().calls).toBe(0);
    await writeFile(join(inboxDir, 'Another.jpg'), await imageFixture('#102030')); await settled();
    expect(library.search().total).toBe(2); expect(library.intelligence.queueCount()).toBe(2);
  });
  it('deduplicates across upload/drop/rename and preserves manual notes without adding analysis jobs', async () => {
    const bytes = await imageFixture();
    const item = (await images.saveImage(library, libraryDir, bytes, { title: 'Edited title', note: 'Keep my note' })).item;
    await writeFile(join(inboxDir, 'duplicate.png'), bytes); await settled();
    expect(service.status().recent[0]).toMatchObject({ itemId: item.id, deduplicated: true, status: 'imported' });
    await rename(join(inboxDir, 'duplicate.png'), join(inboxDir, 'renamed.webp')); await settled();
    expect(library.getItem(item.id)).toEqual(item); expect(library.intelligence.queueCount()).toBe(1);
    expect(library.search().total).toBe(1);
  });
  it('persists import fingerprints across server/library restarts without decoding unchanged files again', async () => {
    await writeFile(join(inboxDir, 'persist.png'), await imageFixture()); await settled();
    const before = library.search().items;
    await service.stop(); library.close(); library = openLibrary(join(libraryDir, 'design-index.sqlite'));
    const save = vi.spyOn(images, 'saveImage');
    service = createInboxService({ library, libraryDir, inboxDir, settleMs: 20 }); await settled();
    expect(save).not.toHaveBeenCalled(); expect(library.search().items).toEqual(before);
    expect(service.status().imported).toBe(1);
  });
  it('waits for changing/partially copied files, then reconsiders replaced contents without overwriting old references', async () => {
    const path = join(inboxDir, 'changing.png'); const bytes = await imageFixture();
    await writeFile(path, bytes.subarray(0, 10)); await service.runOnce();
    vi.setSystemTime(Date.now() + 10); await writeFile(path, bytes); await service.runOnce();
    vi.setSystemTime(Date.now() + 10); await service.runOnce(); expect(library.search().total).toBe(0);
    vi.setSystemTime(Date.now() + 15); await service.runOnce(); expect(library.search().total).toBe(1);
    const first = library.search().items[0]!;
    await writeFile(path, await imageFixture('#197151')); await utimes(path, new Date(), new Date(Date.now() + 1000)); await settled();
    expect(library.search().total).toBe(2); expect(library.getItem(first.id)).toEqual(first);
  });
  it('ignores hidden files, temporary files and nested folders, and imports atomic temp-file renames', async () => {
    const bytes = await imageFixture();
    await mkdir(join(inboxDir, 'nested')); await writeFile(join(inboxDir, 'nested', 'nested.png'), bytes);
    for (const name of ['.hidden.png', 'temp.png.part', 'README.md', 'unsupported.gif']) await writeFile(join(inboxDir, name), bytes);
    await settled(); expect(library.search().total).toBe(0);
    await rename(join(inboxDir, 'temp.png.part'), join(inboxDir, 'complete.png')); await settled();
    expect(library.search().items[0]?.title).toBe('complete');
    await rm(join(inboxDir, 'complete.png')); await service.runOnce(); expect(library.search().total).toBe(1);
  });
  it('records invalid images once, does not spin on failure, and supports explicit retry and corrected files', async () => {
    const path = join(inboxDir, 'broken.png'); await writeFile(path, 'not a raster image');
    const save = vi.spyOn(images, 'saveImage'); await settled();
    expect(service.status()).toMatchObject({ imported: 0, failed: 1 }); expect(service.status().recent[0]?.error).toContain('PNG');
    await settled(); expect(save).toHaveBeenCalledTimes(1);
    service.retryFailures(); await service.runOnce(); expect(save).toHaveBeenCalledTimes(2);
    await writeFile(path, await imageFixture()); await settled();
    expect(service.status()).toMatchObject({ imported: 1, failed: 0 }); expect(library.search().total).toBe(1);
  });
  it('retries transient storage failures with backoff without leaking raw paths or errors', async () => {
    await writeFile(join(inboxDir, 'recover.png'), await imageFixture());
    const save = vi.spyOn(images, 'saveImage').mockRejectedValueOnce(new Error('private path or secret must not escape'));
    await settled(); expect(service.status().recent[0]?.retryAt).not.toBeNull();
    expect(JSON.stringify(service.status())).not.toContain('secret must not escape');
    await service.runOnce(); expect(save).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2100); await service.runOnce();
    expect(save).toHaveBeenCalledTimes(2); expect(service.status().failed).toBe(0); expect(library.search().total).toBe(1);
  });
  it('enforces compressed size limits before reading/decoding inbox images and for direct image saves', async () => {
    const bytes = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    await writeFile(join(inboxDir, 'too-big.png'), bytes); const save = vi.spyOn(images, 'saveImage'); await settled();
    expect(save).not.toHaveBeenCalled(); expect(service.status().recent[0]?.error).toContain('20 MiB');
    await expect(images.saveImage(library, libraryDir, bytes, { title: 'Too big', note: '' })).rejects.toThrow('20 MiB');
  });
  it('bounds decoding work per scan and serializes overlapping scan requests', async () => {
    for (let index = 0; index < 10; index++) await writeFile(join(inboxDir, `image-${index}.png`), await imageFixture(`#${(index * 10000 + 1000).toString(16).padStart(6, '0')}`));
    await service.runOnce(); vi.setSystemTime(Date.now() + 25);
    const first = service.runOnce(); expect(service.runOnce()).toBe(first); await first;
    expect(library.search().total).toBe(8); expect(service.status().pending).toBe(2);
    await service.runOnce(); expect(library.search().total).toBe(10); expect(service.status().pending).toBe(0);
  });
  it('ignores directory junctions and refuses a linked root or overlapping managed storage', async () => {
    const external = join(root, 'outside'); await mkdir(external); await writeFile(join(external, 'outside.png'), await imageFixture());
    await symlink(external, join(inboxDir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await settled(); expect(library.search().total).toBe(0);
    await service.stop();
    service = createInboxService({ library, libraryDir, inboxDir: join(inboxDir, 'link') }); await service.runOnce();
    expect(service.status().error).toContain('symbolic link');
    await service.stop(); service = createInboxService({ library, libraryDir, inboxDir: libraryDir }); await service.runOnce();
    expect(service.status().error).toContain('separate');
  });
  it('does not follow a symlink pretending to be an inbox image', async ({ skip }) => {
    const external = join(root, 'private.png'); await writeFile(external, await imageFixture());
    try { await symlink(external, join(inboxDir, 'linked.png'), 'file'); }
    catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'EPERM') { skip(); return; } throw failure; }
    await settled(); expect(library.search().total).toBe(0);
  });
  it('continues past one bad file and does not change imported items when source files disappear', async () => {
    await writeFile(join(inboxDir, 'a-bad.png'), 'bad'); await writeFile(join(inboxDir, 'z-good.png'), await imageFixture()); await settled();
    expect(service.status()).toMatchObject({ failed: 1, imported: 1 });
    await rm(join(inboxDir, 'z-good.png')); await service.runOnce(); expect(library.search().total).toBe(1);
  });
  it('stops cleanly and does not import after shutdown', async () => {
    await writeFile(join(inboxDir, 'stop.png'), await imageFixture()); await service.runOnce(); await service.stop();
    vi.setSystemTime(Date.now() + 100); await service.runOnce(); expect(library.search().total).toBe(0);
  });
  it('feeds the existing consent-gated analysis → prompt pipeline exactly once', async () => {
    let calls = 0;
    const ai = createAiService({ library, libraryDir, apiKey: 'synthetic-only', provider: { generate: async (request) => { calls++; return { output: request.stage === 'analyze' ? analysisFixture() : promptFixture(), inputTokens: 100, outputTokens: 100 }; } } });
    try {
      await writeFile(join(inboxDir, 'agents.png'), await imageFixture()); await settled();
      await ai.runOnce(); expect(calls).toBe(0);
      ai.updateSettings({ ...ai.status().settings, allowImageSharing: true });
      await ai.runOnce(); await ai.runOnce();
      expect(library.search().items[0]).toMatchObject({ status: 'ready' }); expect(calls).toBe(2);
      await settled(); await ai.runOnce(); expect(calls).toBe(2);
    } finally { await ai.stop(); }
  });
  it('protects inbox status/retry endpoints and cannot change the watched path through the browser', async () => {
    const app = createApp({ library, libraryDir, token: 'test-token', port: 4317, inbox: service });
    const url = 'http://127.0.0.1:4317/api/inbox'; const headers = { Authorization: 'Bearer test-token' };
    expect((await app.request(url)).status).toBe(401);
    expect((await app.request(`${url}/retry`, { method: 'POST' })).status).toBe(401);
    expect((await app.request(url, { method: 'PUT', headers })).status).toBe(404);
    expect((await app.request(url, { headers })).status).toBe(200);
    expect((await app.request(`${url}/retry`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } })).status).toBe(403);
    const disabled = createApp({ library, libraryDir, token: 'test-token', port: 4317 });
    expect((await (await disabled.request(url, { headers })).json()).enabled).toBe(false);
    expect((await disabled.request(`${url}/retry`, { method: 'POST', headers })).status).toBe(400);
  });
});

describe('inbox configuration', () => {
  it('defaults the standard entrypoint to the project inbox while allowing an absolute override or off', () => {
    vi.stubEnv('DESIGN_INDEX_INBOX_DIR', ''); expect(readConfig().inboxDir).toBe(resolve('inbox'));
    vi.stubEnv('DESIGN_INDEX_INBOX_DIR', inboxDir); expect(readConfig().inboxDir).toBe(inboxDir);
    vi.stubEnv('DESIGN_INDEX_INBOX_DIR', 'off'); expect(readConfig().inboxDir).toBeNull();
    vi.stubEnv('DESIGN_INDEX_INBOX_DIR', 'relative/inbox'); expect(() => readConfig()).toThrow(/absolute/);
  });
});
