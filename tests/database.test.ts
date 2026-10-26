import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openLibrary } from '../packages/database/src/index.js';
import type { Library, NewImage } from '../packages/database/src/index.js';
import { temporaryLibrary } from './helpers.js';

let directory: string;
let library: Library;

beforeEach(async () => {
  directory = await temporaryLibrary();
  library = openLibrary(join(directory, 'design-index.sqlite'));
});
afterEach(async () => { library.close(); await rm(directory, { recursive: true, force: true }); });

function record(title = 'Editorial landing', note = 'Lovely type pairing'): NewImage {
  const id = randomUUID();
  return {
    id, title, note, contentHash: id, width: 100, height: 80,
    original: { path: `images/${id}/original.png`, mime: 'image/png' },
    preview: { path: `images/${id}/preview.webp`, width: 100, height: 80 },
    palette: [{ hex: '#000000', oklab: [0, 0, 0], weight: 1, role: null, source: 'pixels' }],
  };
}

describe('SQLite library', () => {
  it('persists an item, its palette, its assets, and a queued job across restarts', () => {
    const saved = library.createImage(record());
    expect(saved.item.status).toBe('queued');
    expect(library.queueCount()).toBe(1);
    expect(library.getAsset(saved.item.id, 'original')?.mime).toBe('image/png');
    library.close();
    library = openLibrary(join(directory, 'design-index.sqlite'));
    expect(library.getItem(saved.item.id)).toEqual(saved.item);
    expect(library.queueCount()).toBe(1);
  });

  it('deduplicates without overwriting manual notes or adding jobs', () => {
    const input = record();
    const first = library.createImage(input);
    const duplicate = library.createImage({ ...input, id: randomUUID(), title: 'Another title', note: 'Do not replace me' });
    expect(duplicate).toEqual({ ...first, deduplicated: true });
    expect(library.search().total).toBe(1);
    expect(library.queueCount()).toBe(1);
  });

  it('keeps title/note full-text search in sync with edits', () => {
    const { item } = library.createImage(record());
    expect(library.search({ q: 'editor type' }).items[0]?.id).toBe(item.id);
    library.updateItem(item.id, { title: 'Warm dashboard', note: 'Soft geometry' });
    expect(library.search({ q: 'editorial' }).total).toBe(0);
    expect(library.search({ q: 'warm geo' }).total).toBe(1);
    expect(library.search({ q: 'warm missing' }).total).toBe(0);
  });

  it('treats search as plain text, never SQL or raw FTS operators', () => {
    library.createImage(record('A quote " and a dash', 'Pricing table'));
    expect(library.search({ q: '"pricing"' }).total).toBe(1);
    expect(library.search({ q: '*:()' }).total).toBe(0);
    expect(() => library.search({ q: "'; DROP TABLE items; --" })).not.toThrow();
    expect(library.search().total).toBe(1);
  });

  it('paginates with a stable order', () => {
    for (let index = 0; index < 5; index++) library.createImage(record(`Reference ${index}`));
    const first = library.search({ limit: 2 });
    const second = library.search({ limit: 2, offset: 2 });
    expect(first.total).toBe(5);
    expect(first.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
  });

  it('rolls back the entire record if an asset constraint fails', () => {
    const input = record();
    expect(() => library.createImage({ ...input, preview: { ...input.preview, path: input.original.path } })).toThrow();
    expect(library.search().total).toBe(0);
    expect(library.queueCount()).toBe(0);
  });

  it('refuses databases written by a newer application', () => {
    const futurePath = join(directory, 'future.sqlite');
    const future = new Database(futurePath);
    future.pragma('user_version = 999');
    future.close();
    expect(() => openLibrary(futurePath)).toThrow(/newer/);
  });
});
