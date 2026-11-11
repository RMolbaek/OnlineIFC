import { defineConfig } from 'vite';

// base: './' makes the built site work from any sub folder (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 5000 },
  optimizeDeps: { exclude: ['web-ifc'] },
  worker: { format: 'es' },
});
