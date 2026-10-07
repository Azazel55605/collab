import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  root: __dirname,
  resolve: { alias: { '@': path.resolve(__dirname, '../../src') } },
  clearScreen: false,
  server: {
    host: host ? '0.0.0.0' : false,
    port: 1422,
    strictPort: true,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1423,
        }
      : undefined,
  },
  build: {
    outDir: '../../dist-mobile',
    emptyOutDir: true,
  },
});
