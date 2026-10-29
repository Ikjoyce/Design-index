import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAiService } from '../apps/server/src/ai.js';
import type { AiService } from '../apps/server/src/ai.js';
import { createApp } from '../apps/server/src/app.js';
import { saveImage } from '../apps/server/src/images.js';
import { ConflictError, openLibrary } from '../packages/database/src/index.js';
import type { Library } from '../packages/database/src/index.js';
import { migrations } from '../packages/database/src/migrations.js';
import type { AnalysisProvider, ModelRequest } from '../packages/analysis/src/index.js';
import { validatePrompt } from '../packages/analysis/src/index.js';
import type { LibraryItem, PromptVariant } from '../packages/shared/src/browser.js';
import { analysisFixture, promptFixture } from './analysis-fixtures.js';
import { imageFixture, temporaryLibrary } from './helpers.js';

let directory: string;
let library: Library;
let service: AiService;
let item: LibraryItem;
let requests: ModelRequest[];
let generate: AnalysisProvider['generate'];

beforeEach(async () => {
  directory = await temporaryLibrary();
  library = openLibrary(join(directory, 'library.sqlite'));
  item = (await saveImage(library, directory, await imageFixture(), { title: 'Authoring reference', note: 'Keep my note' })).item;
  requests = [];
  generate = async (request) => {
    requests.push(request);
    const input = JSON.parse(request.text);
    const result = analysisFixture();
    if (request.stage === 'analyze') result.labels.style[0]!.value = input.vocabulary.style.includes('minimal') ? 'minimal' : input.vocabulary.style[0];
    return { output: request.stage === 'analyze' ? result : request.variant === 'vibe' ? { body: 'Intent: calm, spacious, restrained. Avoid clutter and unmeasured animation.', assumptions: [] } : promptFixture(), inputTokens: 100, outputTokens: 150 };
  };
  service = createAiService({ library, libraryDir: directory, apiKey: 'synthetic-key', provider: { generate: (request) => generate(request) } });
});
afterEach(async () => { await service.stop(); library.close(); await rm(directory, { recursive: true, force: true }); });
function enable() { service.updateSettings({ ...service.status().settings, allowImageSharing: true }); }
async function finishAgent() { enable(); await service.runOnce(); await service.runOnce(); }
async function variant(value: PromptVariant) { service.generatePrompt(item.id, value); await service.runOnce(); }
function http(method: string, path: string, body?: unknown) {
  const app = createApp({ library, libraryDir: directory, token: 'local-token', port: 4317, ai: service });
  return app.request(`http://127.0.0.1:4317${path}`, { method, headers: { Authorization: 'Bearer local-token', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe('versioned controlled vocabulary', () => {
  it('saves new terms without model calls or bulk retagging and rejects stale writers', () => {
    const original = library.vocabulary.get();
    const terms = structuredClone(original.terms);
    terms.style.push('swiss-editorial');
    const saved = library.vocabulary.save(original.revision, terms);
    expect(saved.revision).toBe(2);
    expect(saved.terms.style).toContain('swiss-editorial');
    expect(library.queueCount()).toBe(1);
    expect(requests).toHaveLength(0);
    expect(() => library.vocabulary.save(original.revision, original.terms)).toThrow(/changed/);
    const reopened = openLibrary(join(directory, 'library.sqlite'));
    try { expect(reopened.vocabulary.get().terms.style).toContain('swiss-editorial'); }
    finally { reopened.close(); }
  });

  it('handles valid labels that match JavaScript property names without inheriting aliases', async () => {
    const state = library.vocabulary.get();
    state.terms.style.push('constructor');
    const saved = library.vocabulary.save(state.revision, state.terms);
    expect((await http('PATCH', `/api/items/${item.id}/labels`, { facet: 'style', value: 'constructor', state: 'accepted' })).status).toBe(200);
    expect(library.search({ facet: 'style', label: 'constructor' }).total).toBe(1);
    library.vocabulary.rename(saved.revision, 'style', 'constructor', 'builder');
    expect(library.getItem(item.id)?.intelligence.labels.some((label) => label.value === 'builder')).toBe(true);
  });

  it('retires terms without erasing old suggestions and still permits review of existing retired labels', async () => {
    await finishAgent();
    const current = library.vocabulary.get();
    const terms = structuredClone(current.terms);
    terms.style = terms.style.filter((term) => term !== 'minimal');
    const saved = library.vocabulary.save(current.revision, terms);
    expect(saved.retiredTerms.style).toContain('minimal');
    expect(library.getItem(item.id)?.intelligence.labels.some((label) => label.value === 'minimal')).toBe(true);
    expect((await http('PATCH', `/api/items/${item.id}/labels`, { facet: 'style', value: 'minimal', state: 'accepted' })).status).toBe(200);
    expect(library.search({ facet: 'style', label: 'minimal' }).total).toBe(1);
    const other = (await saveImage(library, directory, await imageFixture('#00AA00'), { title: 'Other', note: '' })).item;
    expect((await http('PATCH', `/api/items/${other.id}/labels`, { facet: 'style', value: 'minimal', state: 'accepted' })).status).toBe(400);
    expect(requests).toHaveLength(2);
  });

  it('renames effective labels and search while retaining immutable analysis/prompt text and manual rejection', async () => {
    await finishAgent();
    const prompt = library.intelligence.prompt(item.id)!;
    library.intelligence.editLabel(item.id, 'style', 'minimal', 'rejected');
    const state = library.vocabulary.get();
    const renamed = library.vocabulary.rename(state.revision, 'style', 'minimal', 'restrained-minimal');
    const saved = library.getItem(item.id)!;
    expect(renamed.aliases.style.minimal).toBe('restrained-minimal');
    expect(saved.intelligence.labels).toContainEqual({ facet: 'style', value: 'restrained-minimal', origin: 'user', state: 'rejected', confidence: 1 });
    expect(saved.intelligence.analysis?.labels.style[0]?.value).toBe('minimal');
    expect(saved.intelligence.analysis?.vocabularyRevision).toBe(1);
    expect(saved.intelligence.prompt?.body).toBe(prompt.body);
    expect(library.search({ facet: 'style', label: 'restrained-minimal' }).total).toBe(0);
    library.intelligence.editLabel(item.id, 'style', 'restrained-minimal', 'accepted');
    expect(library.search({ facet: 'style', label: 'minimal' }).total).toBe(1);
    expect(library.search({ facet: 'style', label: 'restrained-minimal' }).total).toBe(1);
    expect(library.search({ q: 'restrained' }).total).toBe(1);
    expect(requests).toHaveLength(2);
  });

  it('refuses conflicting manual merges and coalesces matching decisions only after the owner resolves them', async () => {
    await finishAgent();
    library.intelligence.editLabel(item.id, 'style', 'minimal', 'rejected');
    library.intelligence.editLabel(item.id, 'style', 'editorial', 'accepted');
    const before = library.vocabulary.get();
    expect(() => library.vocabulary.rename(before.revision, 'style', 'minimal', 'editorial')).toThrow(/conflict/);
    expect(library.vocabulary.get().revision).toBe(before.revision);
    expect(library.getItem(item.id)?.intelligence.labels.filter((label) => label.facet === 'style')).toHaveLength(2);
    library.intelligence.editLabel(item.id, 'style', 'minimal', 'accepted');
    library.vocabulary.rename(before.revision, 'style', 'minimal', 'editorial');
    expect(library.getItem(item.id)?.intelligence.labels.filter((label) => label.facet === 'style')).toEqual([{ facet: 'style', value: 'editorial', origin: 'user', state: 'accepted', confidence: 1 }]);
  });

  it('keeps rename chains canonical and prevents old aliases being reintroduced or motion:unknown removed', () => {
    let state = library.vocabulary.get();
    state = library.vocabulary.rename(state.revision, 'style', 'minimal', 'restrained-minimal');
    state = library.vocabulary.rename(state.revision, 'style', 'restrained-minimal', 'quiet-minimal');
    expect(state.aliases.style.minimal).toBe('quiet-minimal');
    expect(library.vocabulary.equivalents('style', 'minimal')).toContain('quiet-minimal');
    const terms = structuredClone(state.terms); terms.style.push('minimal');
    expect(() => library.vocabulary.save(state.revision, terms)).toThrow(/reintroduced/);
    expect(() => library.vocabulary.rename(state.revision, 'motion', 'unknown', 'something-else')).toThrow(/reserved/);
    const badMotion = structuredClone(state.terms); badMotion.motion = ['static'];
    expect(() => library.vocabulary.save(state.revision, badMotion)).toThrow();
  });

  it('validates an in-flight reply against its captured vocabulary and invalidates caches on the next revision', async () => {
    let changed = false;
    const normal = generate;
    generate = async (request) => {
      if (request.stage === 'analyze' && !changed) {
        changed = true;
        const state = library.vocabulary.get();
        state.terms.style = ['swiss-editorial'];
        library.vocabulary.save(state.revision, state.terms);
      }
      return normal(request);
    };
    await finishAgent();
    expect(library.getItem(item.id)?.status).toBe('ready');
    expect(library.getItem(item.id)?.intelligence.analysis?.vocabularyRevision).toBe(1);
    service.retry(item.id); await service.runOnce(); await service.runOnce();
    expect(library.getItem(item.id)?.intelligence.analysis?.vocabularyRevision).toBe(2);
    expect(library.getItem(item.id)?.intelligence.labels.some((label) => label.value === 'swiss-editorial')).toBe(true);
    expect(JSON.parse(requests[0]!.text).vocabulary_revision).toBe(1);
    expect(JSON.parse(requests[2]!.text).vocabulary_revision).toBe(2);
    expect(requests).toHaveLength(4);
  });

  it('protects vocabulary routes and reports validation/revision errors without exposing credentials', async () => {
    const app = createApp({ library, libraryDir: directory, token: 'local-token', port: 4317, ai: service });
    expect((await app.request('http://127.0.0.1:4317/api/vocabulary')).status).toBe(401);
    const state = library.vocabulary.get();
    const terms = structuredClone(state.terms); terms.style.push('UPPERCASE');
    expect((await http('PUT', '/api/vocabulary', { baseRevision: state.revision, terms })).status).toBe(400);
    terms.style = [...state.terms.style, 'custom-style'];
    expect((await http('PUT', '/api/vocabulary', { baseRevision: state.revision, terms })).status).toBe(200);
    expect((await http('PUT', '/api/vocabulary', { baseRevision: state.revision, terms })).status).toBe(409);
    expect((await http('POST', '/api/vocabulary/rename', { baseRevision: 2, facet: 'style', from: 'custom-style', to: 'renamed-style' })).status).toBe(200);
    expect(service.status().usage.calls).toBe(0);
  });
});

describe('prompt variants and immutable history', () => {
  it('generates only agent automatically; general/vibe are independent, allowance-accounted on-demand jobs', async () => {
    await finishAgent();
    expect(requests).toHaveLength(2);
    expect(library.getItem(item.id)?.intelligence.prompts).toMatchObject({ general: null, vibe: null });
    await variant('general'); await variant('vibe');
    const saved = library.getItem(item.id)!;
    expect(saved.status).toBe('ready');
    expect(saved.intelligence.prompts.agent?.version).toBe(1);
    expect(saved.intelligence.prompts.general?.version).toBe(1);
    expect(saved.intelligence.prompts.vibe?.version).toBe(1);
    expect(saved.intelligence.prompts.agent?.body).toContain('## Tokens');
    expect(saved.intelligence.prompts.general?.body).not.toContain('## Tokens');
    expect(saved.intelligence.prompts.vibe?.body).not.toContain('```');
    expect(saved.intelligence.prompts.vibe?.body.split(/\s+/).length).toBeLessThanOrEqual(80);
    expect(requests[2]?.variant).toBe('general');
    expect(requests[3]?.variant).toBe('vibe');
    expect(requests[2]?.image).toBeUndefined();
    expect(service.status().usage.calls).toBe(4);
  });

  it('requires analysis and sharing consent before queueing variants, and prevents duplicate pending jobs', async () => {
    expect(() => service.generatePrompt(item.id, 'general')).toThrow(/Approve image sharing/);
    enable();
    expect(() => service.generatePrompt(item.id, 'general')).toThrow(/Analyze/);
    await finishAgent();
    service.generatePrompt(item.id, 'general');
    expect(() => service.generatePrompt(item.id, 'general')).toThrow(/already queued/);
    await service.runOnce();
    const count = requests.length;
    await variant('general');
    expect(requests).toHaveLength(count); // Same analysis/model/variant reuses its cache.
    expect(library.intelligence.promptHistory(item.id, 'general').total).toBe(1);
  });

  it('keeps edits/restore local, isolates variant versions, and updates full-text search to saved heads', async () => {
    await finishAgent();
    await variant('general');
    const original = library.intelligence.prompt(item.id, 'general')!;
    const agent = library.intelligence.prompt(item.id)!;
    const edited = library.intelligence.editPrompt(item.id, 'A personally refined meridianoverride design direction.', original.version, 'general');
    expect(edited.version).toBe(2);
    expect(library.search({ q: 'meridianoverride' }).total).toBe(1);
    expect(() => library.intelligence.editPrompt(item.id, 'Stale content', original.version, 'general')).toThrow(ConflictError);
    const restored = library.intelligence.restorePrompt(item.id, original.id, 'general', edited.version);
    expect(restored.version).toBe(3);
    expect(restored.id).not.toBe(original.id);
    expect(restored.body).toBe(original.body);
    expect(restored.editedByUser).toBe(true);
    expect(library.intelligence.prompt(item.id)?.id).toBe(agent.id);
    expect(library.search({ q: 'meridianoverride' }).total).toBe(0);
    const history = library.intelligence.promptHistory(item.id, 'general', 2, 0);
    expect(history.total).toBe(3);
    expect(history.versions.map((row) => row.version)).toEqual([3, 2]);
    expect(library.intelligence.promptHistory(item.id, 'general', 2, 2).versions[0]?.id).toBe(original.id);
    expect(requests).toHaveLength(3);
  });

  it('keeps a refreshed model result in history without replacing the selected manual version', async () => {
    await finishAgent();
    const original = library.intelligence.prompt(item.id)!;
    const manual = library.intelligence.editPrompt(item.id, 'My selected manual agent revision.', original.version);
    service.updateSettings({ ...service.status().settings, promptModel: 'gpt-6-luna' });
    await variant('agent');
    expect(library.intelligence.prompt(item.id)?.id).toBe(manual.id);
    expect(library.intelligence.promptHistory(item.id, 'agent').versions[0]).toMatchObject({ version: 3, modelId: 'gpt-6-luna', editedByUser: false });
    expect(requests).toHaveLength(3);
  });

  it('preserves manual variants through re-analysis and hides stale automatic variants without deleting history', async () => {
    await finishAgent(); await variant('general'); await variant('vibe');
    const general = library.intelligence.prompt(item.id, 'general')!;
    const vibe = library.intelligence.prompt(item.id, 'vibe')!;
    library.intelligence.editPrompt(item.id, 'My manual general variant survives new analyses.', general.version, 'general');
    library.updateItem(item.id, { title: item.title, note: 'Changed note invalidates the analysis cache.' });
    service.retry(item.id); await service.runOnce(); await service.runOnce();
    const saved = library.getItem(item.id)!;
    expect(saved.intelligence.prompts.general?.body).toBe('My manual general variant survives new analyses.');
    expect(saved.intelligence.prompts.vibe).toBeNull();
    expect(library.intelligence.promptHistory(item.id, 'vibe').versions[0]?.id).toBe(vibe.id);
    const restored = library.intelligence.restorePrompt(item.id, vibe.id, 'vibe', 0);
    expect(restored.version).toBe(2);
    expect(restored.analysisId).toBe(vibe.analysisId);
    expect(restored.editedByUser).toBe(true);
    expect(requests).toHaveLength(6);
  });

  it('does not damage a ready agent prompt when an optional vibe fails validation', async () => {
    await finishAgent();
    const agent = library.intelligence.prompt(item.id)!;
    const normal = generate;
    generate = async (request) => request.variant === 'vibe' ? (requests.push(request), { output: { body: Array(90).fill('word').join(' '), assumptions: [] }, inputTokens: 100, outputTokens: 150 }) : normal(request);
    await variant('vibe');
    const saved = library.getItem(item.id)!;
    expect(saved.status).toBe('ready');
    expect(saved.intelligence.analysisError).toBeNull();
    expect(saved.intelligence.promptJobs.vibe?.status).toBe('failed');
    expect(saved.intelligence.prompt?.id).toBe(agent.id);
    expect(service.status().usage.calls).toBe(4);
    expect(validatePrompt({ body: 'Short but ```code``` is not allowed in vibe.', assumptions: [] }, item.palette, 'vibe')).toBeNull();
  });

  it('constrains history restore to the same item/variant and rejects stale API edits', async () => {
    await finishAgent(); await variant('general');
    const general = library.intelligence.prompt(item.id, 'general')!;
    expect((await http('GET', `/api/items/${item.id}/prompts?variant=general`)).status).toBe(200);
    expect((await http('GET', `/api/items/${item.id}/prompts?variant=bad`)).status).toBe(400);
    expect((await http('POST', `/api/items/${item.id}/prompts/${general.id}/restore`, { variant: 'agent', baseVersion: 1 })).status).toBe(409);
    const other = (await saveImage(library, directory, await imageFixture('#00AA00'), { title: 'Other', note: '' })).item;
    expect((await http('POST', `/api/items/${other.id}/prompts/${general.id}/restore`, { variant: 'general', baseVersion: 0 })).status).toBe(409);
    expect((await http('PATCH', `/api/items/${item.id}/prompt`, { variant: 'general', body: 'An updated local design prompt.', baseVersion: general.version })).status).toBe(200);
    expect((await http('PATCH', `/api/items/${item.id}/prompt`, { variant: 'general', body: 'A stale competing design prompt.', baseVersion: general.version })).status).toBe(409);
    expect((await http('POST', `/api/items/${item.id}/prompts/${randomUUID()}/restore`, { variant: 'general', baseVersion: 2 })).status).toBe(409);
  });
});

it('upgrades a populated pre-variant database without losing manual prompt history or queued work', () => {
  const path = join(directory, 'legacy.sqlite');
  const legacy = new Database(path);
  for (const migration of migrations.slice(0, 4)) legacy.exec(migration);
  legacy.pragma('user_version=4');
  const timestamp = '2026-10-01T00:00:00.000Z';
  legacy.prepare('INSERT INTO items(id,type,title,note,content_hash,status,captured_at,width,height) VALUES(?,?,?,?,?,?,?,?,?)').run('legacy', 'image', 'Legacy', 'Keep this note', 'old-hash', 'ready', timestamp, 48, 32);
  legacy.prepare('INSERT INTO analyses(id,item_id,model_id,prompt_version,cache_key,result_json,created_at,provider) VALUES(?,?,?,?,?,?,?,?)').run('analysis', 'legacy', 'claude-haiku-5-5', 'old', 'old-cache', JSON.stringify(analysisFixture()), timestamp, 'opencode-go');
  legacy.prepare('UPDATE items SET active_analysis_id=? WHERE id=?').run('analysis', 'legacy');
  for (const version of [1, 2]) legacy.prepare('INSERT INTO prompts(id,item_id,analysis_id,model_id,body,assumptions_json,edited_by_user,version,created_at,provider) VALUES(?,?,?,?,?,?,?,?,?,?)').run(`prompt-${version}`, 'legacy', 'analysis', 'claude-haiku-5-5', version === 1 ? 'Generated original prompt' : 'Manual prompt stays untouched', '[]', version === 2 ? 1 : 0, version, timestamp, 'opencode-go');
  legacy.prepare("INSERT INTO jobs(id,item_id,kind,status,created_at,run_id,analysis_id) VALUES('job','legacy','write_prompt','queued',?,'run','analysis')").run(timestamp);
  legacy.close();
  const upgraded = openLibrary(path);
  try {
    expect(upgraded.getItem('legacy')?.note).toBe('Keep this note');
    expect(upgraded.getItem('legacy')?.intelligence.prompt).toMatchObject({ id: 'prompt-2', body: 'Manual prompt stays untouched', version: 2, variant: 'agent', editedByUser: true });
    expect(upgraded.intelligence.promptHistory('legacy', 'agent').total).toBe(2);
    expect(upgraded.intelligence.promptHistory('legacy', 'general').total).toBe(0);
    expect(upgraded.intelligence.claim()?.variant).toBe('agent');
    expect(upgraded.vocabulary.get().revision).toBe(1);
    const check = new Database(path, { readonly: true });
    try { expect(check.pragma('foreign_key_check')).toEqual([]); } finally { check.close(); }
  } finally { upgraded.close(); }
});
