import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Library } from '@design-index/database';
import { ConflictError } from '@design-index/database';
import { ASSET_KINDS, canonicalLabel, captureFieldsSchema, editItemSchema, evaluationRunSchema, evaluationSampleSchema, labelEditSchema, MAX_UPLOAD_BYTES, paletteToCss, promptEditSchema, promptGenerateSchema, promptHistorySchema, promptRestoreSchema, searchSchema, urlCaptureSchema, vocabularyEditSchema, vocabularyRenameSchema } from '@design-index/shared';
import type { AssetKind } from '@design-index/shared';
import { InvalidImageError, saveImage } from './images.js';
import { AiConfigurationError, createAiService } from './ai.js';
import type { AiService } from './ai.js';
import { CapturePolicyError } from '@design-index/capture';
import { createCaptureService } from './capture.js';
import type { CaptureService } from './capture.js';
import { createInboxService, InboxConfigurationError } from './inbox.js';
import type { InboxService } from './inbox.js';

interface AppOptions {
  library: Library;
  libraryDir: string;
  token: string;
  port: number;
  webDir?: string;
  development?: boolean;
  ai?: AiService;
  captures?: CaptureService;
  inbox?: InboxService;
}

function matchesToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createApp(options: AppOptions) {
  const { library, libraryDir, token, port } = options;
  const ai = options.ai ?? createAiService({ library, libraryDir });
  const captures = options.captures ?? createCaptureService({ library, libraryDir, port });
  const inbox = options.inbox ?? createInboxService({ library, libraryDir });
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map((host) => `http://${host}`));
  if (options.development) {
    origins.add('http://127.0.0.1:5173');
    origins.add('http://localhost:5173');
  }
  const app = new Hono();

  app.use('*', async (context, next) => {
    const host = context.req.header('host') || new URL(context.req.url).host;
    if (!hosts.has(host)) return context.json({ error: 'Unrecognized local host.' }, 403);
    const origin = context.req.header('origin');
    if ((origin && !origins.has(origin)) || context.req.header('sec-fetch-site') === 'cross-site') {
      return context.json({ error: 'Cross-origin requests are not allowed.' }, 403);
    }
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('X-Frame-Options', 'DENY');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    await next();
  });

  app.get('/api/health', (context) => context.json({ status: 'ok' }));
  app.get('/api/session', (context) => {
    setCookie(context, 'design_index_session', token, {
      httpOnly: true, sameSite: 'Strict', path: '/api', maxAge: 60 * 60 * 24,
    });
    context.header('Cache-Control', 'no-store');
    return context.json({ ready: true });
  });

  app.use('/api/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    const bearer = context.req.header('authorization')?.replace(/^Bearer /, '');
    const cookie = getCookie(context, 'design_index_session');
    if (!matchesToken(bearer, token) && !matchesToken(cookie, token)) {
      return context.json({ error: 'Local authentication required. Reload the library to reconnect.' }, 401);
    }
    await next();
  });

  app.get('/api/status', (context) => context.json(ai.status()));
  app.get('/api/ai', (context) => context.json(ai.status()));
  app.get('/api/inbox', (context) => context.json(inbox.status()));
  app.post('/api/inbox/retry', (context) => context.json(inbox.retryFailures()));
  app.put('/api/ai', bodyLimit({ maxSize: 4096 }), async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: 'Expected JSON AI settings.' }, 400); }
    return context.json(ai.updateSettings(body));
  });
  app.post('/api/ai/models/refresh', async (context) => {
    try { return context.json(await ai.refreshModels()); }
    catch { return context.json({ error: 'Could not refresh the public model catalog. No model call was made.' }, 502); }
  });

  app.get('/api/captures', (context) => context.json({ settings: captures.settings(), jobs: captures.list() }));
  app.put('/api/captures/settings', bodyLimit({ maxSize: 4096 }), async (context) => {
    let body: unknown; try { body = await context.req.json(); } catch { return context.json({ error: 'Expected capture settings JSON.' }, 400); }
    return context.json(captures.updateSettings(body));
  });
  app.post('/api/captures', bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    let body: unknown; try { body = await context.req.json(); } catch { return context.json({ error: 'Expected a URL capture request.' }, 400); }
    const parsed = urlCaptureSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'Provide an HTTP(S) URL, optional title/note, and light/dark capture appearance.' }, 400);
    return context.json(captures.queue(parsed.data), 202);
  });
  app.post('/api/captures/:id/cancel', (context) => { captures.cancel(context.req.param('id')); return context.json({ cancelled: true }); });

  app.get('/api/evaluation/samples', (context) => context.json(library.evaluations.samples()));
  app.put('/api/evaluation/samples/:id', bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    let body: unknown; try { body = await context.req.json(); } catch { return context.json({ error: 'Expected hand-label JSON.' }, 400); }
    const parsed = evaluationSampleSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'Provide hand labels, at least one explicitly scored facet, a note, and the saved entry version (0 for a new entry).' }, 400);
    return context.json(library.evaluations.saveSample(context.req.param('id'), parsed.data.labels, parsed.data.scoredFacets, parsed.data.note, parsed.data.baseVersion));
  });
  app.delete('/api/evaluation/samples/:id', (context) => {
    const version = Number(context.req.query('version'));
    if (!Number.isSafeInteger(version) || version < 1) return context.json({ error: 'Provide the saved hand-label version.' }, 400);
    library.evaluations.removeSample(context.req.param('id'), version); return context.json({ removed: true });
  });
  app.get('/api/evaluation/samples/export', (context) => {
    context.header('Content-Disposition', 'attachment; filename="design-index-hand-labels.json"');
    return context.json({ version: 1, vocabulary: library.vocabulary.current(), entries: library.evaluations.samples() });
  });
  app.get('/api/evaluations', (context) => context.json(library.evaluations.listRuns()));
  app.post('/api/evaluations', bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    let body: unknown; try { body = await context.req.json(); } catch { return context.json({ error: 'Expected an evaluation request.' }, 400); }
    const parsed = evaluationRunSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'Choose 2–4 distinct vision models, 1–30 hand-labeled references, a name, and explicitly confirm model calls.' }, 400);
    return context.json(await ai.startEvaluation(parsed.data.name, parsed.data.modelIds, parsed.data.sampleIds), 202);
  });
  app.get('/api/evaluations/:id', (context) => {
    const run = library.evaluations.run(context.req.param('id')); return run ? context.json(run) : context.json({ error: 'Evaluation not found.' }, 404);
  });
  app.post('/api/evaluations/:id/cancel', (context) => context.json(ai.cancelEvaluation(context.req.param('id'))));
  app.get('/api/evaluations/:id/export', (context) => {
    const run = library.evaluations.run(context.req.param('id'));
    if (!run) return context.json({ error: 'Evaluation not found.' }, 404);
    if (context.req.query('format') === 'csv') {
      const rows = [['run_id', 'run_status', 'sample_count', 'model', 'finished', 'trials', 'attempted', 'responses', 'schema_valid', 'valid', 'precision', 'recall', 'f1', 'exact_facet_agreement', 'average_latency_ms', 'input_tokens', 'output_tokens'], ...run.summaries.map((summary) => [run.id, run.status, run.sampleCount, summary.modelId, summary.finished, summary.trials, summary.attempted, summary.responses, summary.schemaValid, summary.valid, summary.scores.precision, summary.scores.recall, summary.scores.f1, summary.scores.exactAgreement, summary.averageLatencyMs, summary.inputTokens, summary.outputTokens])];
      const csv = rows.map((row) => row.map((value) => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n');
      context.header('Content-Disposition', 'attachment; filename="evaluation-results.csv"'); context.header('Content-Type', 'text/csv; charset=utf-8'); return context.body(csv);
    }
    context.header('Content-Disposition', 'attachment; filename="evaluation-results.json"'); return context.json(library.evaluations.report(run.id));
  });

  app.get('/api/vocabulary', (context) => context.json(library.vocabulary.get()));
  app.put('/api/vocabulary', bodyLimit({ maxSize: 32 * 1024 }), async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: 'Expected vocabulary JSON.' }, 400); }
    const parsed = vocabularyEditSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'Provide the current revision and unique lowercase kebab-case labels (1–60 per facet, at most 20,000 characters total). Keep motion:unknown.' }, 400);
    return context.json(library.vocabulary.save(parsed.data.baseRevision, parsed.data.terms));
  });
  app.post('/api/vocabulary/rename', bodyLimit({ maxSize: 2048 }), async (context) => {
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: 'Expected a label rename/merge.' }, 400); }
    const parsed = vocabularyRenameSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'Provide a current revision, facet, source label, and different lowercase kebab-case target.' }, 400);
    return context.json(library.vocabulary.rename(parsed.data.baseRevision, parsed.data.facet, parsed.data.from, parsed.data.to));
  });

  app.get('/api/items', (context) => {
    const parsed = searchSchema.safeParse(context.req.query());
    if (!parsed.success) return context.json({ error: 'Invalid search. Use up to 200 characters and a limit of 1–100.' }, 400);
    return context.json(library.search(parsed.data));
  });

  app.post('/api/items', bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 64 * 1024, onError: (context) => context.json({ error: 'Image upload exceeds 20 MB.' }, 413) }), async (context) => {
    let data: FormData;
    try { data = await context.req.formData(); }
    catch { return context.json({ error: 'Expected multipart form data with an image file.' }, 400); }
    const file = data.get('image');
    if (!(file instanceof File)) return context.json({ error: 'Choose an image file.' }, 400);
    if (!file.size || file.size > MAX_UPLOAD_BYTES) return context.json({ error: 'Choose a nonempty image under 20 MB.' }, 413);
    const fields = captureFieldsSchema.safeParse({ title: data.get('title') ?? '', note: data.get('note') ?? '' });
    if (!fields.success) return context.json({ error: 'Title must be under 160 characters and note under 2,000.' }, 400);
    const result = await saveImage(library, libraryDir, Buffer.from(await file.arrayBuffer()), fields.data);
    return context.json(result, result.deduplicated ? 200 : 201);
  });

  app.get('/api/items/:id', (context) => {
    const item = library.getItem(context.req.param('id'));
    return item ? context.json(item) : context.json({ error: 'Reference not found.' }, 404);
  });

  app.post('/api/items/:id/analyze', (context) => {
    const item = library.getItem(context.req.param('id'));
    if (!item) return context.json({ error: 'Reference not found.' }, 404);
    ai.retry(item.id);
    return context.json({ queued: true }, 202);
  });

  app.get('/api/items/:id/prompts', (context) => {
    const item = library.getItem(context.req.param('id'));
    if (!item) return context.json({ error: 'Reference not found.' }, 404);
    const parsed = promptHistorySchema.safeParse(context.req.query());
    if (!parsed.success) return context.json({ error: 'Choose agent, general, or vibe and valid history pagination.' }, 400);
    return context.json(library.intelligence.promptHistory(item.id, parsed.data.variant, parsed.data.limit, parsed.data.offset));
  });

  app.post('/api/items/:id/prompts', bodyLimit({ maxSize: 2048 }), async (context) => {
    const item = library.getItem(context.req.param('id'));
    if (!item) return context.json({ error: 'Reference not found.' }, 404);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: 'Expected a prompt variant.' }, 400); }
    const parsed = promptGenerateSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'Choose agent, general, or vibe.' }, 400);
    ai.generatePrompt(item.id, parsed.data.variant);
    return context.json({ queued: true }, 202);
  });

  app.post('/api/items/:id/prompts/:revisionId/restore', bodyLimit({ maxSize: 2048 }), async (context) => {
    const item = library.getItem(context.req.param('id'));
    if (!item) return context.json({ error: 'Reference not found.' }, 404);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: 'Expected a variant and base version.' }, 400); }
    const parsed = promptRestoreSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'Provide a prompt variant and the currently saved version (or 0 if absent).' }, 400);
    library.intelligence.restorePrompt(item.id, context.req.param('revisionId'), parsed.data.variant, parsed.data.baseVersion);
    return context.json(library.getItem(item.id));
  });

  app.patch('/api/items/:id/labels', bodyLimit({ maxSize: 2048 }), async (context) => {
    const item = library.getItem(context.req.param('id'));
    if (!item) return context.json({ error: 'Reference not found.' }, 404);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: 'Expected a label decision.' }, 400); }
    const parsed = labelEditSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'Choose a valid vocabulary label and accept/reject state.' }, 400);
    const vocabulary = library.vocabulary.current();
    const value = canonicalLabel(vocabulary, parsed.data.facet, parsed.data.value);
    if (!vocabulary.terms[parsed.data.facet].includes(value) && !item.intelligence.labels.some((label) => label.facet === parsed.data.facet && label.value === value)) return context.json({ error: 'Choose an active vocabulary label, or review an existing retired label.' }, 400);
    library.intelligence.editLabel(item.id, parsed.data.facet, value, parsed.data.state);
    return context.json(library.getItem(item.id));
  });

  app.patch('/api/items/:id/prompt', bodyLimit({ maxSize: 100 * 1024 }), async (context) => {
    const item = library.getItem(context.req.param('id'));
    if (!item) return context.json({ error: 'Reference not found.' }, 404);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: 'Expected prompt text and its base version.' }, 400); }
    const parsed = promptEditSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'Provide prompt text (up to 20,000 characters) and its current version.' }, 400);
    library.intelligence.editPrompt(item.id, parsed.data.body, parsed.data.baseVersion, parsed.data.variant);
    return context.json(library.getItem(item.id));
  });

  app.patch('/api/items/:id', bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    let data: unknown;
    try { data = await context.req.json(); }
    catch { return context.json({ error: 'Expected a JSON title and note.' }, 400); }
    const parsed = editItemSchema.safeParse(data);
    if (!parsed.success) return context.json({ error: 'Provide a title (1–160 characters) and a note (up to 2,000).' }, 400);
    const item = library.updateItem(context.req.param('id'), parsed.data);
    return item ? context.json(item) : context.json({ error: 'Reference not found.' }, 404);
  });

  app.get('/api/items/:id/palette.css', (context) => {
    const item = library.getItem(context.req.param('id'));
    if (!item) return context.json({ error: 'Reference not found.' }, 404);
    context.header('Content-Type', 'text/css; charset=utf-8');
    context.header('Content-Disposition', 'attachment; filename="design-palette.css"');
    return context.body(paletteToCss(item.palette, item.intelligence.analysis?.palette_roles));
  });

  app.get('/api/items/:id/assets/:kind', async (context) => {
    const kind = context.req.param('kind');
    if (!ASSET_KINDS.includes(kind as AssetKind)) return context.json({ error: 'Asset not found.' }, 404);
    const asset = library.getAsset(context.req.param('id'), kind as AssetKind);
    if (!asset) return context.json({ error: 'Asset not found.' }, 404);
    const path = resolve(libraryDir, asset.path);
    const within = relative(resolve(libraryDir), path);
    if (within.startsWith('..') || isAbsolute(within)) return context.json({ error: 'Invalid asset path.' }, 403);
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return context.json({ error: 'Image file is missing from the library.' }, 404);
      throw error;
    }
    context.header('Content-Type', asset.mime);
    if (kind === 'original') context.header('Content-Disposition', `attachment; filename="reference-${asset.itemId}.${asset.mime === 'image/jpeg' ? 'jpg' : asset.mime.split('/')[1]}"`);
    return context.body(new Uint8Array(bytes));
  });

  if (options.webDir) {
    app.get('/theme.js', serveStatic({ root: options.webDir, path: 'theme.js' }));
    app.use('/assets/*', serveStatic({ root: options.webDir }));
    app.get('/', serveStatic({ root: options.webDir, path: 'index.html' }));
  }
  app.notFound((context) => context.json({ error: 'Not found.' }, 404));
  app.onError((error, context) => {
    if (error instanceof InboxConfigurationError) return context.json({ error: error.message }, 400);
    if (error instanceof CapturePolicyError) return context.json({ error: error.message }, 400);
    if (error instanceof AiConfigurationError) return context.json({ error: error.message }, 400);
    if (error instanceof ConflictError) return context.json({ error: error.message }, 409);
    if (error instanceof InvalidImageError) return context.json({ error: error.message }, 422);
    if (error instanceof HTTPException) return error.getResponse();
    // Do not expose paths, database statements, or captured content to browser clients/logs.
    console.error(`Request failed (${error.name}).`);
    return context.json({ error: 'Could not complete the request. Check that the library folder is writable and has free space.' }, 500);
  });
  return app;
}
