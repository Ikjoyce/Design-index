import type Database from 'better-sqlite3';
import { VOCABULARY } from '@design-index/shared';

export const migrations = [
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
  `
  CREATE TABLE ai_settings (id INTEGER PRIMARY KEY CHECK(id = 1), json TEXT NOT NULL);
  INSERT INTO ai_settings VALUES (1, '{"enabled":false,"allowImageSharing":false,"analyzeModel":"claude-haiku-5-5","promptModel":"claude-sonnet-5-5","monthlyBudgetUsd":0}');
  CREATE TABLE analyses (
    id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL, prompt_version TEXT NOT NULL, cache_key TEXT NOT NULL UNIQUE,
    result_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE prompts (
    id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    analysis_id TEXT NOT NULL REFERENCES analyses(id), model_id TEXT NOT NULL,
    body TEXT NOT NULL, assumptions_json TEXT NOT NULL, edited_by_user INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL, cache_key TEXT UNIQUE, created_at TEXT NOT NULL,
    UNIQUE(item_id, version)
  );
  CREATE TABLE label_overrides (
    item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, facet TEXT NOT NULL,
    value TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('accepted', 'rejected')),
    PRIMARY KEY(item_id, facet, value)
  );
  ALTER TABLE items ADD COLUMN active_analysis_id TEXT REFERENCES analyses(id);
  ALTER TABLE items ADD COLUMN search_text TEXT NOT NULL DEFAULT '';

  ALTER TABLE jobs RENAME TO jobs_v1;
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('analyze', 'write_prompt')),
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    run_id TEXT NOT NULL, analysis_id TEXT REFERENCES analyses(id),
    lease_token TEXT, lease_until TEXT, error TEXT,
    UNIQUE(item_id, kind)
  );
  INSERT INTO jobs(id,item_id,kind,status,attempts,created_at,run_id)
    SELECT id,item_id,kind,CASE WHEN status = 'running' THEN 'failed' ELSE status END,attempts,created_at,lower(hex(randomblob(16))) FROM jobs_v1;
  DROP TABLE jobs_v1;
  CREATE INDEX jobs_queue ON jobs(status,created_at,id);
  CREATE TABLE model_calls (
    id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES items(id),
    stage TEXT NOT NULL, model_id TEXT NOT NULL, month TEXT NOT NULL, created_at TEXT NOT NULL,
    reserved_usd REAL NOT NULL CHECK(reserved_usd >= 0), accounted_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER, output_tokens INTEGER,
    state TEXT NOT NULL CHECK(state IN ('reserved','completed','uncertain'))
  );
  CREATE INDEX calls_month ON model_calls(month,state);

  DROP TRIGGER items_fts_insert;
  DROP TRIGGER items_fts_delete;
  DROP TRIGGER items_fts_update;
  DROP TABLE items_fts;
  CREATE VIRTUAL TABLE items_fts USING fts5(title,note,search_text,content='items',content_rowid='rowid',tokenize='unicode61');
  CREATE TRIGGER items_fts_insert AFTER INSERT ON items BEGIN
    INSERT INTO items_fts(rowid,title,note,search_text) VALUES(new.rowid,new.title,new.note,new.search_text);
  END;
  CREATE TRIGGER items_fts_delete AFTER DELETE ON items BEGIN
    INSERT INTO items_fts(items_fts,rowid,title,note,search_text) VALUES('delete',old.rowid,old.title,old.note,old.search_text);
  END;
  CREATE TRIGGER items_fts_update AFTER UPDATE ON items BEGIN
    INSERT INTO items_fts(items_fts,rowid,title,note,search_text) VALUES('delete',old.rowid,old.title,old.note,old.search_text);
    INSERT INTO items_fts(rowid,title,note,search_text) VALUES(new.rowid,new.title,new.note,new.search_text);
  END;
  INSERT INTO items_fts(items_fts) VALUES('rebuild');
  `,
  `
  -- Switching provider requires fresh consent; never silently use Console/Sonnet with a Go key.
  UPDATE ai_settings SET json=json_set(json,'$.enabled',json('false'),'$.allowImageSharing',json('false'),'$.analyzeModel','claude-haiku-5-5','$.promptModel','claude-haiku-5-5');
  ALTER TABLE analyses ADD COLUMN provider TEXT NOT NULL DEFAULT 'opencode-console';
  ALTER TABLE prompts ADD COLUMN provider TEXT NOT NULL DEFAULT 'opencode-console';
  ALTER TABLE model_calls ADD COLUMN provider TEXT NOT NULL DEFAULT 'opencode-console';
  `,
  `
  UPDATE ai_settings SET json=json_set(json,'$.allowModelTraining',json('false'));
  `,
  `
  CREATE TABLE vocabulary_revisions (
    revision INTEGER PRIMARY KEY AUTOINCREMENT, terms_json TEXT NOT NULL, created_at TEXT NOT NULL
  );
  INSERT INTO vocabulary_revisions(terms_json,created_at) VALUES('${JSON.stringify(VOCABULARY).replaceAll("'", "''")}',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  CREATE TABLE vocabulary_aliases (
    facet TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
    revision INTEGER NOT NULL REFERENCES vocabulary_revisions(revision), PRIMARY KEY(facet,source), CHECK(source != target)
  );
  ALTER TABLE analyses ADD COLUMN vocabulary_revision INTEGER NOT NULL DEFAULT 1;

  ALTER TABLE prompts RENAME TO prompts_before_variants;
  CREATE TABLE prompts (
    id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    analysis_id TEXT NOT NULL REFERENCES analyses(id), model_id TEXT NOT NULL,
    body TEXT NOT NULL, assumptions_json TEXT NOT NULL, edited_by_user INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL, cache_key TEXT UNIQUE, created_at TEXT NOT NULL,
    provider TEXT NOT NULL, variant TEXT NOT NULL CHECK(variant IN ('agent','general','vibe')),
    UNIQUE(item_id,variant,version)
  );
  INSERT INTO prompts SELECT id,item_id,analysis_id,model_id,body,assumptions_json,edited_by_user,version,cache_key,created_at,provider,'agent' FROM prompts_before_variants;
  DROP TABLE prompts_before_variants;

  ALTER TABLE jobs RENAME TO jobs_before_variants;
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('analyze','write_prompt')),
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
    attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
    run_id TEXT NOT NULL, analysis_id TEXT REFERENCES analyses(id), lease_token TEXT, lease_until TEXT, error TEXT,
    variant TEXT NOT NULL DEFAULT 'agent' CHECK(variant IN ('agent','general','vibe')),
    UNIQUE(item_id,kind,variant)
  );
  INSERT INTO jobs SELECT id,item_id,kind,status,attempts,created_at,run_id,analysis_id,lease_token,lease_until,error,'agent' FROM jobs_before_variants;
  DROP TABLE jobs_before_variants;
  CREATE INDEX jobs_queue ON jobs(status,created_at,id);
  ALTER TABLE model_calls ADD COLUMN variant TEXT NOT NULL DEFAULT 'agent' CHECK(variant IN ('agent','general','vibe'));
  `,
  `
  ALTER TABLE items ADD COLUMN source_url TEXT;
  ALTER TABLE assets RENAME TO assets_before_capture;
  CREATE TABLE assets (
    id TEXT PRIMARY KEY NOT NULL, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('original','preview','full_page','viewport','mobile','element_crop')),
    path TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, width INTEGER NOT NULL,height INTEGER NOT NULL, UNIQUE(item_id,kind)
  );
  INSERT INTO assets SELECT * FROM assets_before_capture;
  DROP TABLE assets_before_capture;
  CREATE TABLE item_facts(item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,json TEXT NOT NULL);
  CREATE TABLE capture_settings(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
  INSERT INTO capture_settings VALUES(1,'{"approvedLocalOrigins":[]}');
  CREATE TABLE captures(
    id TEXT PRIMARY KEY,request_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
    error TEXT,item_id TEXT REFERENCES items(id),deduplicated INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,
    lease_token TEXT,lease_until TEXT
  );
  CREATE TABLE evaluation_samples(
    item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,labels_json TEXT NOT NULL,facets_json TEXT NOT NULL,note TEXT NOT NULL,version INTEGER NOT NULL
  );
  CREATE TABLE evaluation_runs(
    id TEXT PRIMARY KEY,name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','completed','cancelled')),
    created_at TEXT NOT NULL,vocabulary_revision INTEGER NOT NULL,model_ids_json TEXT NOT NULL,sample_count INTEGER NOT NULL,upper_usd REAL NOT NULL
  );
  CREATE TABLE evaluation_trials(
    id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES evaluation_runs(id),item_id TEXT NOT NULL REFERENCES items(id),model_id TEXT NOT NULL,title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
    input_text TEXT NOT NULL,palette_json TEXT NOT NULL,vocabulary_json TEXT NOT NULL,gold_json TEXT NOT NULL,facets_json TEXT NOT NULL,
    result_json TEXT,schema_valid INTEGER,valid INTEGER,latency_ms INTEGER,error TEXT,lease_token TEXT,lease_until TEXT,
    metadata_json TEXT NOT NULL,raw_output_json TEXT,
    UNIQUE(run_id,item_id,model_id)
  );
  CREATE INDEX trials_queue ON evaluation_trials(status,run_id,id);
  CREATE INDEX calls_job ON model_calls(job_id);
  `,
  `
  CREATE TABLE inbox_imports (
    source_key TEXT PRIMARY KEY NOT NULL, directory_key TEXT NOT NULL, file_name TEXT NOT NULL,
    fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('imported','failed')),
    item_id TEXT REFERENCES items(id), deduplicated INTEGER NOT NULL DEFAULT 0,
    error TEXT, updated_at TEXT NOT NULL, retry_at TEXT, attempts INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX inbox_directory ON inbox_imports(directory_key,updated_at DESC,source_key);
  `,
  `
  -- Processing is automatic with sharing consent. Go owns all allowance/billing limits.
  -- Historical call/run dollar columns remain untouched as archived records, not controls.
  UPDATE ai_settings SET json=json_remove(json,'$.enabled','$.monthlyBudgetUsd');
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
