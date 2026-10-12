/**
 * The human's side of the yaho command: open the desktop app, check the setup, make shortcuts, run the core headless,
 * update. The app itself comes from the platform package next to this one (@bosmainteractive/yaho-<os>-<arch>), which
 * holds the signed build; YAHO_APP points at another build (a dev or unpacked one).
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { paths } from '../../core/src/config.ts';

export const LAUNCHER_COMMANDS = new Set(['open', 'doctor', 'shortcut', 'serve', 'update', 'version']);

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const platformPackage = `@bosmainteractive/yaho-${process.platform}-${process.arch}`;

/** This package's version (the launcher and the app ship with the same one). */
export function version(): string {
  for (const p of [join(here, '../package.json'), join(here, 'package.json')])
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string };
      if (pkg.name?.includes('yaho')) return pkg.version ?? '0.0.0';
    }
  return '0.0.0';
}

/** What a platform package says about its contents, in the "yaho" field of its package.json. */
interface AppManifest {
  /** Windows and Linux: the executable, relative to the package. */
  exe?: string;
  /** macOS: the zipped Yaho.app, relative to the package (npm cannot hold the symlinks inside an .app). */
  zip?: string;
}

/** The app's executable, unpacking the macOS app into ~/Applications when it is missing or older. */
export function findApp(): string {
  if (process.env.YAHO_APP) return process.env.YAHO_APP;
  let pkgJson: string;
  try {
    pkgJson = require.resolve(`${platformPackage}/package.json`);
  } catch {
    throw new Error(
      `the Yaho app for ${process.platform}-${process.arch} is not installed (${platformPackage}).\n` +
        'Reinstall with: npm i -g @bosmainteractive/yaho (without --omit=optional or --no-optional)',
    );
  }
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { version: string; yaho?: AppManifest };
  const dir = dirname(pkgJson);
  if (process.platform === 'darwin') {
    if (!pkg.yaho?.zip) throw new Error(`${platformPackage} has no app zip`);
    const apps = join(homedir(), 'Applications');
    const app = join(apps, 'Yaho.app');
    const stamp = join(app, 'Contents', 'yaho-npm-version');
    if (!existsSync(stamp) || readFileSync(stamp, 'utf8').trim() !== pkg.version) {
      mkdirSync(apps, { recursive: true });
      rmSync(app, { recursive: true, force: true });
      // ditto keeps the symlinks and extended attributes the signature depends on.
      const r = spawnSync('ditto', ['-x', '-k', join(dir, pkg.yaho.zip), apps], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('could not unpack Yaho.app into ~/Applications');
      writeFileSync(stamp, pkg.version);
    }
    return join(app, 'Contents', 'MacOS', 'Yaho');
  }
  if (!pkg.yaho?.exe) throw new Error(`${platformPackage} has no executable`);
  // Run a copy, one folder per version: Windows locks a running exe, and npm must be able to replace the package
  // while Yaho runs (that is how Update Now works). Older copies go once the new one is in place.
  const base =
    process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Yaho')
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'yaho');
  const target = join(base, `app-${pkg.version}`);
  const exe = join(target, pkg.yaho.exe.replace(/^app[\\/]/, ''));
  if (!existsSync(join(target, '.complete'))) {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(base, { recursive: true });
    cpSync(join(dir, 'app'), target, { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(target, '.complete'), pkg.version);
    for (const old of readdirSync(base))
      if (old.startsWith('app-') && old !== `app-${pkg.version}`)
        try {
          rmSync(join(base, old), { recursive: true, force: true, maxRetries: 2 });
        } catch {
          // Still running: it goes next time.
        }
  }
  return exe;
}

/**
 * Linux: Chromium's setuid sandbox helper only works when root owns it with the setuid bit, which an npm install never
 * gives it, and Chromium then aborts before Yaho's code runs. The switch has to be on the command line.
 */
const appArgs = (args: string[]) => (process.platform === 'linux' ? ['--no-sandbox', ...args] : args);

/** Wait until a process has exited (the old Yaho, when an update restarts it). */
async function waitForExit(pid: number, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Start the app detached, so the terminal is free at once. A running app comes to the front instead. The app learns
 * how to start this launcher again (YAHO_LAUNCHER), which Update Now uses to restart into the new version.
 */
function launch(args: string[] = [], env: NodeJS.ProcessEnv = {}): void {
  const exe = findApp();
  const child = spawn(exe, appArgs(args), {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, YAHO_LAUNCHER: fileURLToPath(import.meta.url), YAHO_NODE: process.execPath, YAHO_INSTALL: 'npm', ...env },
  });
  child.unref();
}

function runAndWait(args: string[]): number {
  return spawnSync(findApp(), appArgs(args), { stdio: 'inherit' }).status ?? 1;
}

function check(label: string, fn: () => string): boolean {
  try {
    console.log(`  ok    ${label}: ${fn()}`);
    return true;
  } catch (e) {
    console.log(`  FAIL  ${label}: ${(e as Error).message.split('\n')[0]}`);
    return false;
  }
}

export async function launcher(cmd: string | undefined, args: string[]): Promise<number> {
  switch (cmd ?? 'open') {
    case 'open': {
      // After an update the old app starts this with --wait-pid, so the new one does not find the old one running.
      const i = args.indexOf('--wait-pid');
      if (i >= 0) await waitForExit(Number(args[i + 1]));
      launch();
      return 0;
    }
    case 'version':
      console.log(version());
      return 0;
    case 'shortcut':
      return runAndWait([args.includes('--remove') ? '--remove-shortcut' : '--create-shortcut']);
    case 'serve':
      // The core without a window: the app's own Node runs it (Electron as Node).
      return spawnSync(findApp(), appArgs(['--serve']), { stdio: 'inherit', env: { ...process.env, YAHO_HEADLESS: '1' } }).status ?? 1;
    case 'update': {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const r = spawnSync(npm, ['install', '-g', '@bosmainteractive/yaho@latest'], { stdio: 'inherit', shell: process.platform === 'win32' });
      return r.status ?? 1;
    }
    case 'doctor': {
      console.log(`yaho ${version()} (${process.platform}-${process.arch}, Node ${process.versions.node})`);
      let ok = check('app', () => findApp());
      ok = check('Node 22.17 or later', () => {
        const [maj, min] = process.versions.node.split('.').map(Number);
        if (maj! < 22 || (maj === 22 && min! < 17)) throw new Error(`Node ${process.versions.node} is too old`);
        return process.versions.node;
      }) && ok;
      ok = check('Claude Code', () => {
        const r = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
        if (r.status !== 0) throw new Error('claude was not found on PATH; install Claude Code first');
        return r.stdout.trim();
      }) && ok;
      const p = paths();
      console.log(`  ok    data folder: ${p.root}`);
      // The core writes server.yaml with its URL while it runs.
      const server = existsSync(p.server) ? (YAML.parse(readFileSync(p.server, 'utf8')) as { url?: string }) : {};
      try {
        if (!server.url) throw new Error();
        await fetch(`${server.url}/api/health`);
        console.log(`  ok    core: running at ${server.url}`);
      } catch {
        console.log('  --    core: not running (start it with yaho)');
      }
      return ok ? 0 : 1;
    }
    default:
      return -1;
  }
}
