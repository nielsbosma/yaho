import { app, shell } from 'electron';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_ID = 'com.nielsbosma.yaho';

/** Where Yaho's shortcuts go on this OS: the desktop, and the Start menu or the application list. */
function places(): string[] {
  const desktop = app.getPath('desktop');
  if (process.platform === 'win32')
    return [join(desktop, 'Yaho.lnk'), join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Yaho.lnk')];
  if (process.platform === 'linux') {
    const list = [join(homedir(), '.local', 'share', 'applications', 'yaho.desktop')];
    if (existsSync(desktop)) list.push(join(desktop, 'yaho.desktop'));
    return list;
  }
  // macOS: the app is ~/Applications/Yaho.app, which Launchpad and Spotlight already show.
  return [];
}

/**
 * Make the desktop and Start menu (or applications) shortcuts, pointing at this executable with Yaho's icon. On Windows
 * the AppUserModelId matches the app's, so the taskbar groups the window under Yaho.
 */
export function createShortcuts(icon: string, pngIcon: string): string[] {
  const made: string[] = [];
  for (const file of places()) {
    mkdirSync(join(file, '..'), { recursive: true });
    if (process.platform === 'win32') {
      shell.writeShortcutLink(file, 'create', { target: process.execPath, icon, iconIndex: 0, appUserModelId: APP_ID, description: 'Yaho' });
    } else {
      // Started as this instance was: with --no-sandbox only where the launcher found Chromium's sandbox unusable.
      writeFileSync(
        file,
        ['[Desktop Entry]', 'Type=Application', 'Name=Yaho', 'Comment=Yet Another Harness Orchestrator', `Exec="${process.execPath}"${app.commandLine.hasSwitch('no-sandbox') ? ' --no-sandbox' : ''}`, `Icon=${pngIcon}`, 'Terminal=false', 'Categories=Development;Utility;', `StartupWMClass=Yaho`, ''].join('\n'),
        { mode: 0o755 },
      );
    }
    made.push(file);
  }
  return made;
}

export function removeShortcuts(): string[] {
  const removed: string[] = [];
  for (const file of places())
    if (existsSync(file)) {
      rmSync(file, { force: true });
      removed.push(file);
    }
  return removed;
}
