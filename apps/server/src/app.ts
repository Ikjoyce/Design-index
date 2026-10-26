import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Library } from '@design-index/database';
import { captureFieldsSchema, editItemSchema, MAX_UPLOAD_BYTES, paletteToCss, searchSchema } from '@design-index/shared';
import { InvalidImageError, saveImage } from './images.js';

interface AppOptions {
  library: Library;
  libraryDir: string;
  token: string;
  port: number;
  webDir?: string;
  development?: boolean;
}

function matchesToken(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createApp(options: AppOptions) {
  const { library, libraryDir, token, port } = options;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map((host) => `http://${host}`));
  if (options.development) origins.add('http://127.0.0.1:5173');
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

  app.get('/api/status', (context) => context.json({
    analysis: 'not_configured', queued: library.queueCount(),
    message: 'Images and palettes are local. AI labels and prompts are not implemented yet.',
  }));

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
    return context.body(paletteToCss(item.palette));
  });

  app.get('/api/items/:id/assets/:kind', async (context) => {
    const kind = context.req.param('kind');
    if (kind !== 'original' && kind !== 'preview') return context.json({ error: 'Asset not found.' }, 404);
    const asset = library.getAsset(context.req.param('id'), kind);
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
    app.use('/assets/*', serveStatic({ root: options.webDir }));
    app.get('/', serveStatic({ root: options.webDir, path: 'index.html' }));
  }
  app.notFound((context) => context.json({ error: 'Not found.' }, 404));
  app.onError((error, context) => {
    if (error instanceof InvalidImageError) return context.json({ error: error.message }, 422);
    if (error instanceof HTTPException) return error.getResponse();
    // Do not expose paths, database statements, or captured content to browser clients/logs.
    console.error(`Request failed (${error.name}).`);
    return context.json({ error: 'Could not complete the request. Check that the library folder is writable and has free space.' }, 500);
  });
  return app;
}
