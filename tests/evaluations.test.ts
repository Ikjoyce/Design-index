import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAiService } from '../apps/server/src/ai.js';
import { createApp } from '../apps/server/src/app.js';
import { saveImage } from '../apps/server/src/images.js';
import { openLibrary } from '../packages/database/src/index.js';
import type { Library } from '../packages/database/src/index.js';
import type { AnalysisProvider, ModelRequest } from '../packages/analysis/src/index.js';
import { ProviderError } from '../packages/analysis/src/index.js';
import { evaluationSampleSchema, scoreEvaluation } from '../packages/shared/src/index.js';
import type { LibraryItem, VocabularyTerms } from '../packages/shared/src/browser.js';
import { analysisFixture, promptFixture } from './analysis-fixtures.js';
import { imageFixture, temporaryLibrary } from './helpers.js';

const gold = (): VocabularyTerms => ({ style: ['minimal'], color: [], layout: [], typography: [], motion: ['unknown'], component: [] });
let directory: string, library: Library, item: LibraryItem, service: ReturnType<typeof createAiService>;
let requests: ModelRequest[], generate: AnalysisProvider['generate'];
const models = ['claude-haiku-5-5', 'deepseek-v4.1-flash'];
beforeEach(async () => {
  directory = await temporaryLibrary(); library = openLibrary(join(directory, 'design-index.sqlite'));
  item = (await saveImage(library, directory, await imageFixture(), { title: 'Evaluation fixture', note: 'Library note' })).item;
  requests = [];
  generate = async (request) => { requests.push(request); return { output: request.stage === 'analyze' ? analysisFixture() : promptFixture(), inputTokens: 100, outputTokens: 150 }; };
  service = createAiService({ library, libraryDir: directory, apiKey: 'synthetic-only', provider: { generate: (request) => generate(request) } });
});
afterEach(async () => { await service.stop(); library.close(); await rm(directory, { recursive: true, force: true }); });
async function prepare() {
  service.updateSettings({ ...service.status().settings, allowImageSharing: true });
  await service.runOnce(); await service.runOnce(); requests.length = 0;
  library.evaluations.saveSample(item.id, gold(), ['style', 'motion'], 'PRIVATE_GROUND_TRUTH_ANNOTATION', 0);
}
function direct(sql: string, ...parameters: unknown[]) { const db = new Database(join(directory, 'design-index.sqlite')); try { db.prepare(sql).run(...parameters); } finally { db.close(); } }

describe('evaluation scoring and ground truth', () => {
  it('scores only explicit facets with micro precision/recall/F1 and exact agreement', () => {
    const result = analysisFixture(); result.labels.style.push({ value: 'editorial', confidence: 1 });
    const expected = gold(); expected.style.push('industrial');
    expect(scoreEvaluation(expected, ['style'], result)).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 1, precision: 0.5, recall: 0.5, f1: 0.5, exactAgreement: 0 });
    expect(scoreEvaluation(gold(), ['style', 'motion'], analysisFixture())).toMatchObject({ f1: 1, exactAgreement: 1 });
  });
  it('distinguishes an empty hand-labeled facet from an invalid or absent response', () => {
    const expected = gold(); expected.style = [];
    const result = analysisFixture(); result.labels.style = [];
    expect(scoreEvaluation(expected, ['style'], result)).toMatchObject({ precision: null, recall: null, f1: null, exactAgreement: 1 });
    expect(scoreEvaluation(expected, ['style'], null).exactAgreement).toBe(0);
    expect(scoreEvaluation(gold(), ['style'], null)).toMatchObject({ falseNegatives: 1, recall: 0, f1: 0 });
  });
  it('requires explicit scored facets, controlled labels, and optimistic versions', () => {
    expect(evaluationSampleSchema.safeParse({ labels: gold(), scoredFacets: [], note: '', baseVersion: 0 }).success).toBe(false);
    library.evaluations.saveSample(item.id, gold(), ['style'], '', 0);
    expect(() => library.evaluations.saveSample(item.id, gold(), ['style'], '', 0)).toThrow(/changed/);
    expect(() => library.evaluations.saveSample(item.id, { ...gold(), style: ['invented'] }, ['style'], '', 1)).toThrow(/vocabulary/);
    expect(() => library.evaluations.removeSample(item.id, 0)).toThrow();
    library.evaluations.removeSample(item.id, 1);
    expect(library.getItem(item.id)).toBeDefined();
  });
  it('limits ground truth to 30 references and 10 unique labels per facet', () => {
    expect(() => library.evaluations.saveSample(item.id, gold(), [], '', 0)).toThrow(/scored facets/);
    const palette = item.palette;
    for (let index = 0; index < 30; index++) {
      const id = `ground-truth-${index}`;
      library.createImage({ id, title: id, note: '', contentHash: id, width: 1, height: 1, original: { path: `${id}.png`, mime: 'image/png' }, preview: { path: `${id}.webp`, width: 1, height: 1 }, palette });
      library.evaluations.saveSample(id, gold(), ['style'], '', 0);
    }
    expect(() => library.evaluations.saveSample(item.id, gold(), ['style'], '', 0)).toThrow(/30/);
    const tooMany = { ...gold(), component: Array.from({ length: 11 }, (_, index) => `component-${index}`) };
    expect(evaluationSampleSchema.safeParse({ labels: tooMany, scoredFacets: ['component'], note: '', baseVersion: 0 }).success).toBe(false);
  });
});

