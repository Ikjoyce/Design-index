import { defineConfig, loadEnv } from 'vite';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', 'DESIGN_INDEX_');
  const target = `http://127.0.0.1:${env.DESIGN_INDEX_PORT || 4317}`;
  return {
    plugins: [react({ exclude: /(?:node_modules|design-index-vite)/ }), tailwindcss()],
    // Windows can deny cache-directory removal inside Documents. Keep disposable data in OS temp.
    cacheDir: join(tmpdir(), 'opencode', 'design-index-vite', createHash('sha256').update(fileURLToPath(new URL('.', import.meta.url))).digest('hex').slice(0, 12)),
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      cors: false,
      proxy: { '/api': { target, changeOrigin: true } },
    },
  };
});
