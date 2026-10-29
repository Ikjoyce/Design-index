import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CaptureJob, CaptureSettings, UrlCaptureRequest } from '@design-index/shared';
import { ConflictError } from './errors.js';

export type CaptureClaim = { id: string; lease_token: string; request: UrlCaptureRequest };
export function createCaptureStore(sqlite: Database.Database) {
  const map = (row: { id: string; request_json: string; status: CaptureJob['status']; error: string | null; item_id: string | null; deduplicated: number; created_at: string }): CaptureJob => ({ ...JSON.parse(row.request_json), id: row.id, status: row.status, error: row.error, itemId: row.item_id, deduplicated: !!row.deduplicated, createdAt: row.created_at });
  return {
    owns(job: CaptureClaim): boolean { return !!sqlite.prepare("SELECT 1 FROM captures WHERE id=? AND status='running' AND lease_token=? AND lease_until>?").get(job.id, job.lease_token, new Date().toISOString()); },
    settings(): CaptureSettings { return JSON.parse((sqlite.prepare('SELECT json FROM capture_settings WHERE id=1').get() as { json: string }).json); },
    setSettings(value: CaptureSettings) { sqlite.prepare('UPDATE capture_settings SET json=? WHERE id=1').run(JSON.stringify(value)); },
    list(): CaptureJob[] { return (sqlite.prepare('SELECT * FROM captures ORDER BY created_at DESC,id DESC LIMIT 20').all() as Parameters<typeof map>[0][]).map(map); },
    queue(request: UrlCaptureRequest): CaptureJob {
      return sqlite.transaction(() => {
        const pending = (sqlite.prepare("SELECT count(*) AS count FROM captures WHERE status IN ('queued','running')").get() as { count: number }).count;
        if (pending >= 20) throw new ConflictError('Capture queue is full (20 pending). Wait for captures to finish.');
        const id = randomUUID(), created = new Date().toISOString();
        sqlite.prepare("INSERT INTO captures(id,request_json,status,created_at) VALUES(?,?,'queued',?)").run(id, JSON.stringify(request), created);
        return { ...request, id, status: 'queued' as const, error: null, itemId: null, deduplicated: false, createdAt: created };
      })();
    },
    claim(): CaptureClaim | undefined {
      return sqlite.transaction(() => {
        sqlite.prepare("UPDATE captures SET status='failed',error='Interrupted capture. Queue the URL again to retry.',lease_token=NULL,lease_until=NULL WHERE status='running' AND lease_until<=?").run(new Date().toISOString());
        const row = sqlite.prepare("SELECT id,request_json FROM captures WHERE status='queued' ORDER BY created_at,id LIMIT 1").get() as { id: string; request_json: string } | undefined;
        if (!row) return undefined;
        const token = randomUUID();
        sqlite.prepare("UPDATE captures SET status='running',lease_token=?,lease_until=? WHERE id=?").run(token, new Date(Date.now() + 90_000).toISOString(), row.id);
        return { id: row.id, lease_token: token, request: JSON.parse(row.request_json) };
      })();
    },
    finish(job: CaptureClaim, result: { itemId: string; deduplicated: boolean } | { error: string }) {
      if ('error' in result) sqlite.prepare("UPDATE captures SET status='failed',error=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").run(result.error, job.id, job.lease_token);
      else sqlite.prepare("UPDATE captures SET status='completed',item_id=?,deduplicated=?,error=NULL,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").run(result.itemId, result.deduplicated ? 1 : 0, job.id, job.lease_token);
    },
    cancel(id: string) { sqlite.prepare("UPDATE captures SET status='failed',error='Capture cancelled.',lease_token=NULL,lease_until=NULL WHERE id=? AND status IN ('queued','running')").run(id); },
  };
}
