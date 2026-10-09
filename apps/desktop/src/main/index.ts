import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startCore, type CoreConnection } from './core.ts';

const here = import.meta.dirname;
const desktopRoot = join(here, '../..');
const coreMain = process.env.YAHO_CORE_MAIN ?? join(desktopRoot, '../../core/src/main.ts');

let win: BrowserWindow | null = null;
let core: CoreConnection | null = null;

function createWindow(conn: CoreConnection): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: 'YAHO',
    backgroundColor: '#faf9f5',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.cts'),
      sandbox: false,
      contextIsolation: true,
      additionalArguments: [`--yaho-api=${conn.url}`, `--yaho-token=${conn.token}`],
    },
  });
  // Links the renderer opens go to the default browser, never a new Electron window.
  w.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  const devUrl = process.env.YAHO_RENDERER_URL;
  if (devUrl) void w.loadURL(devUrl);
  else void w.loadFile(join(desktopRoot, 'dist/renderer/index.html'));
  return w;
}

ipcMain.on('yaho:badge', (_e, n: number) => {
  app.setBadgeCount(n);
});
ipcMain.on('yaho:notify', (_e, title: string, body: string) => {
  new Notification({ title, body }).show();
});
ipcMain.on('yaho:reveal', (_e, path: string) => {
  if (existsSync(path)) shell.showItemInFolder(path);
});
ipcMain.on('yaho:open', (_e, url: string) => {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
});

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.whenReady().then(async () => {
  app.setAppUserModelId('com.nielsbosma.yaho');
  try {
    core = await startCore(coreMain);
  } catch (e) {
    dialog.showErrorBox('YAHO could not start', (e as Error).message);
    app.quit();
    return;
  }
  win = createWindow(core);
});

app.on('before-quit', () => core?.child?.stdin?.end());
app.on('window-all-closed', () => app.quit());
