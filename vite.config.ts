import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
import { yahoDev } from './apps/desktop/dev.ts';
import desktop from './apps/desktop/vite.config.ts';

const repo = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  // `vp dev` here serves the desktop renderer and starts the core and Electron (see apps/desktop/dev.ts).
  root: 'apps/desktop/src/renderer',
  base: './',
  plugins: [...(desktop.plugins ?? []), yahoDev(repo)],
  server: desktop.server,
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
  fmt: {
    singleQuote: true,
    printWidth: 140,
    ignorePatterns: ['.plan/**', '**/dist/**'],
  },
  lint: {
    ignorePatterns: ['.plan/**', '**/dist/**'],
  },
  test: {
    include: ['{core,cli,apps}/**/*.test.ts'],
    root: '.',
    testTimeout: 30_000,
  },
  run: {
    cache: true,
  },
});
