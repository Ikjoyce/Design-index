import type Database from 'better-sqlite3';
import type { InboxImport } from '@design-index/shared';

interface ImportRow {
  source_key: string; directory_key: string; file_name: string; fingerprint: string; status: InboxImport['status'];
  item_id: string | null; deduplicated: number; error: string | null; updated_at: string; retry_at: string | null; attempts: number;
}
export function createInboxStore(sqlite: Database.Database) {
  return {
    entries(directoryKey: string) { return sqlite.prepare('SELECT * FROM inbox_imports WHERE directory_key=?').all(directoryKey) as ImportRow[]; },
    record(input: { sourceKey: string; directoryKey: string; fileName: string; fingerprint: string; itemId?: string; deduplicated?: boolean; error?: string; retryAt?: string }) {
      sqlite.prepare(`INSERT INTO inbox_imports(source_key,directory_key,file_name,fingerprint,status,item_id,deduplicated,error,updated_at,retry_at) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source_key) DO UPDATE SET directory_key=excluded.directory_key,file_name=excluded.file_name,fingerprint=excluded.fingerprint,status=excluded.status,item_id=excluded.item_id,deduplicated=excluded.deduplicated,error=excluded.error,updated_at=excluded.updated_at,retry_at=excluded.retry_at,
          attempts=CASE WHEN inbox_imports.fingerprint=excluded.fingerprint THEN inbox_imports.attempts+1 ELSE 1 END`)
        .run(input.sourceKey, input.directoryKey, input.fileName, input.fingerprint, input.itemId ? 'imported' : 'failed', input.itemId ?? null, input.deduplicated ? 1 : 0, input.error ?? null, new Date().toISOString(), input.retryAt ?? null);
    },
    summary(directoryKey: string) {
      const totals = sqlite.prepare("SELECT count(*) AS total,coalesce(sum(status='imported'),0) AS imported,coalesce(sum(status='failed'),0) AS failed,coalesce(max(updated_at),'') AS latest FROM inbox_imports WHERE directory_key=?").get(directoryKey) as { total: number; imported: number; failed: number; latest: string };
      const recent: InboxImport[] = (sqlite.prepare('SELECT * FROM inbox_imports WHERE directory_key=? ORDER BY updated_at DESC,source_key LIMIT 20').all(directoryKey) as ImportRow[]).map((row) => ({ fileName: row.file_name, status: row.status, itemId: row.item_id, deduplicated: !!row.deduplicated, error: row.error, updatedAt: row.updated_at, retryAt: row.retry_at }));
      return { imported: totals.imported, failed: totals.failed, revision: `${totals.total}:${totals.imported}:${totals.latest}`, recent };
    },
    retryFailures(directoryKey: string) { return sqlite.prepare("UPDATE inbox_imports SET retry_at=?,updated_at=? WHERE directory_key=? AND status='failed'").run(new Date().toISOString(), new Date().toISOString(), directoryKey).changes; },
  };
}
