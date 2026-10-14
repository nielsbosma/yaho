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
  reveal(path: string, download: () => Promise<void>): void | Promise<void>;
  /** Web and mail links only; anything else (file:, javascript:, a custom scheme) is ignored. */
  openExternal(url: string): void;
  /** Desktop: match native chrome (title bar, menus) to the chosen theme. */
  setTheme?(theme: 'system' | 'light' | 'dark'): void;
  /** Desktop: colors of the window buttons drawn over the page (Windows, Linux). */
  setTitleBar?(color: string, symbolColor: string): void;
  /** Desktop: the OS, for where the window buttons sit. */
  os?: string;
  /** Desktop: quit and start again (after an update). */
  restart?(): void;
  /** Desktop: make the desktop and Start menu shortcuts. */
  createShortcut?(): Promise<{ files: string[]; error?: string }>;
}

interface DesktopBridge {
  apiUrl: string;
  token: string;
  setBadge(count: number): void;
  notify(title: string, body: string): void;
  reveal(path: string): void;
  openExternal(url: string): void;
  onNavigate(cb: (route: string) => void): void;
  setTheme(theme: string): void;
  setTitleBar?(color: string, symbolColor: string): void;
  os?: string;
  createShortcut?(): Promise<{ files: string[]; error?: string }>;
  restart?(): void;
}

declare global {
  interface Window {
    yahoDesktop?: DesktopBridge;
  }
}

const linkOk = (url: string) => /^(https?:\/\/|mailto:)/i.test(url);

function webToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('token');
  // Out of the address bar and the history once read.
  if (fromUrl) {
    const u = new URL(location.href);
    u.searchParams.delete('token');
    history.replaceState(history.state, '', u);
  }
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
    // The tray and native notifications ask the window to show a page.
    d.onNavigate((route) => (location.hash = `#/${route}`));
    return {
      kind: 'desktop',
      apiUrl: d.apiUrl,
      token: d.token,
      setBadge: (n) => d.setBadge(n),
      notify: (t, b) => d.notify(t, b),
      reveal: (p) => d.reveal(p),
      openExternal: (u) => {
        if (linkOk(u)) d.openExternal(u);
      },
      setTheme: (t) => d.setTheme(t),
      setTitleBar: (c, s) => d.setTitleBar?.(c, s),
      os: d.os,
      createShortcut: d.createShortcut,
      restart: d.restart,
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
    reveal: (_path, download) => download(),
    openExternal: (url) => {
      if (linkOk(url)) window.open(url, '_blank', 'noopener');
    },
  };
}

export const platform = makePlatform();
