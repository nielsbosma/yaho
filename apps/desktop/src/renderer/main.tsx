import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';
import { platform } from './lib/platform.ts';
import { applyTheme, savedTheme } from './lib/theme.ts';

// Before the first paint, so a dark choice never flashes light.
applyTheme(savedTheme());

// Claude Desktop's typefaces, served by the core from a local Claude install when there is one (see core/src/api/fonts.ts).
const fonts = document.createElement('link');
fonts.rel = 'stylesheet';
fonts.href = `${platform.apiUrl}/api/fonts/anthropic.css?base=${encodeURIComponent(platform.apiUrl)}`;
document.head.appendChild(fonts);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
