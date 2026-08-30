import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Where `pnpm admin:dev` sends /api and /health. The default matches a server
// started natively (`cargo run -p collab-server` listens on 8787). The Compose
// stack publishes its gateway on 8788 instead, so point this at that port when
// the server runs in Docker:
//
//   COLLAB_ADMIN_PROXY_TARGET=http://127.0.0.1:8788 pnpm admin:dev
const proxyTarget = process.env.COLLAB_ADMIN_PROXY_TARGET ?? 'http://127.0.0.1:8787';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/admin/',
  plugins: [react()],
  server: {
    port: 1430,
    proxy: {
      '/api': proxyTarget,
      '/health': proxyTarget,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
