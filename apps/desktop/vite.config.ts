import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite-plus';

/**
 * The built page runs only its own scripts. Data, images and media may come from the core wherever it listens (a
 * configured host, not only 127.0.0.1), and service logos from the web. Dev leaves it out: HMR and React Refresh inject
 * inline scripts.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' blob: http: https:",
  "connect-src 'self' http: https:",
  "frame-src 'self' http: https:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const csp = (): Plugin => ({
  name: 'yaho-csp',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
});

/** The renderer: a plain web app. Electron and the core's web server both load its build. */
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), tailwindcss(), csp()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  server: { port: 4710, strictPort: true },
  // tools/package.mjs bundles the Electron main process and preload from here; Electron itself is provided at run time.
  pack: { deps: { neverBundle: ['electron'] } },
});
