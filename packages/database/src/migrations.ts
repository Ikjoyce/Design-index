import type Database from 'better-sqlite3';

const migrations = [
  `
  CREATE TABLE items (
    id TEXT PRIMARY KEY NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('image', 'url', 'element')),
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('queued', 'analyzing', 'writing_prompt', 'ready', 'needs_review')),
    captured_at TEXT NOT NULL,
    width INTEGER NOT NULL CHECK(width > 0),
    height INTEGER NOT NULL CHECK(height > 0)
  );
  CREATE INDEX items_captured_at ON items(captured_at DESC, id DESC);
  CREATE TABLE assets (
    id TEXT PRIMARY KEY NOT NULL,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('original', 'preview')),
    path TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    UNIQUE(item_id, kind)
  );
  CREATE TABLE palette_colors (
    id TEXT PRIMARY KEY NOT NULL,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    hex TEXT NOT NULL,
    l REAL NOT NULL, a REAL NOT NULL, b REAL NOT NULL,
    role TEXT CHECK(role IS NULL OR role IN ('background','surface','text','muted-text','accent','border')),
    weight REAL NOT NULL CHECK(weight >= 0 AND weight <= 1),
    source TEXT NOT NULL CHECK(source IN ('pixels', 'css')),
    position INTEGER NOT NULL
  );
  CREATE INDEX palette_item ON palette_colors(item_id, position);
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY NOT NULL,
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind = 'analyze'),
    status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(item_id, kind)
  );
  CREATE VIRTUAL TABLE items_fts USING fts5(title, note, content='items', content_rowid='rowid', tokenize='unicode61');
  CREATE TRIGGER items_fts_insert AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid, title, note) VALUES (new.rowid, new.title, new.note);
  END;
  CREATE TRIGGER items_fts_delete AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, title, note) VALUES ('delete', old.rowid, old.title, old.note);
  END;
  CREATE TRIGGER items_fts_update AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts(items_fts, rowid, title, note) VALUES ('delete', old.rowid, old.title, old.note);
    INSERT INTO items_fts(rowid, title, note) VALUES (new.rowid, new.title, new.note);
  END;
  `,
];

export function migrate(database: Database.Database): void {
  const version = database.pragma('user_version', { simple: true }) as number;
  if (version > migrations.length) throw new Error('Library database is newer than this application.');
  migrations.slice(version).forEach((migration, offset) => {
    database.transaction(() => {
      database.exec(migration);
      database.pragma(`user_version = ${version + offset + 1}`);
    })();
  });
}
