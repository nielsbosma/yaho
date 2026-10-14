import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { contextPrompt } from '../jobs/prompt.ts';
import { serve } from '../serve.ts';
import { getAgent, saveAgent } from '../store.ts';
import { siteAllowed } from './index.ts';
import { findBrowser } from './launch.ts';
import { renderSnapshot, type AXNode } from './snapshot.ts';

describe('siteAllowed', () => {
  it('allows everything without a list', () => {
    expect(siteAllowed('https://anything.example/x', [])).toBe(true);
    expect(siteAllowed('https://anything.example/x', undefined)).toBe(true);
  });

  it('matches hosts and their subdomains', () => {
    const sites = ['example.com', '*.shop.io', 'https://docs.acme.dev/guide'];
    expect(siteAllowed('https://example.com/a', sites)).toBe(true);
    expect(siteAllowed('http://www.example.com:8080/a', sites)).toBe(true);
    expect(siteAllowed('https://notexample.com', sites)).toBe(false);
    expect(siteAllowed('https://eu.shop.io', sites)).toBe(true);
    expect(siteAllowed('https://docs.acme.dev/other', sites)).toBe(true);
    expect(siteAllowed('https://acme.dev', sites)).toBe(false);
    expect(siteAllowed('about:blank', sites)).toBe(true);
    expect(siteAllowed('file:///etc/passwd', sites)).toBe(false);
    expect(siteAllowed('chrome://settings', sites)).toBe(false);
  });
});

describe('renderSnapshot', () => {
  it('outlines the page with refs on what can be acted on', () => {
    const n = (nodeId: string, role: string, name: string, childIds: string[] = [], extra: Partial<AXNode> = {}): AXNode => ({
      nodeId,
      role: { value: role },
      name: { value: name },
      childIds,
      ...extra,
    });
    const nodes: AXNode[] = [
      n('1', 'RootWebArea', 'Shop', ['2', '3', '6', '8']),
      n('2', 'heading', 'Welcome', ['2a'], { properties: [{ name: 'level', value: { value: 1 } }] }),
      n('2a', 'StaticText', 'Welcome', [], { parentId: '2' }),
      n('3', 'generic', '', ['4', '5'], { parentId: '1' }),
      n('4', 'link', 'Home', ['4a'], { backendDOMNodeId: 40, parentId: '3' }),
      n('4a', 'StaticText', 'Home', [], { parentId: '4' }),
      n('5', 'textbox', 'Search', [], { backendDOMNodeId: 50, parentId: '3', value: { value: 'shoes' } }),
      n('6', 'button', 'Buy', [], { backendDOMNodeId: 60, parentId: '1', properties: [{ name: 'disabled', value: { value: true } }] }),
      n('8', 'StaticText', 'Free shipping', [], { parentId: '1' }),
    ];
    nodes.forEach((x) => x.nodeId !== '1' && (x.parentId ??= '1'));
    const s = renderSnapshot(nodes);
    expect(s.text).toBe(
      [
        '- heading "Welcome" [level=1]',
        '- link "Home" [ref=e1]',
        '- textbox "Search" [value="shoes", ref=e2]',
        '- button "Buy" [disabled, ref=e3]',
        '- text: "Free shipping"',
      ].join('\n'),
    );
    expect([...s.refs]).toEqual([
      ['e1', 40],
      ['e2', 50],
      ['e3', 60],
    ]);
  });

  it('cuts long pages', () => {
    const nodes: AXNode[] = [{ nodeId: 'r', role: { value: 'RootWebArea' }, childIds: Array.from({ length: 500 }, (_, i) => `t${i}`) }];
    for (let i = 0; i < 500; i++)
      nodes.push({ nodeId: `t${i}`, parentId: 'r', role: { value: 'StaticText' }, name: { value: `line ${i} `.repeat(10) } });
    const s = renderSnapshot(nodes, 2000);
    expect(s.text.length).toBeLessThan(2200);
    expect(s.text).toMatch(/the page is longer/);
  });
});

const PAGE = `<!doctype html><title>Test shop</title>
<h1>Shop</h1>
<a href="/second">Second page</a>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'Searched ' + this.q.value">
  <label>Query <input name="q"></label>
  <select name="size" aria-label="Size" onchange="document.getElementById('out').textContent = 'Size ' + this.value">
    <option value="s">Small</option><option value="m">Medium</option>
  </select>
</form>
<button onclick="alert('hello')">Alert</button>
<button onclick="window.open('/second')">Popup</button>
<a href="https://blocked.invalid/">Elsewhere</a>
<p id="out"></p>`;

