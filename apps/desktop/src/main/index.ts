import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  Notification,
  session,
  shell,
  Tray,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import nodeModule from 'node:module';
import { dirname, join } from 'node:path';
import { startCore, type CoreConnection } from './core.ts';
import { appIcon, overlayBadge } from './icons.ts';
import { createShortcuts, removeShortcuts } from './shortcuts.ts';

const here = import.meta.dirname;
const desktopRoot = join(here, '../..');
/**
 * Two layouts: the repo (TypeScript run directly) and a packaged app, where tools/package.mjs puts bundled
 * main/, preload/, core/, cli/, renderer/, briefings/ and examples/ side by side.
 */
const packaged = existsSync(join(here, '../core/main.mjs'));
const root = join(here, '..');
const coreMain = process.env.YAHO_CORE_MAIN ?? (packaged ? join(root, 'core/main.mjs') : join(desktopRoot, '../../core/src/main.ts'));
const rendererIndex = packaged ? join(root, 'renderer/index.html') : join(desktopRoot, 'dist/renderer/index.html');

/** A sandboxed preload must be plain JavaScript, so in the repo the types are stripped from its source first. */
function preloadScript(): string {
  if (packaged) return join(root, 'preload/index.cjs');
  const out = join(desktopRoot, 'dist/preload/index.cjs');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, nodeModule.stripTypeScriptTypes(readFileSync(join(here, '../preload/index.cts'), 'utf8')));
  return out;
}
if (packaged) {
  // The core finds briefings/ and examples/ next to itself; it needs telling where the CLI and the web UI are.
  process.env.YAHO_CLI_MAIN ??= join(root, 'cli/main.mjs');
  process.env.YAHO_WEB_ROOT ??= join(root, 'renderer');
}
/** Under `vp dev` closing the window ends the dev session; otherwise Yaho keeps running in the tray. */
const devSession = !!process.env.YAHO_RENDERER_URL;
const startHidden = process.argv.includes('--hidden');

let win: BrowserWindow | null = null;
/** The Yaho icon file: next to the app when packaged, in assets/logo in the repo. */
const winIcon = packaged ? join(root, 'yaho.ico') : join(desktopRoot, '../../assets/logo/yaho.ico');
const pngIcon = packaged ? join(root, 'yaho.png') : join(desktopRoot, '../../assets/logo/mark-256.png');
/** Height of the window-button overlay on Windows and Linux; the renderer keeps its controls clear of it. */
const TITLEBAR_HEIGHT = 40;
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

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: 'Yaho',
    // The .ico has every size Windows asks for (taskbar, Alt+Tab, title); the drawn icon is the fallback.
    icon: existsSync(winIcon) ? winIcon : appIcon(64),
    show: !startHidden,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#171a18' : '#f8f9f8',
    autoHideMenuBar: true,
    // The page runs to the top edge. The renderer marks its drag areas and recolors the buttons with the theme.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } }
      : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: nativeTheme.shouldUseDarkColors ? '#171a18' : '#f8f9f8',
            symbolColor: nativeTheme.shouldUseDarkColors ? '#e6e9e7' : '#1c211e',
            height: TITLEBAR_HEIGHT,
          },
        }),
    webPreferences: {
      preload: preloadScript(),
      sandbox: true,
      contextIsolation: true,
    },
  });
  // Links the renderer opens go to the default browser, never a new Electron window.
  // Only web and mail links: a file: or custom-scheme URL would start a program.
  const external = (url: string) => /^(https?|mailto):/i.test(url);
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (external(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // The window never leaves the app's own page; a link that tries opens in the browser instead.
  w.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin === new URL(w.webContents.getURL()).origin && !url.startsWith('file:')) return;
    e.preventDefault();
    if (external(url)) void shell.openExternal(url);
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
  tray?.setToolTip(`Yaho · ${unread} unread · ${running} running${queued ? ` · ${queued} queued` : ''}`);
  if (process.platform === 'win32') win?.setOverlayIcon(unread ? overlayBadge(unread) : null, unread ? `${unread} unread` : '');
  else app.setBadgeCount(unread);
  buildTrayMenu();
}

