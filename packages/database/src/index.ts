import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { asc, desc, eq } from 'drizzle-orm';
import type { LibraryItem, LibraryPage, PaletteColor } from '@design-index/shared';
import { migrate } from './migrations.js';
import { assets, items, jobs, paletteColors } from './schema.js';

export interface NewImage {
  id: string;
  title: string;
  note: string;
  contentHash: string;
  width: number;
  height: number;
  original: { path: string; mime: string };
  preview: { path: string; width: number; height: number };
  palette: PaletteColor[];
}

/** Search syntax is plain text, not raw FTS expressions. Never interpolate input into SQL. */
function toFtsQuery(input: string): string | null {
  const words = input.match(/[\p{L}\p{N}_]+/gu);
  return words?.length ? words.map((word) => `"${word}"*`).join(' AND ') : null;
}

export function openLibrary(databasePath: string) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const sqlite = new Database(databasePath);
  try {
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    migrate(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }
  const db = drizzle(sqlite);

  function hydrate(row: typeof items.$inferSelect): LibraryItem {
    const palette = db.select().from(paletteColors).where(eq(paletteColors.itemId, row.id)).orderBy(asc(paletteColors.position)).all();
    return {
      id: row.id, type: row.type, title: row.title, note: row.note, status: row.status,
      capturedAt: row.capturedAt, width: row.width, height: row.height,
      previewUrl: `/api/items/${row.id}/assets/preview`,
      originalUrl: `/api/items/${row.id}/assets/original`,
      palette: palette.map((color) => ({
        hex: color.hex, oklab: [color.l, color.a, color.b], weight: color.weight,
        source: color.source, role: color.role,
      })),
    };
  }

  function getItem(id: string): LibraryItem | undefined {
    const row = db.select().from(items).where(eq(items.id, id)).get();
    return row ? hydrate(row) : undefined;
  }

  function findByHash(hash: string): LibraryItem | undefined {
    const row = db.select().from(items).where(eq(items.contentHash, hash)).get();
    return row ? hydrate(row) : undefined;
  }

  function createImage(input: NewImage): { item: LibraryItem; deduplicated: boolean } {
    return sqlite.transaction(() => {
      const existing = findByHash(input.contentHash);
      if (existing) return { item: existing, deduplicated: true };
      const capturedAt = new Date().toISOString();
      db.insert(items).values({
        id: input.id, type: 'image', title: input.title, note: input.note,
        contentHash: input.contentHash, status: 'queued', capturedAt,
        width: input.width, height: input.height,
      }).run();
      db.insert(assets).values([
        { id: randomUUID(), itemId: input.id, kind: 'original', ...input.original, width: input.width, height: input.height },
        { id: randomUUID(), itemId: input.id, kind: 'preview', mime: 'image/webp', ...input.preview },
      ]).run();
      if (input.palette.length) db.insert(paletteColors).values(input.palette.map((color, position) => ({
        id: randomUUID(), itemId: input.id, hex: color.hex,
        l: color.oklab[0], a: color.oklab[1], b: color.oklab[2],
        weight: color.weight, role: color.role, source: color.source, position,
      }))).run();
      db.insert(jobs).values({ id: randomUUID(), itemId: input.id, kind: 'analyze', status: 'queued', createdAt: capturedAt }).run();
      return { item: getItem(input.id)!, deduplicated: false };
    })();
  }

  function search({ q = '', limit = 50, offset = 0 }: { q?: string; limit?: number; offset?: number } = {}): LibraryPage {
    const fts = toFtsQuery(q);
    if (q && !fts) return { items: [], total: 0, limit, offset };
    if (!fts) {
      const rows = db.select().from(items).orderBy(desc(items.capturedAt), desc(items.id)).limit(limit).offset(offset).all();
      const count = sqlite.prepare('SELECT count(*) AS total FROM items').get() as { total: number };
      return { items: rows.map(hydrate), total: count.total, limit, offset };
    }
    const matches = sqlite.prepare(`
      SELECT items.id FROM items_fts JOIN items ON items.rowid = items_fts.rowid
      WHERE items_fts MATCH ? ORDER BY bm25(items_fts), items.captured_at DESC, items.id DESC LIMIT ? OFFSET ?
    `).all(fts, limit, offset) as { id: string }[];
    const count = sqlite.prepare('SELECT count(*) AS total FROM items_fts WHERE items_fts MATCH ?').get(fts) as { total: number };
    return { items: matches.map(({ id }) => getItem(id)!), total: count.total, limit, offset };
  }

  return {
    getItem, findByHash, createImage, search,
    updateItem(id: string, fields: { title: string; note: string }) {
      db.update(items).set(fields).where(eq(items.id, id)).run();
      return getItem(id);
    },
    getAsset(itemId: string, kind: 'original' | 'preview') {
      return db.select().from(assets).where(eq(assets.itemId, itemId)).all().find((asset) => asset.kind === kind);
    },
    queueCount(): number {
      return (sqlite.prepare("SELECT count(*) AS total FROM jobs WHERE status = 'queued'").get() as { total: number }).total;
    },
    close() {
      if (sqlite.open) {
        sqlite.pragma('wal_checkpoint(TRUNCATE)');
        sqlite.close();
      }
    },
  };
}

export type Library = ReturnType<typeof openLibrary>;
