import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { CapturePolicyError, createBrowserCapturer, createNetworkPolicy, normalizeLocalOrigin } from '@design-index/capture';
import type { CapturedPage, PageCapturer } from '@design-index/capture';
import { extractPalette, rgbToOklab } from '@design-index/palette';
import { captureSettingsSchema, MAX_IMAGE_PIXELS } from '@design-index/shared';
import type { CaptureResult, PaletteColor, UrlCaptureRequest } from '@design-index/shared';
import type { CaptureClaim, Library } from '@design-index/database';

export async function saveCapturedPage(library: Library, libraryDir: string, captured: CapturedPage, request: UrlCaptureRequest, mayCommit = () => true): Promise<CaptureResult> {
  const hash = createHash('sha256').update('url\0').update(captured.finalUrl).update(captured.fullPage).update(captured.viewport).update(captured.mobile).update(JSON.stringify(captured.facts)).digest('hex');
  const existing = library.findByHash(hash);
  if (existing) return { item: existing, deduplicated: true };
  const buffers = [captured.fullPage, captured.viewport, captured.mobile];
  if (buffers.reduce((sum, buffer) => sum + buffer.length, 0) > 30 * 1024 * 1024) throw new CapturePolicyError('Capture exceeded the image storage limit.');
  const metadata = await Promise.all(buffers.map((buffer) => sharp(buffer, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' }).metadata()));
  if (metadata.some((info) => info.format !== 'png' || !info.width || !info.height)) throw new CapturePolicyError('Capture did not produce valid PNG images.');
  const preview = await sharp(captured.viewport).resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
  const pixels = await sharp(captured.viewport).resize({ width: 96, height: 96, fit: 'inside' }).ensureAlpha().raw().toBuffer();
  const palette: PaletteColor[] = captured.facts.colors.map((color) => ({ hex: color.hex, weight: color.weight * 0.75, source: 'css', role: null, oklab: rgbToOklab(...[1, 3, 5].map((start) => Number.parseInt(color.hex.slice(start, start + 2), 16)) as [number, number, number]) }));
  for (const color of extractPalette(pixels)) if (!palette.some((prior) => prior.hex === color.hex) && palette.length < 12) palette.push({ ...color, weight: color.weight * (captured.facts.colors.length ? 0.25 : 1) });
  const total = palette.reduce((sum, color) => sum + color.weight, 0) || 1;
  for (const color of palette) color.weight /= total;
  const id = randomUUID(), directory = join(libraryDir, 'images', id);
  await mkdir(directory, { recursive: true });
  const path = (name: string) => `images/${id}/${name}`;
  try {
    await Promise.all([['full-page.png', captured.fullPage], ['viewport.png', captured.viewport], ['mobile.png', captured.mobile], ['preview.webp', preview.data]].map(([name, buffer]) => writeFile(join(directory, name as string), buffer as Buffer, { flag: 'wx' })));
    if (!mayCommit()) throw new CapturePolicyError('Capture was cancelled or its lease expired.');
    const saved = library.createImage({ id, type: 'url', sourceUrl: captured.finalUrl, facts: captured.facts, title: request.title || captured.title || new URL(captured.finalUrl).hostname, note: request.note, contentHash: hash,
      width: metadata[1]!.width!, height: metadata[1]!.height!,
      original: { kind: 'full_page', path: path('full-page.png'), mime: 'image/png', width: metadata[0]!.width!, height: metadata[0]!.height! },
      preview: { path: path('preview.webp'), width: preview.info.width, height: preview.info.height },
      additionalAssets: [{ kind: 'viewport', path: path('viewport.png'), mime: 'image/png', width: metadata[1]!.width!, height: metadata[1]!.height! }, { kind: 'mobile', path: path('mobile.png'), mime: 'image/png', width: metadata[2]!.width!, height: metadata[2]!.height! }], palette,
    });
    if (saved.deduplicated) await rm(directory, { recursive: true, force: true });
    return saved;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export function createCaptureService(options: { library: Library; libraryDir: string; port: number; capturer?: PageCapturer }) {
  const store = options.library.captures;
  const capturer = options.capturer ?? createBrowserCapturer();
  const protectedPorts = [...new Set([4317, 5173, options.port])];
  let interval: NodeJS.Timeout | undefined, active: Promise<void> | undefined, abort: AbortController | undefined, current: CaptureClaim | undefined, stopping = false;
  function settings() { return store.settings(); }
  async function work() {
    if (stopping) return;
    const job = store.claim(); if (!job) return;
    current = job; abort = new AbortController();
    try {
      const capture = await capturer.capture(job.request, settings().approvedLocalOrigins, protectedPorts, abort.signal);
      const result = await saveCapturedPage(options.library, options.libraryDir, capture, job.request, () => !stopping && !abort?.signal.aborted && store.owns(job));
      store.finish(job, { itemId: result.item.id, deduplicated: result.deduplicated });
    } catch (error) { store.finish(job, { error: error instanceof CapturePolicyError ? error.message : 'Capture failed while storing local images. Check available disk space and browser installation.' }); }
    finally { abort = undefined; current = undefined; }
  }
  function runOnce() { active ??= work().finally(() => { active = undefined; }); return active; }
  function wake() { if (interval && !stopping) void runOnce().catch(() => { stopping = true; }); }
  return {
    settings, list: store.list, runOnce,
    queue(request: UrlCaptureRequest) { createNetworkPolicy(request.url, settings().approvedLocalOrigins, protectedPorts).check(request.url); const job = store.queue(request); wake(); return job; },
    updateSettings(input: unknown) {
      const parsed = captureSettingsSchema.safeParse(input);
      if (!parsed.success) throw new CapturePolicyError('Provide up to 10 approved local origins.');
      const approvedLocalOrigins = [...new Set(parsed.data.approvedLocalOrigins.map((value) => normalizeLocalOrigin(value, protectedPorts)))];
      store.setSettings({ approvedLocalOrigins });
      if (current) { try { createNetworkPolicy(current.request.url, approvedLocalOrigins, protectedPorts).check(current.request.url); } catch { abort?.abort(); } }
      return settings();
    },
    cancel(id: string) { store.cancel(id); if (current?.id === id) abort?.abort(); },
    start() { interval ??= setInterval(wake, 750); interval.unref(); wake(); },
    async stop() { stopping = true; if (interval) clearInterval(interval); abort?.abort(); await active; },
  };
}
export type CaptureService = ReturnType<typeof createCaptureService>;
