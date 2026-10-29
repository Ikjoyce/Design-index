import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Library } from '@design-index/database';
import { MAX_UPLOAD_BYTES } from '@design-index/shared';
import type { InboxStatus } from '@design-index/shared';
import { InvalidImageError, saveImage } from './images.js';

const MAX_ENTRIES = 10_000;
const MAX_IMPORTS_PER_SCAN = 8;
const supported = (name: string) => !name.startsWith('.') && /\.(png|jpe?g|webp)$/i.test(name);
const normalizedPath = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = (stat: Stats) => JSON.stringify([stat.dev, stat.ino, stat.size, stat.birthtimeMs, stat.mtimeMs, stat.ctimeMs]);
const overlaps = (parent: string, child: string) => { const path = relative(normalizedPath(parent), normalizedPath(child)); return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`); };
class UnstableFile extends Error {}
export class InboxConfigurationError extends Error {}

/** Polling avoids dropped fs.watch events on Windows. The source folder is read-only intake:
 * only app-owned copies and the durable SQLite import ledger are written by this worker. */
export function createInboxService(options: { library: Library; libraryDir: string; inboxDir?: string | null; intervalMs?: number; settleMs?: number }) {
  const directory = options.inboxDir ? resolve(options.inboxDir) : null;
  const directoryKey = directory ? hash(normalizedPath(directory)) : '';
  const store = options.library.inbox;
  const observations = new Map<string, { fingerprint: string; since: number }>();
  let interval: NodeJS.Timeout | undefined, active: Promise<void> | undefined;
  let stopping = false, pending = 0, lastScanAt: string | null = null, error: string | null = null;

  async function readStableFile(path: string, expected: Stats, root: string): Promise<Buffer> {
    if (expected.size > MAX_UPLOAD_BYTES) throw new InvalidImageError('Image exceeds the 20 MiB inbox limit.');
    if (normalizedPath(dirname(await realpath(path))) !== normalizedPath(root)) throw new UnstableFile();
    // O_NOFOLLOW is supported on Unix. On Windows also compare the opened handle's identity
    // with lstat before/after reading, instead of trusting a directory entry alone.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || fingerprint(before) !== fingerprint(expected)) throw new UnstableFile();
      const buffer = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
        if (!bytesRead) break;
        count += bytesRead;
      }
      const after = await handle.stat(), current = await lstat(path);
      if (count !== before.size || !current.isFile() || current.isSymbolicLink() || fingerprint(after) !== fingerprint(before) || fingerprint(current) !== fingerprint(before)) throw new UnstableFile();
      return buffer.subarray(0, count);
    } finally { await handle.close(); }
  }

  async function scan() {
    if (!directory || stopping) return;
    if (overlaps(directory, options.libraryDir) || overlaps(options.libraryDir, directory)) throw new InboxConfigurationError('The inbox must be separate from the managed library folder.');
    await mkdir(directory, { recursive: true });
    const rootStat = await lstat(directory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new InboxConfigurationError('Use a regular inbox directory, not a symbolic link or junction.');
    const root = await realpath(directory), libraryRoot = await realpath(options.libraryDir);
    if (overlaps(root, libraryRoot) || overlaps(libraryRoot, root)) throw new InboxConfigurationError('The inbox must be separate from the managed library folder.');
    const names: string[] = [];
    let entries = 0;
    for await (const entry of await opendir(directory)) {
      if (++entries > MAX_ENTRIES) throw new InboxConfigurationError('The inbox has more than 10,000 entries. Move older source files elsewhere; library references are kept.');
      if (entry.isFile() && !entry.isSymbolicLink() && supported(entry.name)) names.push(entry.name);
    }
    const records = new Map(store.entries(directoryKey).map((row) => [row.source_key, row]));
    const present = new Set(names);
    for (const name of observations.keys()) if (!present.has(name)) observations.delete(name);
    const ready: { name: string; stat: Stats; sourceKey: string; fingerprint: string; attempts: number }[] = [];
    pending = 0;
    for (const name of names.sort()) {
      if (stopping) break;
      try {
        const stat = await lstat(join(directory, name));
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const signature = fingerprint(stat), sourceKey = hash(`${directoryKey}\0${process.platform === 'win32' ? name.toLowerCase() : name}`);
        const previous = records.get(sourceKey);
        if (previous?.fingerprint === signature && (previous.status === 'imported' || !previous.retry_at || Date.parse(previous.retry_at) > Date.now())) continue;
        pending++;
        const observation = observations.get(name);
        if (!observation || observation.fingerprint !== signature) { observations.set(name, { fingerprint: signature, since: Date.now() }); continue; }
        if (Date.now() - observation.since >= (options.settleMs ?? 1500)) ready.push({ name, stat, sourceKey, fingerprint: signature, attempts: previous?.fingerprint === signature ? previous.attempts : 0 });
      } catch { /* A file still being copied, replaced, or locked is reconsidered on the next scan. */ }
    }
    error = null;
    for (const file of ready.slice(0, MAX_IMPORTS_PER_SCAN)) {
      if (stopping) break;
      const record = { sourceKey: file.sourceKey, directoryKey, fileName: file.name, fingerprint: file.fingerprint };
      try {
        const bytes = await readStableFile(join(directory, file.name), file.stat, root);
        const title = basename(file.name, extname(file.name)).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 160) || 'Untitled reference';
        const result = await saveImage(options.library, options.libraryDir, bytes, { title, note: '' });
        store.record({ ...record, itemId: result.item.id, deduplicated: result.deduplicated });
        pending--;
      } catch (failure) {
        const code = (failure as NodeJS.ErrnoException).code;
        if (failure instanceof UnstableFile || code === 'ENOENT' || code === 'ELOOP') { observations.delete(file.name); continue; }
        const invalid = failure instanceof InvalidImageError;
        const retryAt = invalid ? undefined : new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(file.attempts + 1, 6))).toISOString();
        store.record({ ...record, error: invalid ? failure.message : 'Could not read or save this image. Check file permissions and free space; it will retry automatically.', retryAt });
        pending--;
      }
    }
  }
  function runOnce(): Promise<void> {
    active ??= scan().catch((failure) => { error = failure instanceof InboxConfigurationError ? failure.message : 'Folder inbox is unavailable. Check that the folder exists, permissions allow access, and storage has free space.'; })
      .finally(() => { if (directory) lastScanAt = new Date().toISOString(); active = undefined; });
    return active;
  }
  function wake() { if (interval && !stopping) void runOnce(); }
  function status(): InboxStatus {
    return { enabled: !!directory, directory, scanning: !!active, pending, lastScanAt, error,
      ...(directory ? store.summary(directoryKey) : { imported: 0, failed: 0, revision: '', recent: [] }) };
  }
  return {
    status, runOnce,
    retryFailures() { if (!directory) throw new InboxConfigurationError('Folder inbox is disabled. Configure DESIGN_INDEX_INBOX_DIR and restart the server.'); store.retryFailures(directoryKey); wake(); return status(); },
    start() { if (!directory || interval || stopping) return; interval = setInterval(wake, options.intervalMs ?? 2000); interval.unref(); wake(); },
    async stop() { stopping = true; if (interval) clearInterval(interval); await active; },
  };
}
export type InboxService = ReturnType<typeof createInboxService>;
