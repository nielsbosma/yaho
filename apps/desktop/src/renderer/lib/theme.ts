import { useEffect, useState } from 'react';
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
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(savedTheme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return [
    theme,
    (t) => {
      try {
        localStorage.setItem(KEY, t);
      } catch {
        /* remembered for this session only */
      }
      setTheme(t);
    },
  ];
}
