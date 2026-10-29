import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiService } from '../apps/server/src/ai.js';
import type { AiService } from '../apps/server/src/ai.js';
import { saveImage } from '../apps/server/src/images.js';
import { createApp } from '../apps/server/src/app.js';
import { openLibrary, ConflictError } from '../packages/database/src/index.js';
import type { Library } from '../packages/database/src/index.js';
import { ProviderError } from '../packages/analysis/src/index.js';
import type { AnalysisProvider, ModelRequest } from '../packages/analysis/src/index.js';
import type { LibraryItem } from '../packages/shared/src/browser.js';
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
  library = openLibrary(join(directory, 'design-index.sqlite'));
  item = (await saveImage(library, directory, await imageFixture(), { title: 'Design reference', note: 'User note stays intact' })).item;
  requests = [];
  generate = async (request) => { requests.push(request); return { output: request.stage === 'analyze' ? analysisFixture() : promptFixture(), inputTokens: 100, outputTokens: 150 }; };
  service = createAiService({ library, libraryDir: directory, apiKey: 'unit-secret', intervalMs: 10, provider: { generate: (request) => generate(request) } });
});
afterEach(async () => { await service.stop(); library.close(); vi.useRealTimers(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

function enable() { service.updateSettings({ allowImageSharing: true, analyzeModel: 'claude-haiku-5-5', promptModel: 'claude-haiku-5-5' }); }
async function finish() { await service.runOnce(); await service.runOnce(); }

describe('durable AI pipeline', () => {
  it('does nothing until image sharing is explicitly approved', async () => {
    await service.runOnce();
    expect(requests).toHaveLength(0);
    expect(service.status().analysis).toBe('paused');
    expect(service.status().usage.calls).toBe(0);
    expect(() => service.updateSettings({ ...service.status().settings, enabled: true })).toThrow(); // Removed controls are rejected.
    expect(() => service.updateSettings({ ...service.status().settings, monthlyBudgetUsd: 1 })).toThrow();
  });

  it('offers only vision models and rejects text-only or unknown selections on the server', () => {
    const before = service.status().settings;
    expect(service.status().models).toHaveLength(24);
    expect(service.status().models.every((model) => model.vision)).toBe(true);
    expect(service.status().models.some((model) => model.id === 'deepseek-v4.1-flash')).toBe(true);
    for (const id of ['deepseek-v4-pro', 'glm-5.2', 'deepseek-v4.1-flash-free', 'omen-alpha']) {
      expect(() => service.updateSettings({ ...before, analyzeModel: id })).toThrow(/image-input/);
      expect(() => service.updateSettings({ ...before, promptModel: id })).toThrow(/image-input/);
    }
    expect(service.status().settings).toEqual(before);
  });

  it('does not treat ordinary image-sharing consent as permission to train models', async () => {
    const settings = { allowImageSharing: true, analyzeModel: 'muse-spark-1.3-contributor', promptModel: 'muse-spark-1.3-contributor' };
    expect(() => service.updateSettings(settings)).toThrow(/provider training/);
    expect(service.status().settings.allowModelTraining).toBe(false);
    service.updateSettings({ ...settings, allowModelTraining: true });
    await service.runOnce();
    expect(requests[0]?.allowModelTraining).toBe(true);
  });

  it('pauses rather than switching models when refreshed capabilities remove a selected model', async () => {
    enable();
    vi.stubGlobal('fetch', async (url: string) => url.includes('models.dev') ? Response.json({
      'opencode-go': { models: {
        'claude-haiku-5-5': { modalities: { input: ['text'], output: ['text'] } },
        'deepseek-v4.1-flash': { modalities: { input: ['text', 'image'], output: ['text'] } },
      } },
    }) : Response.json({ data: [{ id: 'claude-haiku-5-5' }, { id: 'deepseek-v4.1-flash' }] }));
    const refreshed = await service.refreshModels();
    expect(refreshed.models.map((model) => model.id)).toEqual(['deepseek-v4.1-flash']);
    expect(refreshed.analysis).toBe('paused');
    expect(refreshed.settings.allowImageSharing).toBe(true);
    expect(refreshed.settings.analyzeModel).toBe('claude-haiku-5-5');
    await service.runOnce();
    expect(requests).toHaveLength(0);
    expect(() => service.updateSettings(refreshed.settings)).toThrow(/current Go catalog/);
  });

  it('runs both stages with stable session identity, exact tokens, provenance, and searchable output', async () => {
    enable(); await service.runOnce();
    expect(library.getItem(item.id)?.status).toBe('writing_prompt');
    await service.runOnce();
    const saved = library.getItem(item.id)!;
    expect(saved.status).toBe('ready');
    expect(saved.note).toBe('User note stays intact');
    expect(saved.intelligence.analysis?.modelId).toBe('claude-haiku-5-5');
    expect(saved.intelligence.prompt?.body).toContain('--accent: #7C5CFF');
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.sessionId === item.id)).toBe(true);
    expect(requests[0]?.image).toBeInstanceOf(Uint8Array);
    expect(requests[1]?.image).toBeUndefined();
    expect(requests[0]?.text).not.toContain('unit-secret');
    expect(service.status().usage).toMatchObject({ calls: 2, inputTokens: 200, outputTokens: 300, uncertainCalls: 0 });
    expect(library.search({ q: 'editorial' }).total).toBe(1);
    expect(library.search({ q: 'restrained' }).total).toBe(1);
    expect(library.search({ facet: 'style', label: 'minimal' }).total).toBe(1);
  });

  it('retries invalid output once and accounts for both attempts', async () => {
    generate = async (request) => {
      requests.push(request);
      return { output: requests.length === 1 ? analysisFixture('#FFFFFF') : request.stage === 'analyze' ? analysisFixture() : promptFixture(), inputTokens: 100, outputTokens: 100 };
    };
    enable(); await finish();
    expect(library.getItem(item.id)?.status).toBe('ready');
    expect(service.status().usage.calls).toBe(3);
    expect(requests[1]?.text).toContain('correction');
  });

  it('does not loop on invalid output or run prompt writing after failed analysis', async () => {
    generate = async (request) => { requests.push(request); return { output: null, inputTokens: 100, outputTokens: 100 }; };
    enable(); await finish(); await service.runOnce();
    expect(requests).toHaveLength(2);
    expect(library.getItem(item.id)?.status).toBe('needs_review');
    expect(library.getItem(item.id)?.intelligence.prompt).toBeNull();
  });

  it('records an unknown request outcome without disabling later inspiration', async () => {
    generate = async (request) => { requests.push(request); throw new ProviderError('credentials'); };
    enable(); await finish();
    expect(requests).toHaveLength(1);
    expect(service.status().analysis).toBe('running');
    expect(service.status().usage.uncertainCalls).toBe(1);
    expect(library.getItem(item.id)?.intelligence.analysisError).not.toContain('unit-secret');
    const next = (await saveImage(library, directory, await imageFixture('#102030'), { title: 'Next inspiration', note: '' })).item;
    generate = async (request) => { requests.push(request); return { output: request.stage === 'analyze' ? analysisFixture('#102030') : promptFixture('#102030'), inputTokens: 100, outputTokens: 100 }; };
    await finish();
    expect(library.getItem(next.id)?.status).toBe('ready');
    expect(requests).toHaveLength(3);
  });

  it('never blocks requests on historical dollar estimates or incomplete usage', async () => {
    enable();
    const job = library.intelligence.claim()!;
    const call = library.intelligence.beginCall(job, 'claude-haiku-5-5')!;
    library.intelligence.settle(call, null, null);
    library.intelligence.fail(job, 'Previous request outcome unknown.');
    const db = new Database(join(directory, 'design-index.sqlite'));
    db.prepare('UPDATE model_calls SET reserved_usd=1000000,accounted_usd=1000000 WHERE id=?').run(call); db.close();
    service.retry(item.id); await finish();
    expect(requests).toHaveLength(2);
    expect(service.status().analysis).toBe('running');
    expect(library.getItem(item.id)?.status).toBe('ready');
    expect(service.status().usage).not.toHaveProperty('reservedUsd');
    expect(service.status().settings).not.toHaveProperty('monthlyBudgetUsd');
  });

  it('records incomplete usage without blocking successful analysis or its prompt', async () => {
    generate = async (request) => { requests.push(request); return { output: analysisFixture(), inputTokens: null, outputTokens: null }; };
    enable(); await service.runOnce();
    expect(service.status().usage.uncertainCalls).toBe(1);
    expect(service.status().analysis).toBe('running');
    expect(library.getItem(item.id)?.status).toBe('writing_prompt');
  });

  it('keeps monthly call history without treating a month as an allowance window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-31T12:00:00Z'));
    enable();
    const job = library.intelligence.claim()!;
    const call = library.intelligence.beginCall(job, 'claude-haiku-5-5')!;
    library.intelligence.settle(call, null, null);
    library.intelligence.fail(job, 'Unknown request outcome.');
    expect(service.status().analysis).toBe('running');
    vi.setSystemTime(new Date('2026-02-01T12:00:00Z'));
    service.retry(item.id); await finish();
    expect(library.getItem(item.id)?.status).toBe('ready');
    expect(service.status().usage.month).toBe('2026-02');
    expect(library.intelligence.usage('2026-01').uncertainCalls).toBe(1);
  });

  it('renews the lease for a validation retry rather than expiring after two slow attempts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    generate = async (request) => {
      requests.push(request);
      vi.setSystemTime(new Date(Date.now() + 60_000));
      return { output: requests.length === 1 ? null : analysisFixture(), inputTokens: 100, outputTokens: 150 };
    };
    enable(); await service.runOnce();
    expect(requests).toHaveLength(2);
    expect(library.getItem(item.id)?.status).toBe('writing_prompt');
  });

  it('reuses unchanged successful results without additional calls', async () => {
    enable(); await finish();
    service.retry(item.id); await finish();
    expect(requests).toHaveLength(2);
    expect(library.getItem(item.id)?.status).toBe('ready');
  });

  it('preserves accepted/rejected labels and manual prompt revisions through re-analysis', async () => {
    enable(); await finish();
    library.intelligence.editLabel(item.id, 'style', 'minimal', 'rejected');
    library.intelligence.editLabel(item.id, 'style', 'editorial', 'accepted');
    const original = library.intelligence.prompt(item.id)!;
    const edited = library.intelligence.editPrompt(item.id, 'My personally refined coding prompt.', original.version);
    expect(() => library.intelligence.editPrompt(item.id, 'Stale change', original.version)).toThrow(ConflictError);
    library.updateItem(item.id, { title: item.title, note: 'New note, same manual decisions' });
    service.retry(item.id); await finish();
    const saved = library.getItem(item.id)!;
    expect(saved.intelligence.prompt?.body).toBe(edited.body);
    expect(saved.intelligence.labels).toContainEqual({ facet: 'style', value: 'minimal', state: 'rejected', origin: 'user', confidence: 1 });
    expect(library.search({ facet: 'style', label: 'minimal' }).total).toBe(0);
    expect(library.search({ facet: 'style', label: 'editorial' }).total).toBe(1);
    expect(requests[2]?.text).toContain('manual_labels');
  });

  it('recovers expired leases conservatively and refuses stale writes after restart', async () => {
    enable();
    const job = library.intelligence.claim()!;
    library.intelligence.beginCall(job, 'claude-haiku-5-5');
    const direct = new Database(join(directory, 'design-index.sqlite'));
    direct.prepare("UPDATE jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(job.id);
    direct.close();
    library.intelligence.recoverExpired();
    expect(library.getItem(item.id)?.status).toBe('needs_review');
    expect(library.intelligence.claim()).toBeUndefined();
    expect(service.status().usage.uncertainCalls).toBe(1);
    expect(() => library.intelligence.completeAnalysis(job, analysisFixture(), 'claude-haiku-5-5', 'stale', 'test')).toThrow(ConflictError);
  });

  it('never exposes the provider key through the local API', async () => {
    const app = createApp({ library, libraryDir: directory, token: 'local-test-token', port: 4317, ai: service });
    const unauthorized = await app.request('http://127.0.0.1:4317/api/ai');
    expect(unauthorized.status).toBe(401);
    const response = await app.request('http://127.0.0.1:4317/api/ai', { headers: { Authorization: 'Bearer local-test-token' } });
    const text = await response.text();
    expect(text).not.toContain('unit-secret');
    expect(JSON.parse(text).keyConfigured).toBe(true);
  });

  it('starts queued and newly loaded inspiration automatically with consent and no enable/budget setting', async () => {
    enable(); service.start();
    await vi.waitFor(() => expect(library.getItem(item.id)?.status).toBe('ready'), { timeout: 3000 });
    const next = (await saveImage(library, directory, await imageFixture('#102030'), { title: 'Automatic inspiration', note: '' })).item;
    generate = async (request) => { requests.push(request); return { output: request.stage === 'analyze' ? analysisFixture('#102030') : promptFixture('#102030'), inputTokens: 100, outputTokens: 100 }; };
    await vi.waitFor(() => expect(library.getItem(next.id)?.status).toBe('ready'), { timeout: 3000 });
    expect(requests).toHaveLength(4);
    expect(service.status().settings).not.toHaveProperty('enabled');
  });

  it('honors Go rate limits and resumes automatically without changing consent or requiring enablement', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    generate = async (request) => { requests.push(request); if (requests.length === 1) throw new ProviderError('limits', 2000); return { output: request.stage === 'analyze' ? analysisFixture() : promptFixture(), inputTokens: 100, outputTokens: 100 }; };
    enable(); await service.runOnce();
    expect(service.status().analysis).toBe('waiting');
    expect(service.status().retryAt).not.toBeNull();
    expect(service.status().settings.allowImageSharing).toBe(true);
    expect(library.getItem(item.id)?.status).toBe('queued');
    vi.setSystemTime(new Date(Date.now() + 1999)); await service.runOnce(); expect(requests).toHaveLength(1);
    vi.setSystemTime(new Date(Date.now() + 1)); await finish();
    expect(requests).toHaveLength(3); expect(library.getItem(item.id)?.status).toBe('ready');
    expect(service.status().retryAt).toBeNull();
  });

  it('bounds automatic retries of explicit rejections and never loops indefinitely', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    generate = async (request) => { requests.push(request); throw new ProviderError('limits', 1000); };
    enable();
    for (let count = 0; count < 5; count++) { await service.runOnce(); vi.setSystemTime(Date.now() + 1000); }
    expect(requests).toHaveLength(3);
    expect(library.getItem(item.id)?.status).toBe('needs_review');
    expect(service.status().settings.allowImageSharing).toBe(true);
  });

  it('still stops sending when sharing consent is revoked', async () => {
    enable(); service.updateSettings({ ...service.status().settings, allowImageSharing: false });
    await service.runOnce(); expect(requests).toHaveLength(0); expect(service.status().analysis).toBe('paused');
  });

  it('activates from the localhost development UI using the server key, while still rejecting unrelated origins', async () => {
    const app = createApp({ library, libraryDir: directory, token: 'local-test-token', port: 4317, ai: service, development: true });
    const body = JSON.stringify({ ...service.status().settings, allowImageSharing: true });
    const response = await app.request('http://127.0.0.1:4317/api/ai', { method: 'PUT', headers: { Origin: 'http://localhost:5173', Authorization: 'Bearer local-test-token', 'Content-Type': 'application/json' }, body });
    expect(response.status).toBe(200);
    expect((await response.json()).settings.allowImageSharing).toBe(true);
    expect(requests).toHaveLength(0); // Test service is not started; never consumes Go usage.
    for (const origin of ['http://evil.localhost:5173', 'https://localhost:5173', 'http://localhost:5174', 'https://malicious.example']) {
      const blocked = await app.request('http://127.0.0.1:4317/api/ai', { method: 'PUT', headers: { Origin: origin, Authorization: 'Bearer local-test-token', 'Content-Type': 'application/json' }, body });
      expect(blocked.status).toBe(403);
    }
    const production = createApp({ library, libraryDir: directory, token: 'local-test-token', port: 4317, ai: service });
    expect((await production.request('http://127.0.0.1:4317/api/ai', { headers: { Origin: 'http://localhost:5173', Authorization: 'Bearer local-test-token' } })).status).toBe(403);
  });
});
