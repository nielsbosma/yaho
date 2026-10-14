import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Ctx } from '../context.ts';
import { resolveUnder, UnsafePathError } from '../fsSafe.ts';
import * as s from '../store.ts';
import { HttpError } from '../store.ts';
import { connectCloud, findBrowser, launchLocal, providerOf } from './launch.ts';
import { BrowserSession } from './session.ts';

/**
 * Whether a tab may open a URL. Each allowed site is a host (example.com, which also allows its subdomains, or
 * *.example.com) or a URL whose host is used. Pages Yaho needs itself (about:blank, data: and blob: URLs) are always
 * allowed; an empty list allows everything.
 */
export function siteAllowed(url: string, sites: string[] | undefined): boolean {
  const list = (sites ?? []).map((x) => x.trim()).filter(Boolean);
  if (!list.length) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (['about:', 'data:', 'blob:'].includes(u.protocol)) return true;
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  return list.some((entry) => {
    let h = entry.toLowerCase();
    if (h.includes('://')) {
      try {
        h = new URL(h).hostname;
      } catch {
        return false;
      }
    }
    h = h.replace(/^\*\./, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
    return host === h || host.endsWith(`.${h}`);
  });
}

interface Entry {
  session?: BrowserSession;
  starting?: Promise<BrowserSession>;
  /** Commands run one at a time per job. */
  queue: Promise<unknown>;
  agent: string;
}

export type BrowserCommand = {
  cmd: string;
  args?: string[];
  flags?: Record<string, string | boolean | undefined>;
  stdin?: string;
  cwd?: string;
};

export const BROWSER_COMMANDS = [
  'open',
  'snapshot',
  'click',
  'hover',
  'type',
  'press',
  'select',
  'scroll',
  'back',
  'forward',
  'reload',
  'wait',
  'text',
  'eval',
  'screenshot',
  'pdf',
  'tabs',
  'tab',
  'close',
];

/** The browsers of running jobs: started on a job's first yaho browser command, closed when the job ends. */
export class BrowserManager {
  ctx: Ctx;
  jobs = new Map<string, Entry>();

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  enabledFor(agent: string): boolean {
    return s.agentExists(this.ctx, agent) && !!s.getAgent(this.ctx, agent).browser;
  }

  /** What Settings → Integrations shows: which browser, and whether it can start. */
  status(): { provider: string; ready: boolean; detail: string; running: number } {
    const b = this.ctx.settings.browser ?? {};
    const provider = providerOf(this.ctx.settings);
    const running = [...this.jobs.values()].filter((e) => e.session).length;
    if (provider === 'local') {
      const exe = findBrowser(this.ctx.settings);
      return exe
        ? { provider, ready: true, detail: exe, running }
        : {
            provider,
            ready: false,
            detail: b.executable ? `${b.executable} does not exist` : 'No Chrome, Edge or Chromium found on this machine',
            running,
          };
    }
    const missing =
      provider === 'browserbase'
        ? !b.api_key
          ? 'an API key'
          : !b.project_id
            ? 'a project id'
            : ''
        : provider === 'steel'
          ? !b.api_key
            ? 'an API key'
            : ''
          : !b.cdp_url
            ? 'a CDP URL'
            : '';
    const name = { browserbase: 'Browserbase', steel: 'Steel', cdp: 'CDP endpoint' }[provider];
    return missing
      ? { provider, ready: false, detail: `${name} needs ${missing}`, running }
      : { provider, ready: true, detail: name, running };
  }

  /** Start the browser as set up, open a page and close it again: the Test button in Settings. */
  async test(): Promise<{ ok: boolean; error?: string; version?: string }> {
    const settings = this.ctx.settings;
    // Among the agents' folders, which the browser (run as the agents' user on the server) may write.
    mkdirSync(this.ctx.paths.agents, { recursive: true });
    const scratch = mkdtempSync(join(this.ctx.paths.agents, '.browser-test-'));
    chmodSync(scratch, 0o770);
    try {
      const launched =
        providerOf(settings) === 'local'
          ? await launchLocal(settings, join(scratch, 'profile'), { downloads: join(scratch, 'downloads') })
          : await connectCloud(settings);
      try {
        const v = await launched.cdp.send<{ product: string }>('Browser.getVersion');
        return { ok: true, version: v.product };
      } finally {
        await launched.close();
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  profileDir(agent: string): string {
    return join(this.ctx.paths.agent(agent), '.yaho', 'browser');
  }

  private async open(agent: string, job: string): Promise<BrowserSession> {
    const settings = this.ctx.settings;
    const profile = this.profileDir(agent);
    const downloads = join(this.ctx.paths.agent(agent), 'downloads');
    const launched =
      providerOf(settings) === 'local'
        ? await launchLocal(settings, join(profile, 'profile'), { downloads })
        : await connectCloud(settings);
    if (launched.liveUrl) s.addJobEvent(this.ctx, job, 'status', { text: `Browser live view: ${launched.liveUrl}` });
    try {
      return await BrowserSession.start(launched, {
        allowed: (url) => siteAllowed(url, this.ctx.settings.browser?.allowed_sites),
        root: this.ctx.paths.agent(agent),
        downloads,
        cookieFile: join(profile, 'cookies.json'),
      });
    } catch (e) {
      await launched.close().catch(() => undefined);
      throw e;
    }
  }

  private async session(agent: string, job: string): Promise<BrowserSession> {
    let e = this.jobs.get(job);
    if (e?.session && !e.session.closed && !e.session.cdp.closed) return e.session;
    // A local browser keeps one profile per agent, which one Chromium at a time can open.
    if (!e?.starting && providerOf(this.ctx.settings) === 'local')
      for (const [other, x] of this.jobs)
        if (other !== job && x.agent === agent && (x.starting || (x.session && !x.session.closed)))
          throw new HttpError(409, `another job of ${agent} (${other}) has the browser open, and a local browser opens the agent's profile one job at a time. Wait for that job to end, or go on without the browser.`);
    if (!e) this.jobs.set(job, (e = { queue: Promise.resolve(), agent }));
    const entry = e;
    entry.starting ??= this.open(agent, job).finally(() => (entry.starting = undefined));
    entry.session = await entry.starting;
    entry.session.cdp.onClose = () => {
      if (entry.session) entry.session.closed = true;
    };
    return entry.session;
  }

  /** A file the agent named, which must be in its workspace. */
  private file(agent: string, cwd: string | undefined, path: string | undefined, fallback: string): string {
    const root = this.ctx.paths.agent(agent);
    const want = isAbsolute(path ?? '') ? path! : join(cwd && isAbsolute(cwd) ? cwd : root, path || fallback);
    try {
      return resolveUnder(root, want);
    } catch (e) {
      if (e instanceof UnsafePathError) throw new HttpError(400, `save files in your workspace (${root}), not through a link out of it`);
      throw e;
    }
  }

  /** Run one yaho browser command for a job; commands of the same job wait for each other. */
  run(agent: string, job: string, c: BrowserCommand): Promise<{ text: string }> {
    if (!this.enabledFor(agent)) throw new HttpError(403, 'the browser is not on for you (the agent’s Browser switch)');
    if (!BROWSER_COMMANDS.includes(c.cmd)) throw new HttpError(400, `unknown browser command ${c.cmd} (${BROWSER_COMMANDS.join(', ')})`);
    if (c.cmd === 'close') return this.close(job).then(() => ({ text: 'Closed the browser' }));
    let e = this.jobs.get(job);
    if (!e) this.jobs.set(job, (e = { queue: Promise.resolve(), agent }));
    const next = e.queue.then(() => this.exec(agent, job, c));
    e.queue = next.catch(() => undefined);
    return next
      .then((text) => ({ text }))
      .catch((err: Error) => {
        throw err instanceof HttpError ? err : new HttpError(400, err.message);
      });
  }

  private async exec(agent: string, job: string, c: BrowserCommand): Promise<string> {
    const b = await this.session(agent, job);
    const [a0, a1] = c.args ?? [];
    const f = c.flags ?? {};
    const need = (v: string | undefined, what: string) => {
      if (!v) throw new HttpError(400, `missing ${what}`);
      return v;
    };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    switch (c.cmd) {
      case 'open':
        return b.open(need(a0, 'the URL to open'));
      case 'snapshot':
        return b.snapshot();
      case 'click':
        return b.click(need(a0, 'the ref to click (from a snapshot)'));
      case 'hover':
        return b.hover(need(a0, 'the ref to hover over'));
      case 'type':
        return b.type(need(a0, 'the ref to type into'), need(a1 ?? c.stdin, 'the text to type'), {
          append: !!f.append,
          submit: !!f.submit,
        });
      case 'press':
        return b.press(need(a0, 'the key to press, e.g. Enter'));
      case 'select':
        return b.select(need(a0, 'the ref of the dropdown'), need(a1, 'the option (its value or label)'));
      case 'scroll':
        return b.scroll(a0 ?? 'down', a1 ? Number(a1) : undefined);
      case 'back':
        return b.history(-1);
      case 'forward':
        return b.history(1);
      case 'reload':
        return b.history(0);
      case 'wait':
        return b.waitFor({
          text: typeof f.text === 'string' ? f.text : a0 && !/^\d+(\.\d+)?$/.test(a0) ? a0 : undefined,
          selector: typeof f.selector === 'string' ? f.selector : undefined,
          gone: !!f.gone,
          seconds: typeof f.timeout === 'string' ? Number(f.timeout) : a0 && /^\d+(\.\d+)?$/.test(a0) ? Number(a0) : undefined,
        });
      case 'text':
        return b.text();
      case 'eval':
        return b.eval(need(a0 ?? c.stdin, 'the JavaScript to run (an argument or stdin)'));
      case 'screenshot':
        return b.screenshot(this.file(agent, c.cwd, a0, join('screenshots', `${stamp}.png`)), {
          full: !!f.full,
          ref: typeof f.ref === 'string' ? f.ref : undefined,
        });
      case 'pdf':
        return b.pdf(this.file(agent, c.cwd, a0, join('screenshots', `${stamp}.pdf`)));
      case 'tabs':
        return b.tabList();
      case 'tab':
        if (a0 === 'new') return b.newTab(a1 ?? 'about:blank');
        if (a0 === 'close') return b.closeTab(a1);
        return b.switchTab(need(a0, 'the tab number, new [url], or close [n]'));
    }
    throw new HttpError(400, `unknown browser command ${c.cmd}`);
  }

  /** Close a job's browser (its job ended, or the agent ran yaho browser close). */
  async close(job: string): Promise<void> {
    const e = this.jobs.get(job);
    if (!e) return;
    this.jobs.delete(job);
    const ses = e.session ?? (await e.starting?.catch(() => undefined));
    await ses?.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map((j) => this.close(j)));
  }

  /** Forget an agent's sign-ins: close its browsers and remove its profile. */
  async forget(agent: string): Promise<void> {
    await Promise.all([...this.jobs.entries()].filter(([, e]) => e.agent === agent).map(([j]) => this.close(j)));
    rmSync(this.profileDir(agent), { recursive: true, force: true });
  }
}
