import { spawn } from 'node:child_process';
import type { Ctx } from './context.ts';
import { withoutCaps } from './harness/asAgent.ts';

export const PACKAGE = '@bosmainteractive/yaho';
const SIX_HOURS = 6 * 3600_000;
/** The server version updates by pulling the new image; Sliplane does that on a redeploy. */
const SERVER_UPDATE =
  'On Sliplane: redeploy the service. With Docker: docker compose pull && docker compose up -d (or docker pull ghcr.io/nielsbosma/yaho:latest and start the container again).';

export interface UpdateState {
  current: string;
  latest?: string;
  available: boolean;
  /** npm: Update Now runs npm itself. manual: show the command (dev session, installer builds without npm). */
  mode: 'npm' | 'manual';
  command: string;
  notes_url?: string;
  checked_at?: string;
  /** While Update Now runs, and after: done means restart to finish. */
  status?: 'installing' | 'done' | 'failed';
  error?: string;
}

/** Compare two versions (semver order): above 0 when a is newer. 1.2.0-rc.3 is newer than 1.2.0-rc.2, older than 1.2.0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.trim().replace(/^v/, '').split(/\s/)[0]!.split(/-(.*)/);
    return { nums: core.split('.').map((n) => Number(n) || 0), pre: pre ? pre.split('.') : [] };
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
  // Same numbers: a release is newer than any of its pre-releases.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const [np, nq] = [Number(p), Number(q)];
    if (!Number.isNaN(np) && !Number.isNaN(nq)) return np - nq;
    return p < q ? -1 : 1;
  }
  return 0;
}

const newer = (a: string, b: string) => compareVersions(a, b) > 0;

/**
 * Checks npm for a newer Yaho at start and every six hours (unless turned off), and installs it on request. The app
 * shows a banner while one is available; installing never touches running jobs, and the restart is the user's call.
 */
export class Updates {
  state: UpdateState;
  private timer?: NodeJS.Timeout;
  private ctx: Ctx;
  constructor(ctx: Ctx, current: string) {
    this.ctx = ctx;
    const channel = ctx.settings.updates?.channel ?? 'latest';
    this.state = {
      current,
      available: false,
      mode: process.env.YAHO_INSTALL === 'npm' ? 'npm' : 'manual',
      command: process.env.YAHO_SERVER === '1' ? SERVER_UPDATE : `npm i -g ${PACKAGE}@${channel}`,
    };
  }

  start(): void {
    if (this.ctx.settings.updates?.auto === false) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), SIX_HOURS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private emit(): void {
    this.ctx.bus.emitEvent({ type: 'changed', entity: 'updates' });
  }

  async check(): Promise<UpdateState> {
    // The channel goes to a shell on Windows (npm is a .cmd there): only the two known names.
    const channel = this.ctx.settings.updates?.channel === 'next' ? 'next' : 'latest';
    try {
      const res = await fetch(`https://registry.npmjs.org/${PACKAGE.replace('/', '%2f')}`, {
        headers: { Accept: 'application/vnd.npm.install-v1+json' },
      });
      if (!res.ok) throw new Error(`npm answered ${res.status}`);
      const tags = ((await res.json()) as { 'dist-tags'?: Record<string, string> })['dist-tags'] ?? {};
      const latest = tags[channel] ?? tags.latest;
      Object.assign(this.state, {
        latest,
        available: !!latest && newer(latest, this.state.current),
        command: process.env.YAHO_SERVER === '1' ? SERVER_UPDATE : `npm i -g ${PACKAGE}@${channel}`,
        notes_url: latest ? `https://github.com/nielsbosma/yaho/releases/tag/v${latest}` : undefined,
        checked_at: new Date().toISOString(),
      });
    } catch (e) {
      // Offline or npm unreachable: try again at the next check.
      this.state.checked_at = new Date().toISOString();
      if (process.env.YAHO_DEBUG === '1') console.error(`[yaho] update check: ${(e as Error).message}`);
    }
    this.emit();
    return this.state;
  }

  /** Install the new version with npm. Running jobs carry on; the app restarts when the user says so. */
  install(): UpdateState {
    if (this.state.mode !== 'npm') throw new Error(`Update from a terminal: ${this.state.command}`);
    if (this.state.status === 'installing') return this.state;
    const channel = this.ctx.settings.updates?.channel ?? 'latest';
    Object.assign(this.state, { status: 'installing', error: undefined });
    this.emit();
    let output = '';
    const child = spawn(...withoutCaps('npm', ['install', '-g', `${PACKAGE}@${channel}`]), {
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (e) => (output += e.message));
    child.on('close', (code) => {
      if (code === 0) this.state.status = 'done';
      else {
        this.state.status = 'failed';
        // A global folder that needs admin rights: the banner shows the command to run instead.
        this.state.error = /EACCES|EPERM|permission/i.test(output)
          ? `npm needs more rights to update. Run this in a terminal: ${this.state.command}`
          : output.trim().split('\n').slice(-6).join('\n');
      }
      this.emit();
    });
    return this.state;
  }
}
