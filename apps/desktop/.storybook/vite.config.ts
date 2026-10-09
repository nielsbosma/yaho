import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

// Storybook gets the renderer's plugins, without the app's root or dev server settings.
export default defineConfig({ plugins: [react(), tailwindcss()] });
