import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { extractPalette } from '@design-index/palette';
import { MAX_IMAGE_PIXELS, SUPPORTED_IMAGE_FORMATS } from '@design-index/shared';
import type { CaptureResult } from '@design-index/shared';
import type { Library } from '@design-index/database';

export class InvalidImageError extends Error {}

export async function saveImage(
  library: Library,
  libraryDir: string,
  bytes: Buffer,
  fields: { title: string; note: string },
): Promise<CaptureResult> {
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const existing = library.findByHash(contentHash);
  if (existing) return { item: existing, deduplicated: true };

  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!png && !jpeg && !webp) throw new InvalidImageError('Choose a PNG, JPEG, or WebP image.');

  let normalized: { preview: Buffer; width: number; height: number; previewWidth: number; previewHeight: number; format: string; pixels: Buffer };
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS, failOn: 'warning' });
    const metadata = await image.metadata();
    if (!SUPPORTED_IMAGE_FORMATS.some((format) => format === metadata.format)) {
      throw new Error('Unsupported image format.');
    }
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw new Error('Image dimensions exceed the limit.');
    if ((metadata.pages ?? 1) > 1) throw new Error('Animated images are not supported yet.');
    const preview = await image.clone().rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer({ resolveWithObject: true });
    const pixels = await image.clone().rotate().toColourspace('srgb').resize({ width: 96, height: 96, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer();
    const swapped = metadata.orientation && metadata.orientation >= 5;
    normalized = {
      preview: preview.data, previewWidth: preview.info.width, previewHeight: preview.info.height,
      width: swapped ? metadata.height : metadata.width,
      height: swapped ? metadata.width : metadata.height,
      format: metadata.format!, pixels,
    };
  } catch {
    throw new InvalidImageError('Use a valid, non-animated PNG, JPEG, or WebP image under 40 megapixels.');
  }

  const palette = extractPalette(normalized.pixels);
  if (!palette.length) throw new InvalidImageError('This image has no visible pixels to collect.');
  const id = randomUUID();
  // No part of the supplied filename becomes a filesystem path.
  const directory = join(libraryDir, 'images', id);
  const originalPath = `images/${id}/original.${normalized.format === 'jpeg' ? 'jpg' : normalized.format}`;
  const previewPath = `images/${id}/preview.webp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(join(libraryDir, originalPath), bytes, { flag: 'wx' });
    await writeFile(join(libraryDir, previewPath), normalized.preview, { flag: 'wx' });
    const result = library.createImage({
      id, title: fields.title || 'Untitled reference', note: fields.note, contentHash,
      width: normalized.width, height: normalized.height,
      original: { path: originalPath, mime: `image/${normalized.format}` },
      preview: { path: previewPath, width: normalized.previewWidth, height: normalized.previewHeight },
      palette,
    });
    // Concurrent identical captures can finish normalization together. Only their own unused directory is removed.
    if (result.deduplicated) await rm(directory, { recursive: true, force: true });
    return result;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
