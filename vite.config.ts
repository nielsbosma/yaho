import { defineConfig } from 'vite-plus';

export default defineConfig({
  fmt: {
    singleQuote: true,
    printWidth: 140,
    ignorePatterns: ['.plan/**', '**/dist/**'],
  },
  lint: {
    ignorePatterns: ['.plan/**', '**/dist/**'],
  },
  run: {
    cache: true,
  },
});
