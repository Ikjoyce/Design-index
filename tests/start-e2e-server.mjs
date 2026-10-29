import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { startServer } from '../apps/server/dist/server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoot = join(tmpdir(), 'opencode');
await mkdir(temporaryRoot, { recursive: true });
const testRoot = await mkdtemp(join(temporaryRoot, 'design-index-e2e-'));
const libraryDir = join(testRoot, 'library'), inboxDir = join(testRoot, 'inbox');
// Deliberately synthetic: browser tests never load .env or contact Go.
const aiProvider = {
  async generate(request) {
    const input = JSON.parse(request.text);
    const palette = input.extracted_facts.palette;
    const hex = typeof palette[0] === 'string' ? palette[0] : palette[0].hex;
    const output = request.stage === 'analyze' ? {
      summary: 'A minimal interface with spacious rhythm.',
      labels: { style: [{ value: input.vocabulary.style.includes('minimal') ? 'minimal' : input.vocabulary.style[0], confidence: 0.9 }], color: [], layout: [{ value: input.vocabulary.layout.includes('spacious') ? 'spacious' : input.vocabulary.layout[0], confidence: 0.9 }], typography: [], motion: [{ value: 'unknown', confidence: 1 }], component: [{ value: input.vocabulary.component.includes('card') ? 'card' : input.vocabulary.component[0], confidence: 0.8 }] },
      palette_roles: { background: null, surface: null, text: null, 'muted-text': null, accent: hex, border: null },
      type_notes: 'A readable type class; exact font unknown.', motion_notes: 'Unknown.', free_tags: [], quality: { issues: [] }, review: { needs_review: false, reasons: [] },
    } : request.variant === 'vibe' ? { body: 'Intent: calm, spacious, purposeful. Avoid clutter and unmeasured animation.', assumptions: [] }
      : request.variant === 'general' ? { body: `## General design direction\nA calm design-tool reference with generous spacing and a ${hex} accent.\n\n## Avoid\nKeep branding and unsupported motion out of the result.`, assumptions: ['Spacing is inferred.'] }
        : { body: `## Intent\nA clean coding-agent interface with generous spacing and a ${hex} accent.\n\n## Avoid\nDo not copy brands or infer animation.`, assumptions: ['Spacing is inferred.'] };
    return { output, inputTokens: 100, outputTokens: 150 };
  },
};
const pageCapturer = {
  async capture(request) {
    const image = (width, height) => sharp({ create: { width, height, channels: 3, background: '#102030' } }).png().toBuffer();
    return { title: 'Synthetic URL fixture', finalUrl: request.url, fullPage: await image(1440, 2200), viewport: await image(1440, 1000), mobile: await image(390, 844),
      facts: { fonts: ['Arial'], styles: [], colors: [{ hex: '#102030', weight: 1 }], animations: [], transitions: [{ property: 'opacity', duration: '0.2s', easing: 'ease' }], libraries: [], warnings: ['Synthetic capture fixture; no website was visited.'], truncated: false } };
  },
};
const running = await startServer({ libraryDir, inboxDir, port: 14317, webDir: join(root, 'apps', 'web', 'dist'), aiKey: 'synthetic-e2e-key-not-real', aiProvider, pageCapturer });
console.log(`Isolated test library: ${running.url}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await running.stopServer();
    await rm(testRoot, { recursive: true, force: true });
    process.exit(0);
  });
}
