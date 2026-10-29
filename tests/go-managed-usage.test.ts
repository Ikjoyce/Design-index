import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { openLibrary } from '../packages/database/src/index.js';
import { migrations } from '../packages/database/src/migrations.js';
import { createAiService } from '../apps/server/src/ai.js';
import { temporaryLibrary } from './helpers.js';

it('upgrades a paused, zero-budget library to automatic processing without changing consent, models, or historical data', async () => {
  const directory = await temporaryLibrary(), path = join(directory, 'library.sqlite');
  const legacy = new Database(path);
  let library: ReturnType<typeof openLibrary> | undefined;
  try {
    for (const migration of migrations.slice(0, 7)) legacy.exec(migration);
    legacy.pragma('user_version=7');
    legacy.prepare('UPDATE ai_settings SET json=? WHERE id=1').run(JSON.stringify({ enabled: false, monthlyBudgetUsd: 0, allowImageSharing: true, allowModelTraining: true, analyzeModel: 'deepseek-v4.1-flash', promptModel: 'claude-haiku-5-5' }));
    legacy.prepare("INSERT INTO items(id,type,title,note,content_hash,status,captured_at,width,height) VALUES('preserved','image','Saved inspiration','Keep my note','original-hash','ready',?,10,10)").run(new Date().toISOString());
    legacy.prepare("INSERT INTO label_overrides VALUES('preserved','style','editorial','accepted')").run();
    legacy.prepare("INSERT INTO model_calls(id,job_id,item_id,stage,model_id,month,created_at,reserved_usd,accounted_usd,state,provider,variant) VALUES('old-call','old-job','preserved','analyze','deepseek-v4.1-flash',?,?,12.3,1.2,'uncertain','opencode-go','agent')").run(new Date().toISOString().slice(0, 7), new Date().toISOString());
    const item = legacy.prepare('SELECT * FROM items').get(), call = legacy.prepare('SELECT * FROM model_calls').get(), labels = legacy.prepare('SELECT * FROM label_overrides').all();
    library = openLibrary(path);
    expect(legacy.pragma('user_version', { simple: true })).toBe(8);
    expect(library.intelligence.settings()).toEqual({ allowImageSharing: true, allowModelTraining: true, analyzeModel: 'deepseek-v4.1-flash', promptModel: 'claude-haiku-5-5' });
    expect(legacy.prepare('SELECT * FROM items').get()).toEqual(item);
    expect(legacy.prepare('SELECT * FROM model_calls').get()).toEqual(call);
    expect(legacy.prepare('SELECT * FROM label_overrides').all()).toEqual(labels);
    const service = createAiService({ library, libraryDir: directory, apiKey: 'synthetic-only', provider: { generate: async () => { throw new Error('No requests expected.'); } } });
    expect(service.status().analysis).toBe('running');
    expect(service.status().usage).not.toHaveProperty('reservedUsd');
    await service.stop();
    expect(legacy.pragma('foreign_key_check')).toEqual([]);
  } finally { library?.close(); legacy.close(); await rm(directory, { recursive: true, force: true }); }
});

it('does not manufacture sharing or training consent while removing legacy controls', async () => {
  const directory = await temporaryLibrary(), path = join(directory, 'library.sqlite');
  const legacy = new Database(path);
  let library: ReturnType<typeof openLibrary> | undefined;
  try {
    for (const migration of migrations.slice(0, 7)) legacy.exec(migration);
    legacy.pragma('user_version=7');
    library = openLibrary(path);
    expect(library.intelligence.settings()).toMatchObject({ allowImageSharing: false, allowModelTraining: false });
    expect(library.intelligence.settings()).not.toHaveProperty('enabled');
    expect(library.intelligence.settings()).not.toHaveProperty('monthlyBudgetUsd');
  } finally { library?.close(); legacy.close(); await rm(directory, { recursive: true, force: true }); }
});
