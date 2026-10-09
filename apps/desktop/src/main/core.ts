import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

export function dataDir(): string {
  if (process.env.YAHO_DATA_DIR) return process.env.YAHO_DATA_DIR;
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return join(base, 'yaho');
}

export interface CoreConnection {
  url: string;
  token: string;
  child: ChildProcess | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function healthy(url: string): Promise<boolean> {
  try {
    return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

function serverFile(): { url: string; pid: number } | null {
  const f = join(dataDir(), 'server.yaml');
  if (!existsSync(f)) return null;
  try {
    return YAML.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

const token = () => readFileSync(join(dataDir(), 'api-token'), 'utf8').trim();

/**
 * Connect to a running core, or start one. The core is a plain Node process (Electron in Node mode) with no
 * dependency on Electron; the window only talks to it over HTTP.
 */
export async function startCore(coreMain: string): Promise<CoreConnection> {
  // In development `vp dev` runs the core itself (with --watch) and tells us where it is.
  const external = process.env.YAHO_CORE_URL;
  if (external) {
    for (let i = 0; i < 100 && !(await healthy(external)); i++) await sleep(200);
    return { url: external, token: token(), child: null };
  }
  const running = serverFile();
  if (running && (await healthy(running.url))) return { url: running.url, token: token(), child: null };

  const child = spawn(process.execPath, ['--no-warnings', coreMain, 'serve'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', YAHO_EXIT_WITH_PARENT: '1' },
    stdio: ['pipe', 'inherit', 'inherit'],
    windowsHide: true,
  });
  for (let i = 0; i < 150; i++) {
    const s = serverFile();
    if (s && s.pid === child.pid && (await healthy(s.url))) return { url: s.url, token: token(), child };
    if (child.exitCode !== null) throw new Error(`the YAHO core exited with code ${child.exitCode}`);
    await sleep(200);
  }
  child.kill();
  throw new Error('the YAHO core did not start within 30 seconds');
}
