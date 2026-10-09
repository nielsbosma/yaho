import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { watch } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite-plus';

/**
 * `vp dev` at the repo root: Vite serves the renderer with HMR, and this plugin runs the core (restarted on every
 * core change) and Electron (restarted on main/preload changes). Closing the window or Ctrl+C stops everything.
 *
 * Dev uses its own data dir and port so it can run next to an installed YAHO, which may well be the one running
 * the agent that is editing this code.
 */
export function yahoDev(repo: string): Plugin {
  const appData = process.env.APPDATA ?? join(homedir(), process.platform === 'darwin' ? 'Library/Application Support' : '.config');
  const dataDir = process.env.YAHO_DATA_DIR ?? join(appData, 'yaho-dev');
  const corePort = process.env.YAHO_PORT ?? '4701';
  const coreUrl = `http://127.0.0.1:${corePort}`;
  // The electron package exports the path of its binary; spawning that skips the npm shim (which needs node on PATH).
  const electronBin = createRequire(join(repo, 'apps/desktop/package.json'))('electron') as unknown as string;
  let core: ChildProcess | null = null;
  let electron: ChildProcess | null = null;
  let quitting = false;

  const kill = (p: ChildProcess | null) => {
    if (!p?.pid || p.exitCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else p.kill('SIGTERM');
  };

  // Its own Dopbase port too, so an installed YAHO (4700, 4702) and dev (4701, 4703) never collide.
  const env = { ...process.env, YAHO_DATA_DIR: dataDir, YAHO_PORT: corePort, YAHO_DOPBASE_PORT: process.env.YAHO_DOPBASE_PORT ?? '4703' };

  function startCore(): Promise<void> {
    core = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(repo, 'core/src/main.ts'), 'serve'], {
      env: { ...env, YAHO_EXIT_WITH_PARENT: '1' },
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    const mine = core;
    mine.on('exit', (code) => {
      if (!quitting && mine === core && code) console.log(`[yaho] core exited with code ${code}; it restarts on the next change`);
    });
    return Promise.resolve();
  }

  /**
   * One restart at a time: a change that lands while the core is restarting queues exactly one more restart.
   * Overlapping restarts would start two cores, and the loser would leave this plugin tracking a dead one.
   */
  let restarting: Promise<void> | null = null;
  let again = false;
  function requestRestart(): void {
    if (restarting) {
      again = true;
      return;
    }
    restarting = restartCore().finally(() => {
      restarting = null;
      if (again) {
        again = false;
        requestRestart();
      }
    });
  }

  /** Graceful: closing stdin lets the core queue its running jobs to resume, then exit. */
  async function restartCore(): Promise<void> {
    const old = core;
    if (old && old.exitCode === null) {
      old.stdin?.end();
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          kill(old);
          res();
        }, 8000);
        old.once('exit', () => {
          clearTimeout(t);
          res();
        });
      });
    }
    console.log('[yaho] core restarted');
    await startCore();
  }

  function startElectron(rendererUrl: string): void {
    const debug = process.env.YAHO_ELECTRON_DEBUG_PORT ? [`--remote-debugging-port=${process.env.YAHO_ELECTRON_DEBUG_PORT}`] : [];
    electron = spawn(electronBin, [join(repo, 'apps/desktop'), ...debug], {
      env: { ...env, YAHO_CORE_URL: coreUrl, YAHO_RENDERER_URL: rendererUrl },
      stdio: 'inherit',
    });
    const mine = electron;
    mine.on('exit', () => {
      // Closing the window ends the dev session; a restart we asked for does not.
      if (mine === electron && !quitting) shutdown();
    });
  }

  function restartElectron(rendererUrl: string): void {
    const old = electron;
    electron = null;
    kill(old);
    console.log('[yaho] electron restarted');
    startElectron(rendererUrl);
  }

  function shutdown(): void {
    if (quitting) return;
    quitting = true;
    kill(electron);
    core?.stdin?.end();
    setTimeout(() => {
      kill(core);
      process.exit(0);
    }, 3000).unref();
    core?.once('exit', () => process.exit(0));
  }

  function debounced(dir: string, fn: () => void, filter: (f: string) => boolean = () => true): void {
    let t: ReturnType<typeof setTimeout> | undefined;
    watch(dir, { recursive: true }, (_e, file) => {
      if (!file || !filter(String(file))) return;
      clearTimeout(t);
      t = setTimeout(fn, 300);
    });
  }

  return {
    name: 'yaho-dev',
    apply: 'serve',
    configureServer(server) {
      if (process.env.YAHO_DEV_NO_APP || process.env.VITEST) return;
      // Vite re-runs this when its config changes; the core and Electron from the first run keep going.
      const g = globalThis as { __yahoDevStarted?: boolean };
      if (g.__yahoDevStarted) return;
      g.__yahoDevStarted = true;
      void startCore();
      debounced(
        join(repo, 'core/src'),
        () => requestRestart(),
        (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
      );
      debounced(join(repo, 'briefings'), () => undefined); // read per job; nothing to restart
      server.httpServer?.once('listening', () => {
        const addr = server.httpServer!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 4710;
        const rendererUrl = `http://localhost:${port}/`;
        console.log(`[yaho] data ${dataDir} · core ${coreUrl} · renderer ${rendererUrl}`);
        startElectron(rendererUrl);
        debounced(join(repo, 'apps/desktop/src/main'), () => restartElectron(rendererUrl));
        debounced(join(repo, 'apps/desktop/src/preload'), () => restartElectron(rendererUrl));
      });
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    },
  };
}
