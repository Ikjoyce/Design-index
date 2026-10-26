import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', 'DESIGN_INDEX_');
  const target = `http://127.0.0.1:${env.DESIGN_INDEX_PORT || 4317}`;
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      cors: false,
      proxy: { '/api': { target, changeOrigin: true } },
    },
  };
});
