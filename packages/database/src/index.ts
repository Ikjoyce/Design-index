import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { asc, eq } from 'drizzle-orm';
import type { AssetKind, Facet, LibraryItem, LibraryPage, PageFacts, PaletteColor, PaletteRole } from '@design-index/shared';
import { migrate } from './migrations.js';
import { assets, items, jobs, paletteColors } from './schema.js';
import { createIntelligenceStore } from './intelligence.js';
import { createVocabularyStore } from './vocabulary.js';
import { createCaptureStore } from './captures.js';
import { createEvaluationStore } from './evaluations.js';
import { createInboxStore } from './inbox.js';
export type { EvaluationClaim, TrialInput, TrialMetadata } from './evaluations.js';
export type { CaptureClaim } from './captures.js';
export { ConflictError } from './intelligence.js';
export type { ClaimedJob } from './intelligence.js';

export interface NewImage {
  id: string;
  title: string;
  note: string;
  contentHash: string;
  width: number;
  height: number;
  original: { path: string; mime: string; kind?: AssetKind; width?: number; height?: number };
  preview: { path: string; width: number; height: number };
  palette: PaletteColor[];
  type?: 'image' | 'url';
  sourceUrl?: string;
  facts?: PageFacts;
  additionalAssets?: { kind: AssetKind; path: string; mime: string; width: number; height: number }[];
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
  const vocabulary = createVocabularyStore(sqlite);
  const intelligence = createIntelligenceStore(sqlite, vocabulary);
  const captures = createCaptureStore(sqlite);
  const evaluations = createEvaluationStore(sqlite, vocabulary);
  const inbox = createInboxStore(sqlite);

  function hydrate(row: typeof items.$inferSelect): LibraryItem {
    const palette = db.select().from(paletteColors).where(eq(paletteColors.itemId, row.id)).orderBy(asc(paletteColors.position)).all();
    const info = intelligence.state(row.id);
    const storedAssets = db.select().from(assets).where(eq(assets.itemId, row.id)).all();
    const facts = sqlite.prepare('SELECT json FROM item_facts WHERE item_id=?').get(row.id) as { json: string } | undefined;
    return {
      id: row.id, type: row.type, title: row.title, note: row.note, status: row.status,
      capturedAt: row.capturedAt, width: row.width, height: row.height,
      previewUrl: `/api/items/${row.id}/assets/preview`,
      originalUrl: `/api/items/${row.id}/assets/original`,
      palette: palette.map((color) => ({
        hex: color.hex, oklab: [color.l, color.a, color.b], weight: color.weight,
        source: color.source, role: (Object.entries(info.analysis?.palette_roles ?? {}).find(([, hex]) => hex === color.hex)?.[0] as PaletteRole | undefined) ?? color.role,
      })),
      intelligence: info,
      sourceUrl: row.sourceUrl,
      facts: facts ? JSON.parse(facts.json) : null,
      assets: storedAssets.map((asset) => ({ id: asset.id, kind: asset.kind, url: `/api/items/${row.id}/assets/${asset.kind}`, width: asset.width, height: asset.height })),
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
        id: input.id, type: input.type ?? 'image', title: input.title, note: input.note, sourceUrl: input.sourceUrl,
        contentHash: input.contentHash, status: 'queued', capturedAt,
        width: input.width, height: input.height,
      }).run();
      db.insert(assets).values([
        { id: randomUUID(), itemId: input.id, ...input.original, kind: input.original.kind ?? 'original', width: input.original.width ?? input.width, height: input.original.height ?? input.height },
        { id: randomUUID(), itemId: input.id, kind: 'preview', mime: 'image/webp', ...input.preview },
        ...(input.additionalAssets ?? []).map((asset) => ({ id: randomUUID(), itemId: input.id, ...asset })),
      ]).run();
      if (input.facts) sqlite.prepare('INSERT INTO item_facts VALUES(?,?)').run(input.id, JSON.stringify(input.facts));
      if (input.palette.length) db.insert(paletteColors).values(input.palette.map((color, position) => ({
        id: randomUUID(), itemId: input.id, hex: color.hex,
        l: color.oklab[0], a: color.oklab[1], b: color.oklab[2],
        weight: color.weight, role: color.role, source: color.source, position,
      }))).run();
      db.insert(jobs).values({ id: randomUUID(), itemId: input.id, kind: 'analyze', status: 'queued', createdAt: capturedAt, runId: randomUUID() }).run();
      return { item: getItem(input.id)!, deduplicated: false };
    })();
  }

  function search({ q = '', limit = 50, offset = 0, facet, label }: { q?: string; limit?: number; offset?: number; facet?: Facet; label?: string } = {}): LibraryPage {
    const fts = toFtsQuery(q);
    if (q && !fts) return { items: [], total: 0, limit, offset };
    const from = `FROM items ${fts ? 'JOIN items_fts ON items.rowid=items_fts.rowid' : ''}`;
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (fts) { conditions.push('items_fts MATCH ?'); parameters.push(fts); }
    if (facet && label) {
      const equivalents = vocabulary.equivalents(facet, label);
      const canonical = equivalents[0]!;
      conditions.push(`(EXISTS(SELECT 1 FROM label_overrides o WHERE o.item_id=items.id AND o.facet=? AND o.value=? AND o.state='accepted') OR
        (NOT EXISTS(SELECT 1 FROM label_overrides o WHERE o.item_id=items.id AND o.facet=? AND o.value=?) AND
        EXISTS(SELECT 1 FROM analyses a,json_each(a.result_json,?) j WHERE a.id=items.active_analysis_id AND json_extract(j.value,'$.value') IN (${equivalents.map(() => '?').join(',')}))))`);
      parameters.push(facet, canonical, facet, canonical, `$.labels.${facet}`, ...equivalents);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const matches = sqlite.prepare(`SELECT items.id ${from} ${where} ORDER BY ${fts ? 'bm25(items_fts),' : ''} items.captured_at DESC,items.id DESC LIMIT ? OFFSET ?`).all(...parameters, limit, offset) as { id: string }[];
    const count = sqlite.prepare(`SELECT count(*) AS total ${from} ${where}`).get(...parameters) as { total: number };
    return { items: matches.map(({ id }) => getItem(id)!), total: count.total, limit, offset };
  }

  return {
    getItem, findByHash, createImage, search, intelligence, captures, evaluations, inbox,
    vocabulary: {
      ...vocabulary,
      rename(baseRevision: number, facet: Facet, from: string, to: string) {
        return sqlite.transaction(() => {
          const result = vocabulary.rename(baseRevision, facet, from, to);
          intelligence.reindexAll();
          return result;
        })();
      },
    },
    updateItem(id: string, fields: { title: string; note: string }) {
      db.update(items).set(fields).where(eq(items.id, id)).run();
      return getItem(id);
    },
    getAsset(itemId: string, kind: AssetKind) {
      const rows = db.select().from(assets).where(eq(assets.itemId, itemId)).all();
      return rows.find((asset) => asset.kind === kind) ?? (kind === 'original' ? rows.find((asset) => asset.kind === 'full_page') : undefined);
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