describe.skipIf(!findBrowser({} as never))('a real browser', () => {
  let dir: string;
  let ctx: Ctx;
  let close: () => Promise<void>;
  let site: Server;
  let base = '';
  let job = '';

  beforeAll(async () => {
    site = createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(req.url === '/second' ? '<title>Second</title><p>The second page</p>' : PAGE);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
    dir = mkdtempSync(join(tmpdir(), 'yaho-browser-'));
    ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
    saveAgent(ctx, { name: 'surfer', browser: true, triggers: [] });
    saveAgent(ctx, { name: 'reader', triggers: [] });
    job = 'job_browser';
    ctx.db
      .prepare("INSERT INTO jobs (id, agent, trigger_type, status, created) VALUES (?, 'surfer', 'manual', 'running', ?)")
      .run(job, new Date().toISOString());
  }, 30_000);

  afterAll(async () => {
    await close();
    await new Promise((r) => site.close(r));
    delete process.env.YAHO_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (cmd: string, args: string[] = [], flags: Record<string, string | boolean> = {}) =>
    ctx.browser!.run('surfer', job, { cmd, args, flags }).then((r) => r.text);
  const refOf = (snap: string, label: RegExp) => {
    const line = snap.split('\n').find((l) => label.test(l));
    return /ref=(e\d+)/.exec(line ?? '')?.[1] ?? '';
  };

  it('is only for agents with the browser on, and tells them about it', () => {
    expect(() => ctx.browser!.run('reader', job, { cmd: 'open', args: [base] })).toThrow(/not on for you/);
    expect(contextPrompt(ctx, getAgent(ctx, 'surfer'), { id: job } as never, null, false)).toMatch(/## Browser/);
    expect(contextPrompt(ctx, getAgent(ctx, 'reader'), { id: job } as never, null, false)).not.toMatch(/## Browser/);
  });

  it('opens, reads and acts on a page', async () => {
    expect(await run('open', [base])).toMatch(/Test shop/);
    let snap = await run('snapshot');
    expect(snap).toMatch(/heading "Shop"/);
    await run('type', [refOf(snap, /textbox "Query"/), 'red shoes'], { submit: true });
    expect(await run('text')).toMatch(/Searched red shoes/);

    snap = await run('snapshot');
    await run('select', [refOf(snap, /combobox "Size"/), 'Medium']);
    expect(await run('eval', ["document.getElementById('out').textContent"])).toMatch(/Size m/);

    snap = await run('snapshot');
    expect(await run('click', [refOf(snap, /button "Alert"/)])).toMatch(/alert dialog: "hello"/);

    snap = await run('snapshot');
    expect(await run('click', [refOf(snap, /link "Second page"/)])).toMatch(/Second/);
    expect(await run('back')).toMatch(/Test shop/);
  }, 60_000);

  it('follows new tabs and saves screenshots in the workspace', async () => {
    const snap = await run('snapshot');
    expect(await run('click', [refOf(snap, /button "Popup"/)])).toMatch(/new tab opened/);
    expect(await run('tabs')).toMatch(/2\. Second/);
    await run('tab', ['2']);
    const shot = await run('screenshot', ['shots/second.png']);
    expect(existsSync(join(ctx.paths.agent('surfer'), 'shots', 'second.png'))).toBe(true);
    expect(shot).toMatch(/Second/);
    await expect(run('screenshot', ['/etc/x.png'])).rejects.toThrow(/workspace/);
    await run('tab', ['close']);
  }, 60_000);

  it('keeps tabs to the allowed sites', async () => {
    ctx.settings.browser = { allowed_sites: ['127.0.0.1'] };
    try {
      await expect(run('open', ['https://blocked.invalid/'])).rejects.toThrow(/not an allowed site/);
      await run('open', [base]);
      const snap = await run('snapshot');
      expect(await run('click', [refOf(snap, /link "Elsewhere"/)])).toMatch(/Blocked https:\/\/blocked\.invalid/);
    } finally {
      ctx.settings.browser = {};
    }
  }, 60_000);

  it('closes the browser when the job ends', async () => {
    const pid = ctx.browser!.jobs.get(job);
    expect(pid?.session).toBeTruthy();
    await ctx.browser!.close(job);
    expect(ctx.browser!.jobs.has(job)).toBe(false);
    expect(existsSync(join(ctx.browser!.profileDir('surfer'), 'profile'))).toBe(true);
    await ctx.browser!.forget('surfer');
    expect(existsSync(ctx.browser!.profileDir('surfer'))).toBe(false);
  }, 30_000);

  it('tests the browser from Settings', async () => {
    const r = await ctx.browser!.test();
    expect(r).toMatchObject({ ok: true });
  }, 30_000);
});
