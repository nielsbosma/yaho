/**
 * Desktop-only features, behind one small interface. In Electron the preload provides `window.yahoDesktop`;
 * in a plain browser every feature falls back to a web equivalent.
 */
export interface Platform {
  kind: 'desktop' | 'web';
  apiUrl: string;
  token: string;
  /** Unread count on the tray / taskbar (desktop) or in the tab title (web). */
  setBadge(count: number): void;
  notify(title: string, body: string, onClick?: () => void): void;
  /** Show a file in Explorer/Finder. Web: download it instead. */
  reveal(path: string, downloadUrl: string): void;
  openExternal(url: string): void;
}

interface DesktopBridge {
  apiUrl: string;
  token: string;
  setBadge(count: number): void;
  notify(title: string, body: string): void;
  reveal(path: string): void;
  openExternal(url: string): void;
  onNotificationClick(cb: (id: string) => void): void;
}

declare global {
  interface Window {
    yahoDesktop?: DesktopBridge;
  }
}

function webToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('token');
  try {
    if (fromUrl) localStorage.setItem('yaho-token', fromUrl);
    return fromUrl ?? localStorage.getItem('yaho-token') ?? '';
  } catch {
    return fromUrl ?? '';
  }
}

function makePlatform(): Platform {
  const d = window.yahoDesktop;
  if (d) {
    return {
      kind: 'desktop',
      apiUrl: d.apiUrl,
      token: d.token,
      setBadge: (n) => d.setBadge(n),
      notify: (t, b) => d.notify(t, b),
      reveal: (p) => d.reveal(p),
      openExternal: (u) => d.openExternal(u),
    };
  }
  const baseTitle = document.title;
  const env = import.meta.env as Record<string, string | undefined>;
  return {
    kind: 'web',
    apiUrl: env.VITE_YAHO_API_URL ?? location.origin,
    token: webToken(),
    setBadge: (n) => {
      document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle;
    },
    notify: (title, body, onClick) => {
      if (!('Notification' in window)) return;
      const show = () => {
        const n = new Notification(title, { body });
        n.onclick = () => {
          window.focus();
          onClick?.();
        };
      };
      if (Notification.permission === 'granted') show();
      else if (Notification.permission !== 'denied') void Notification.requestPermission().then((p) => p === 'granted' && show());
    },
    reveal: (_path, url) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      a.click();
    },
    openExternal: (url) => window.open(url, '_blank', 'noopener'),
  };
}

export const platform = makePlatform();