describe('isolated evaluation execution', () => {
  it('requires hand labels, image-sharing enablement, distinct vision models, and separate training consent', async () => {
    await expect(service.startEvaluation('Test', models, [item.id])).rejects.toThrow(/Approve/);
    await prepare(); library.evaluations.removeSample(item.id, 1);
    await expect(service.startEvaluation('Test', models, [item.id])).rejects.toThrow(/hand labels/);
    library.evaluations.saveSample(item.id, gold(), ['style'], '', 0);
    await expect(service.startEvaluation('Test', [models[0]!, models[0]!], [item.id])).rejects.toThrow(/distinct/);
    await expect(service.startEvaluation('Test', [models[0]!, 'unknown'], [item.id])).rejects.toThrow(/vision/);
    await expect(service.startEvaluation('Test', [models[0]!, 'muse-spark-1.3-contributor'], [item.id])).rejects.toThrow(/training/);
    expect(requests).toHaveLength(0);
  });
  it('freezes blind inputs, vocabulary, expected labels and image hash; preserves active analysis and manual work', async () => {
    await prepare();
    library.intelligence.editLabel(item.id, 'style', 'editorial', 'accepted');
    const prompt = library.intelligence.prompt(item.id)!;
    library.intelligence.editPrompt(item.id, 'Manually edited prompt', prompt.version);
    const before = library.getItem(item.id)!;
    const run = await service.startEvaluation('Frozen comparison', models, [item.id]);
    const terms = library.vocabulary.current();
    library.vocabulary.save(terms.revision, { ...terms.terms, style: [...terms.terms.style, 'test-new-style'] });
    library.evaluations.saveSample(item.id, { ...gold(), style: ['editorial'] }, ['style'], 'changed annotation', 1);
    library.updateItem(item.id, { title: 'Edited later', note: 'Edited after freezing' });
    const expected = library.getItem(item.id);
    await service.runOnce(); await service.runOnce();
    const finished = library.evaluations.run(run.id)!;
    expect(finished.status).toBe('completed');
    expect(requests).toHaveLength(2);
    expect(requests[0]!.text).toBe(requests[1]!.text);
    expect(requests.every((request) => request.image && request.stage === 'analyze' && request.sessionId.startsWith('eval-'))).toBe(true);
    const input = JSON.parse(requests[0]!.text);
    expect(input.item.manual_labels).toEqual([]);
    expect(input.item.note).toBe('Library note');
    expect(requests[0]!.text).not.toContain('PRIVATE_GROUND_TRUTH_ANNOTATION');
    expect(input.vocabulary.style).not.toContain('test-new-style');
    expect(finished.summaries.every((summary) => summary.scores.f1 === 1)).toBe(true);
    expect(library.getItem(item.id)).toEqual(expected);
    expect(expected?.intelligence).toEqual(before.intelligence);
    const report = library.evaluations.report(run.id)!;
    expect(report.snapshots[0]!.expectedLabels).toEqual(gold());
    expect(report.snapshots[0]!.metadata.imageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.snapshots[0]!.metadata.system).toContain('untrusted DATA');
    expect(report.snapshots[0]!.rawOutput).toEqual(analysisFixture());
  });
  it('records invalid output without retries or silently repairing motion predictions', async () => {
    await prepare();
    generate = async (request) => { requests.push(request); const output = analysisFixture(); output.labels.motion = [{ value: 'static', confidence: 1 }]; return { output: request.modelId === models[0] ? null : output, inputTokens: 100, outputTokens: 100 }; };
    const run = await service.startEvaluation('No repair', models, [item.id]);
    await service.runOnce(); await service.runOnce(); await service.runOnce();
    expect(requests).toHaveLength(2);
    const result = library.evaluations.run(run.id)!;
    expect(result.trials.find((trial) => trial.modelId === models[0])?.schemaValid).toBe(false);
    const other = result.trials.find((trial) => trial.modelId === models[1])!;
    expect(other.result?.labels.motion[0]?.value).toBe('static');
    expect(other.scores?.exactAgreement).toBe(0.5);
  });
  it('distinguishes schema-valid but vocabulary/palette-invalid output', async () => {
    await prepare();
    generate = async (request) => { requests.push(request); return { output: analysisFixture('#FFFFFF'), inputTokens: 100, outputTokens: 100 }; };
    const run = await service.startEvaluation('Invalid palette', models, [item.id]);
    await service.runOnce(); await service.runOnce();
    expect(library.evaluations.run(run.id)?.summaries.every((summary) => summary.responses === 1 && summary.schemaValid === 1 && summary.valid === 0 && summary.scores.recall === 0)).toBe(true);
  });
  it('does not impose a separate allowance limit on evaluations or block them on historical estimates', async () => {
    await prepare();
    const run = await service.startEvaluation('Go-managed usage', models, [item.id]);
    const trial = library.evaluations.claim()!;
    const call = library.intelligence.beginEvaluationCall(trial, trial.model_id)!;
    library.intelligence.settle(call, null, null);
    direct('UPDATE model_calls SET reserved_usd=1000000,accounted_usd=1000000 WHERE id=?', call);
    library.evaluations.finish(trial, null, null, 1, 'Unknown result.');
    await service.runOnce();
    expect(requests).toHaveLength(1);
    expect(service.status().analysis).toBe('running');
    expect(library.evaluations.run(run.id)?.status).toBe('completed');
    expect(library.evaluations.run(run.id)).not.toHaveProperty('conservativeUpperUsd');
  });
  it('cancels in-flight calls conservatively, retains uncertain usage, and rejects late results', async () => {
    await prepare();
    const run = await service.startEvaluation('Cancel', models, [item.id]);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    generate = async (request) => { requests.push(request); entered(); await new Promise<void>((_, reject) => request.signal.addEventListener('abort', () => reject(new ProviderError('timeout')), { once: true })); throw new Error('unreachable'); };
    const work = service.runOnce(); await started;
    service.cancelEvaluation(run.id); await work;
    expect(library.evaluations.run(run.id)?.trials.every((trial) => trial.status === 'cancelled')).toBe(true);
    expect(service.status().usage.uncertainCalls).toBe(1);
    expect(service.status().settings.allowImageSharing).toBe(true);
    await service.runOnce(); expect(requests).toHaveLength(1);
  });
  it('recovers crashed trials without resending and refuses stale writes', async () => {
    await prepare(); const run = await service.startEvaluation('Recovery', models, [item.id]);
    const trial = library.evaluations.claim()!;
    library.intelligence.beginEvaluationCall(trial, trial.model_id);
    direct("UPDATE evaluation_trials SET lease_until='2000-01-01' WHERE id=?", trial.id);
    const next = library.evaluations.claim()!;
    library.evaluations.finish(trial, analysisFixture(), true, 1, null);
    expect(library.evaluations.run(run.id)?.trials.find((row) => row.id === trial.id)?.status).toBe('failed');
    expect(service.status().usage.uncertainCalls).toBe(1);
    expect(next.id).not.toBe(trial.id);
  });
  it('detects changed image inputs before sending a request', async () => {
    await prepare(); const run = await service.startEvaluation('Image integrity', models, [item.id]);
    const path = join(directory, library.getAsset(item.id, 'preview')!.path);
    const original = await readFile(path); await writeFile(path, await imageFixture('#102030'));
    await service.runOnce(); await service.runOnce(); await writeFile(path, original);
    expect(requests).toHaveLength(0);
    expect(library.evaluations.run(run.id)?.trials.every((trial) => trial.error?.includes('changed'))).toBe(true);
  });
  it('requires authentication and explicit model-call confirmation; exports complete frozen JSON and CSV', async () => {
    await prepare(); const app = createApp({ library, libraryDir: directory, token: 'test-token', port: 4317, ai: service });
    expect((await app.request('http://127.0.0.1:4317/api/evaluations')).status).toBe(401);
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    expect((await app.request('http://127.0.0.1:4317/api/evaluations', { method: 'POST', headers, body: JSON.stringify({ name: 'No consent', modelIds: models, sampleIds: [item.id] }) })).status).toBe(400);
    const response = await app.request('http://127.0.0.1:4317/api/evaluations', { method: 'POST', headers, body: JSON.stringify({ name: 'Export test', modelIds: models, sampleIds: [item.id], confirmModelCalls: true }) });
    expect(response.status).toBe(202); const run = await response.json();
    await service.runOnce(); await service.runOnce();
    const exported = await app.request(`http://127.0.0.1:4317/api/evaluations/${run.id}/export`, { headers });
    expect((await exported.json()).snapshots).toHaveLength(2);
    const csv = await app.request(`http://127.0.0.1:4317/api/evaluations/${run.id}/export?format=csv`, { headers });
    expect(csv.headers.get('content-type')).toContain('text/csv'); expect(await csv.text()).toContain('exact_facet_agreement');
    expect((await app.request('http://127.0.0.1:4317/api/evaluation/samples/export', { headers })).status).toBe(200);
  });
  it('rejects oversized inputs before creating a run or making a request', async () => {
    await prepare(); const usage = service.status().usage;
    library.updateItem(item.id, { title: item.title, note: 'x'.repeat(65_000) });
    await expect(service.startEvaluation('Too large', models, [item.id])).rejects.toThrow(/No request/);
    expect(library.evaluations.listRuns()).toEqual([]);
    expect(service.status().usage).toEqual(usage);
    expect(requests).toHaveLength(0);
  });
  it('interrupts a Contributor evaluation when separate training permission is revoked', async () => {
    await prepare(); service.updateSettings({ ...service.status().settings, allowModelTraining: true });
    await service.startEvaluation('Training revocation', [models[0]!, 'muse-spark-1.3-contributor'], [item.id]);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    generate = async (request) => {
      requests.push(request);
      if (request.modelId.includes('contributor')) {
        entered(); await new Promise<void>((_, reject) => request.signal.addEventListener('abort', () => reject(new ProviderError('timeout')), { once: true }));
      }
      return { output: analysisFixture(), inputTokens: 100, outputTokens: 100 };
    };
    const work = (async () => { await service.runOnce(); await service.runOnce(); })();
    await started; service.updateSettings({ ...service.status().settings, allowModelTraining: false }); await work;
    expect(service.status().settings.allowModelTraining).toBe(false);
    expect(service.status().usage.uncertainCalls).toBe(1);
    expect(service.status().analysis).toBe('running');
  });
});
