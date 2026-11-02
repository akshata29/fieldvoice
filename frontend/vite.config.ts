import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Hash routing (default) needs no server-side SPA fallback, so the built app works when the Python backend serves
// frontend/dist as plain static files from any mount point. Set VITE_ROUTER=browser if the backend rewrites
// unknown paths to index.html (and the app is mounted at "/").
const browserRouter = process.env.VITE_ROUTER === 'browser';

// Where the dev server proxies /api and /ws (scripts\run_backend.bat uses the same FV_API_PORT, default 8010).
const apiPort = process.env.FV_API_PORT ?? '8010';

export default defineConfig({
  base: browserRouter ? '/' : './',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true, changeOrigin: true },
    },
  },
  preview: { port: 4173 },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    css: false,
    testTimeout: 20_000,
  },
});
