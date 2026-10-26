import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

export async function temporaryLibrary() {
  const root = join(tmpdir(), 'opencode');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, 'design-index-test-'));
}

export function imageFixture(color = '#7C5CFF') {
  return sharp({ create: { width: 48, height: 32, channels: 3, background: color } }).png().toBuffer();
}
