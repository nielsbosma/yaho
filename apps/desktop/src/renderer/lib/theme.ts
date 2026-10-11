import { useSyncExternalStore } from 'react';
import { platform } from './platform.ts';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'yaho-theme';

/** A per-device preference, so it lives in localStorage; the page still works when storage is unavailable. */
export function savedTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(t: Theme): void {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  platform.setTheme?.(t);
  syncTitleBar();
}

let surface: 'bg' | 'sidebar' = 'bg';

/**
 * Recolor the window buttons (Windows, Linux) to the surface they sit on: the page, or the chat panel when it is
 * open on the right. Runs after theme, palette and system changes, once the new colors are computed.
 */
export function syncTitleBar(on?: 'bg' | 'sidebar'): void {
  if (on) surface = on;
  if (!platform.setTitleBar) return;
  requestAnimationFrame(() => {
    const css = getComputedStyle(document.documentElement);
    const hex = (v: string) => css.getPropertyValue(v).trim();
    const bg = hex(surface === 'sidebar' ? '--c-sidebar' : '--c-bg');
    const ink = hex('--c-ink');
    if (bg && ink) platform.setTitleBar!(bg, ink);
  });
}

if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => syncTitleBar());
}

/** The mode, shared by every switch that shows it (the sidebar, Settings). */
const theme = shared<Theme>(savedTheme, (t) => {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* remembered for this session only */
  }
  applyTheme(t);
});

export function useTheme(): [Theme, (t: Theme) => void] {
  return [useSyncExternalStore(theme.subscribe, theme.get), theme.set];
}

/** Color themes: they change the accent (buttons, links, charts, selection). Light and dark come from Theme. */
export const PALETTES = [
  { id: 'forest', label: 'Forest', light: '#2f7a5b', dark: '#5fbf8f' },
  { id: 'ocean', label: 'Ocean', light: '#2867a8', dark: '#6aa6e8' },
  { id: 'indigo', label: 'Indigo', light: '#4f52c4', dark: '#9a9cf2' },
  { id: 'plum', label: 'Plum', light: '#8a3f86', dark: '#d38ccf' },
  { id: 'rose', label: 'Rose', light: '#b23b58', dark: '#ec8aa0' },
  { id: 'amber', label: 'Amber', light: '#96570b', dark: '#e3a654' },
  { id: 'slate', label: 'Slate', light: '#4a5560', dark: '#a9b6c2' },
] as const;
export type Palette = (typeof PALETTES)[number]['id'];
const PALETTE_KEY = 'yaho-palette';

export function savedPalette(): Palette {
  try {
    const p = localStorage.getItem(PALETTE_KEY);
    return PALETTES.some((x) => x.id === p) ? (p as Palette) : 'forest';
  } catch {
    return 'forest';
  }
}

export function applyPalette(p: Palette): void {
  if (p === 'forest') delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = p;
  syncTitleBar();
}

const palette = shared<Palette>(savedPalette, (p) => {
  try {
    localStorage.setItem(PALETTE_KEY, p);
  } catch {
    /* remembered for this session only */
  }
  applyPalette(p);
});

export function usePalette(): [Palette, (p: Palette) => void] {
  return [useSyncExternalStore(palette.subscribe, palette.get), palette.set];
}

/** A value outside React that components subscribe to; setting it saves and applies it once, and every subscriber re-renders. */
function shared<T>(initial: () => T, onSet: (v: T) => void) {
  let value: T | undefined;
  const listeners = new Set<() => void>();
  return {
    get: (): T => (value ??= initial()),
    set: (v: T) => {
      value = v;
      onSet(v);
      for (const l of listeners) l();
    },
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}
