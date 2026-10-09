import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, shell, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startCore, type CoreConnection } from './core.ts';
import { appIcon, overlayBadge } from './icons.ts';

const here = import.meta.dirname;
const desktopRoot = join(here, '../..');
/**
 * Two layouts: the repo (TypeScript run directly) and a packaged app, where tools/package.mjs puts bundled
 * main/, preload/, core/, cli/, renderer/, briefings/ and examples/ side by side.
 */
const packaged = existsSync(join(here, '../core/main.mjs'));
const root = join(here, '..');
const coreMain = process.env.YAHO_CORE_MAIN ?? (packaged ? join(root, 'core/main.mjs') : join(desktopRoot, '../../core/src/main.ts'));
const preload = packaged ? join(root, 'preload/index.cjs') : join(here, '../preload/index.cts');
const rendererIndex = packaged ? join(root, 'renderer/index.html') : join(desktopRoot, 'dist/renderer/index.html');
if (packaged) {
  // The core finds briefings/ and examples/ next to itself; it needs telling where the CLI and the web UI are.
  process.env.YAHO_CLI_MAIN ??= join(root, 'cli/main.mjs');
  process.env.YAHO_WEB_ROOT ??= join(root, 'renderer');
}
/** Under `vp dev` closing the window ends the dev session; otherwise YAHO keeps running in the tray. */
const devSession = !!process.env.YAHO_RENDERER_URL;
const startHidden = process.argv.includes('--hidden');

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let core: CoreConnection | null = null;
let quitting = false;
let state = { unread: 0, running: 0, queued: 0 };
/** Count of native notifications shown; read by tests through the inspector. */
let notified = 0;
(globalThis as { yahoDebug?: () => unknown }).yahoDebug = () => ({
  state,
  notified,
  tooltip: tray?.getTitle?.(),
  visible: win?.isVisible(),
  destroyed: win?.isDestroyed(),
  icon: (size = 64) => appIcon(size, true).toPNG().toString('base64'),
});

function createWindow(conn: CoreConnection): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: 'YAHO',
    icon: appIcon(64),
    show: !startHidden,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#262624' : '#faf9f5',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
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
  w.on('close', (e) => {
    if (quitting || devSession) return;
    e.preventDefault();
    w.hide();
  });
  const devUrl = process.env.YAHO_RENDERER_URL;
  if (devUrl) void w.loadURL(devUrl);
  else void w.loadFile(rendererIndex);
  w.webContents.once('did-finish-load', () => applyBadge());
  return w;
}

function show(route?: string): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (route) win.webContents.send('yaho:navigate', route);
}

/** Tray icon, tooltip, taskbar overlay and dock/launcher badge all follow the unread count. */
function applyBadge(): void {
  const { unread, running, queued } = state;
  tray?.setImage(appIcon(32, unread > 0));
  tray?.setToolTip(`YAHO · ${unread} unread · ${running} running${queued ? ` · ${queued} queued` : ''}`);
  if (process.platform === 'win32') win?.setOverlayIcon(unread ? overlayBadge() : null, unread ? `${unread} unread` : '');
  else app.setBadgeCount(unread);
  buildTrayMenu();
}

function buildTrayMenu(): void {
  if (!tray) return;
  const login = app.getLoginItemSettings();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open YAHO', click: () => show() },
      { label: `Inbox${state.unread ? ` (${state.unread} unread)` : ''}`, click: () => show('inbox') },
      { label: `Running Jobs (${state.running})`, click: () => show('jobs') },
      { type: 'separator' },
      {
        label: 'Start With Windows',
        type: 'checkbox',
        checked: login.openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { type: 'separator' },
      { label: 'Quit YAHO', click: () => quit() },
    ]),
  );
}

async function refreshState(): Promise<void> {
  if (!core) return;
  try {
    const res = await fetch(`${core.url}/api/state`, { headers: { Authorization: `Bearer ${core.token}` } });
    if (res.ok) state = await res.json();
    applyBadge();
  } catch {
    /* core restarting */
  }
}

/** Listen to the core's event stream: native notifications for the human, badge updates for everything else. */
async function followCore(): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refreshState(), 150);
  };
  for (;;) {
    try {
      const res = await fetch(`${core!.url}/api/events`, { headers: { Authorization: `Bearer ${core!.token}` } });
      if (!res.ok || !res.body) throw new Error(String(res.status));
      void refreshState();
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!data) continue;
          const e = JSON.parse(data.slice(6)) as { type: string; title?: string; body?: string; message?: string };
          if (e.type === 'notify' && Notification.isSupported()) {
            const n = new Notification({ title: e.title ?? 'YAHO', body: e.body ?? '', icon: appIcon(64) });
            n.on('click', () => show(e.message ? `inbox/${e.message}` : 'inbox'));
            n.show();
            notified++;
          }
          if (e.type === 'message' || e.type === 'job') debounced();
        }
      }
    } catch {
      /* reconnect below */
    }
    if (quitting) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function quit(): void {
  quitting = true;
  app.quit();
}

ipcMain.on('yaho:badge', () => void refreshState());
ipcMain.on('yaho:notify', (_e, title: string, body: string) => {
  new Notification({ title, body, icon: appIcon(64) }).show();
});
ipcMain.on('yaho:reveal', (_e, path: string) => {
  if (existsSync(path)) shell.showItemInFolder(path);
});
ipcMain.on('yaho:theme', (_e, theme: string) => {
  if (theme === 'light' || theme === 'dark' || theme === 'system') nativeTheme.themeSource = theme;
});
ipcMain.on('yaho:open', (_e, url: string) => {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
});

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => show());

app.whenReady().then(async () => {
  app.setAppUserModelId('com.nielsbosma.yaho');
  try {
    core = await startCore(coreMain);
  } catch (e) {
    dialog.showErrorBox('YAHO could not start', (e as Error).message);
    app.quit();
    return;
  }
  tray = new Tray(appIcon(32));
  tray.on('click', () => show());
  win = createWindow(core);
  applyBadge();
  void followCore();
});

app.on('before-quit', () => {
  quitting = true;
  // Closing the core's stdin lets it stop gracefully: running jobs are queued to resume on the next start.
  core?.child?.stdin?.end();
});
app.on('window-all-closed', () => {
  if (devSession || quitting) app.quit();
});
