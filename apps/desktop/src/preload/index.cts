// The only bridge between the renderer and Electron: connection details plus the desktop-only features.
// It runs sandboxed, so it may require nothing but electron.
const { contextBridge, ipcRenderer } = require('electron');

const connection: { url: string; token: string } | null = ipcRenderer.sendSync('yaho:connection');

contextBridge.exposeInMainWorld('yahoDesktop', {
  apiUrl: connection?.url ?? '',
  token: connection?.token ?? '',
  setBadge: (n: number) => ipcRenderer.send('yaho:badge', n),
  notify: (title: string, body: string) => ipcRenderer.send('yaho:notify', title, body),
  reveal: (path: string) => ipcRenderer.send('yaho:reveal', path),
  openExternal: (url: string) => ipcRenderer.send('yaho:open', url),
  setTheme: (theme: string) => ipcRenderer.send('yaho:theme', theme),
  setTitleBar: (color: string, symbolColor: string) => ipcRenderer.send('yaho:titlebar', color, symbolColor),
  os: process.platform,
  restart: () => ipcRenderer.send('yaho:restart'),
  createShortcut: (): Promise<{ files: string[]; error?: string }> => ipcRenderer.invoke('yaho:shortcut'),
  onNavigate: (cb: (route: string) => void) => ipcRenderer.on('yaho:navigate', (_e: unknown, route: string) => cb(route)),
});
