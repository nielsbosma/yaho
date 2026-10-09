import { useEffect, useState } from 'react';

/** Hash routes, so the same build works from file://, Electron and the core's web server. */
export function useRoute(): string[] {
  const parse = () => (location.hash.replace(/^#\/?/, '') || 'inbox').split('?')[0]!.split('/').filter(Boolean).map(decodeURIComponent);
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const href = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join('/')}`;

export function go(...parts: string[]): void {
  location.hash = href(...parts);
}
