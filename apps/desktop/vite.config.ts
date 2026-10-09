import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

/** The renderer: a plain web app. Electron and the core's web server both load its build. */
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  server: { port: 4710, strictPort: true },
});
