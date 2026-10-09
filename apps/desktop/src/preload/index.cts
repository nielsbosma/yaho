// The only bridge between the renderer and Electron: connection details plus the desktop-only features.
const { contextBridge, ipcRenderer } = require('electron');

const arg = (name: string): string => {
  const prefix = `--${name}=`;
  return process.argv.find((a: string) => a.startsWith(prefix))?.slice(prefix.length) ?? '';
};

contextBridge.exposeInMainWorld('yahoDesktop', {
  apiUrl: arg('yaho-api'),
  token: arg('yaho-token'),
  setBadge: (n: number) => ipcRenderer.send('yaho:badge', n),
  notify: (title: string, body: string) => ipcRenderer.send('yaho:notify', title, body),
  reveal: (path: string) => ipcRenderer.send('yaho:reveal', path),
  openExternal: (url: string) => ipcRenderer.send('yaho:open', url),
  setTheme: (theme: string) => ipcRenderer.send('yaho:theme', theme),
  onNavigate: (cb: (route: string) => void) => ipcRenderer.on('yaho:navigate', (_e: unknown, route: string) => cb(route)),
});
