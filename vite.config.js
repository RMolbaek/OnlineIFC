import { defineConfig } from 'vite';

// base: './' gør at det byggede site virker fra enhver undermappe (fx GitHub Pages).
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 5000 },
  optimizeDeps: { exclude: ['web-ifc'] },
});
