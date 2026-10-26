import { build } from 'esbuild';

await build({
  entryPoints: { index: 'src/index.ts', server: 'src/server.ts' },
  outdir: 'dist',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  bundle: true,
  sourcemap: true,
  external: ['hono', '@hono/node-server', 'sharp', 'better-sqlite3', 'drizzle-orm', 'zod'],
});
