import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { Settings } from '../config.ts';
import { agentEnv, asAgent } from '../harness/asAgent.ts';
import { killTree, resolveCommand } from '../harness/claudeCode.ts';
import { Cdp } from './cdp.ts';

export type BrowserProvider = 'local' | 'browserbase' | 'steel' | 'cdp';

export const providerOf = (s: Settings): BrowserProvider => s.browser?.provider ?? 'local';

/** A browser connection for one job: the CDP connection, a live view to watch it (cloud), and how to end it. */
export interface Launched {
  cdp: Cdp;
  liveUrl?: string;
  /** Sign-ins are kept by the profile folder (local) or by saving cookies (cloud). */
  keepsProfile: boolean;
  close(): Promise<void>;
}

function candidates(env: Record<string, string | undefined>): string[] {
  if (process.platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean) as string[];
    return roots.flatMap((r) => [
      join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(r, 'Chromium', 'Application', 'chrome.exe'),
    ]);
  }
  if (process.platform === 'darwin')
    return ['/Applications', join(homedir(), 'Applications')].flatMap((r) => [
      join(r, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
      join(r, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(r, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'),
    ]);
  return ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable'].map((c) =>
    resolveCommand(c, env),
  );
}

/** The local browser to run: the one set in Settings, YAHO_BROWSER, or an installed Chrome, Edge or Chromium. */
export function findBrowser(s: Settings, env: Record<string, string | undefined> = process.env): string | null {
  const set = s.browser?.executable || env.YAHO_BROWSER;
  if (set) return existsSync(set) ? set : null;
  return candidates(env).find((p) => isAbsolute(p) && existsSync(p)) ?? null;
}

const stillAlive = (p: Promise<unknown>, ms: number) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);

/** Start Chromium with its debugging pipe, as the agent's user on the server, with the agent's own profile folder. */
export async function launchLocal(s: Settings, profile: string, opts: { downloads: string }): Promise<Launched> {
  const exe = findBrowser(s);
  if (!exe) throw new Error('no browser found: install Chrome, Edge or Chromium, or set its path in Settings → Integrations → Browser');
  mkdirSync(profile, { recursive: true });
  mkdirSync(opts.downloads, { recursive: true });
  const headless = s.browser?.headless ?? true;
  // Chromium's own sandbox refuses to run as root, and some containers allow no user namespaces for it.
  const root = process.getuid?.() === 0 && !process.env.YAHO_AGENT_UID;
  const attempt = async (noSandbox: boolean): Promise<Launched> => {
    const args = [
      '--remote-debugging-pipe',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--password-store=basic',
      '--use-mock-keychain',
      '--mute-audio',
      '--window-size=1280,900',
      ...(headless ? ['--headless=new', '--hide-scrollbars'] : []),
      ...(process.platform === 'linux' ? ['--disable-dev-shm-usage'] : []),
      ...(noSandbox ? ['--no-sandbox'] : []),
      'about:blank',
    ];
    const child = spawn(...asAgent(exe, args), {
      env: agentEnv(),
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    const exited = new Promise<never>((_, rej) => {
      child.on('error', (e) => rej(new Error(`could not start ${exe}: ${e.message}`)));
      child.on('exit', (code) =>
        rej(new Error(`the browser exited (${code}) while starting: ${stderr.trim().split('\n').slice(-3).join(' ')}`)),
      );
    });
    exited.catch(() => undefined);
    const gone = new Promise<void>((r) => child.once('exit', () => r()));
    const cdp = Cdp.overPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
    try {
      await Promise.race([stillAlive(cdp.send('Browser.getVersion'), 20_000), exited]);
    } catch (e) {
      cdp.close();
      killTree(child.pid);
      throw e;
    }
    return {
      cdp,
      keepsProfile: true,
      async close() {
        await stillAlive(cdp.send('Browser.close'), 3000).catch(() => undefined);
        // Let it finish writing the profile before anything removes or reuses it.
        await stillAlive(gone, 5000).catch(() => killTree(child.pid));
        cdp.close();
      },
    };
  };
  if (root) return attempt(true);
  try {
    return await attempt(false);
  } catch (e) {
    if (!/sandbox|namespace|zygote/i.test((e as Error).message)) throw e;
    return attempt(true);
  }
}

async function json(res: Response, what: string): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** A browser from a cloud service, reached over CDP. Each job gets its own session there, released at the end. */
export async function connectCloud(s: Settings): Promise<Launched> {
  const b = s.browser ?? {};
  const provider = providerOf(s);
  if (provider === 'browserbase') {
    if (!b.api_key || !b.project_id) throw new Error('Browserbase needs an API key and a project id (Settings → Integrations → Browser)');
    const headers = { 'X-BB-API-Key': b.api_key, 'Content-Type': 'application/json' };
    const ses = await json(
      await fetch('https://api.browserbase.com/v1/sessions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ projectId: b.project_id }),
      }),
      'Browserbase',
    );
    const id = String(ses.id);
    const cdp = await Cdp.overWebSocket(String(ses.connectUrl));
    const debug = await fetch(`https://api.browserbase.com/v1/sessions/${id}/debug`, { headers })
      .then((r) => json(r, 'Browserbase'))
      .catch(() => ({}) as Record<string, unknown>);
    return {
      cdp,
      liveUrl: (debug.debuggerFullscreenUrl as string) || undefined,
      keepsProfile: false,
      async close() {
        cdp.close();
        await fetch(`https://api.browserbase.com/v1/sessions/${id}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ projectId: b.project_id, status: 'REQUEST_RELEASE' }),
        }).catch(() => undefined);
      },
    };
  }
  if (provider === 'steel') {
    if (!b.api_key) throw new Error('Steel needs an API key (Settings → Integrations → Browser)');
    const headers = { 'steel-api-key': b.api_key, 'Content-Type': 'application/json' };
    const ses = await json(await fetch('https://api.steel.dev/v1/sessions', { method: 'POST', headers, body: '{}' }), 'Steel');
    const id = String(ses.id);
    const cdp = await Cdp.overWebSocket(
      `wss://connect.steel.dev?apiKey=${encodeURIComponent(b.api_key)}&sessionId=${encodeURIComponent(id)}`,
    );
    return {
      cdp,
      liveUrl: (ses.sessionViewerUrl as string) || undefined,
      keepsProfile: false,
      async close() {
        cdp.close();
        await fetch(`https://api.steel.dev/v1/sessions/${id}/release`, { method: 'POST', headers }).catch(() => undefined);
      },
    };
  }
  if (!b.cdp_url) throw new Error('set the browser’s CDP URL (Settings → Integrations → Browser)');
  let url = b.cdp_url;
  if (/^https?:/i.test(url)) {
    const v = await json(await fetch(`${url.replace(/\/$/, '')}/json/version`), 'the CDP endpoint');
    url = String(v.webSocketDebuggerUrl);
  }
  const cdp = await Cdp.overWebSocket(url);
  return {
    cdp,
    keepsProfile: false,
    async close() {
      cdp.close();
    },
  };
}