function buildTrayMenu(): void {
  if (!tray) return;
  const login = app.getLoginItemSettings();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Yaho', click: () => show() },
      { label: `Inbox${state.unread ? ` (${state.unread} unread)` : ''}`, click: () => show('inbox') },
      { label: `Running Jobs (${state.running})`, click: () => show('jobs') },
      { type: 'separator' },
      {
        label: process.platform === 'darwin' ? 'Open at Login' : 'Start With Windows',
        visible: process.platform !== 'linux',
        type: 'checkbox',
        checked: login.openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { type: 'separator' },
      { label: 'Quit Yaho', click: () => quit() },
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
            const n = new Notification({ title: e.title ?? 'Yaho', body: e.body ?? '', icon: appIcon(64) });
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

/** Only the app's own page may use the bridge: not a frame inside it, and not a page it was navigated to. */
function fromApp(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  if (!win || e.sender !== win.webContents || !frame || frame.parent) return false;
  const devUrl = process.env.YAHO_RENDERER_URL;
  try {
    // The window never navigates to another file (see will-navigate), so a file: page is the app's own.
    return devUrl ? new URL(frame.url).origin === new URL(devUrl).origin : new URL(frame.url).protocol === 'file:';
  } catch {
    return false;
  }
}
const on = <A extends unknown[]>(channel: string, fn: (...args: A) => void) =>
  ipcMain.on(channel, (e, ...args) => {
    if (fromApp(e)) fn(...(args as A));
  });

// Read once by the preload as the page starts; never on the command line, where other local users could see it.
ipcMain.on('yaho:connection', (e) => {
  e.returnValue = fromApp(e) && core ? { url: core.url, token: core.token } : null;
});
on('yaho:badge', () => void refreshState());
on('yaho:notify', (title: string, body: string) => {
  new Notification({ title, body, icon: appIcon(64) }).show();
});
// The desktop and Start menu shortcuts, from the first-run setup. The dev session runs plain electron.exe, which a
// shortcut cannot start Yaho with, so it only says so.
ipcMain.handle('yaho:shortcut', (e) => {
  if (!fromApp(e)) return { files: [], error: 'Not allowed.' };
  return packaged
    ? { files: createShortcuts(winIcon, pngIcon) }
    : { files: [], error: 'Shortcuts are made by the installed app, not the dev session.' };
});
// Restart after an update. Started from the yaho command, the launcher opens the new version once this one has
// exited (it waits for this pid); otherwise Electron restarts the same build.
on('yaho:restart', () => {
  const launcher = process.env.YAHO_LAUNCHER;
  if (launcher && existsSync(launcher)) {
    spawn(process.env.YAHO_NODE ?? 'node', [launcher, 'open', '--wait-pid', String(process.pid)], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else app.relaunch();
  quitting = true;
  app.quit();
});
on('yaho:reveal', (path: string) => {
  if (typeof path === 'string' && existsSync(path)) shell.showItemInFolder(path);
});
on('yaho:theme', (theme: string) => {
  if (theme === 'light' || theme === 'dark' || theme === 'system') nativeTheme.themeSource = theme;
});
on('yaho:titlebar', (color: string, symbolColor: string) => {
  if (process.platform === 'darwin' || !/^#[0-9a-f]{6}$/i.test(color) || !/^#[0-9a-f]{6}$/i.test(symbolColor)) return;
  win?.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
});
on('yaho:open', (url: string) => {
  if (typeof url === 'string' && /^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url);
});

/**
 * One-shot modes the yaho command uses: make or remove the shortcuts, or run the core without a window. They neither
 * take the single-instance lock nor open a window.
 */
const oneShot = ['--create-shortcut', '--remove-shortcut', '--serve'].find((f) => process.argv.includes(f));
if (oneShot === '--serve') {
  const child = spawn(process.execPath, ['--no-warnings', coreMain, 'serve'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  child.on('exit', (code) => app.exit(code ?? 0));
} else if (oneShot) {
  void app.whenReady().then(() => {
    const files = oneShot === '--create-shortcut' ? createShortcuts(winIcon, pngIcon) : removeShortcuts();
    const verb = oneShot === '--create-shortcut' ? 'Made' : 'Removed';
    process.stdout.write(files.length ? `${verb}:\n${files.map((f) => `  ${f}`).join('\n')}\n` : 'Nothing to do on this system.\n');
    app.exit(0);
  });
} else if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => show());

app.whenReady().then(async () => {
  if (oneShot) return;
  // Taskbar grouping and notifications. Windows takes the taskbar icon from the program: the Yaho exe when installed,
  // electron.exe (and its icon) in the dev session.
  app.setAppUserModelId('com.nielsbosma.yaho');
  try {
    core = await startCore(coreMain);
  } catch (e) {
    dialog.showErrorBox('Yaho could not start', (e as Error).message);
    app.quit();
    return;
  }
  tray = new Tray(appIcon(32));
  tray.on('click', () => show());
  // Nothing the app does needs a camera, location or the like; only copying to the clipboard and full-screen video.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) =>
    done(permission === 'clipboard-sanitized-write' || permission === 'fullscreen'),
  );
  win = createWindow();
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
