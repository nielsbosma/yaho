import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertUnder, isLink, writeFileUnder } from '../fsSafe.ts';
import type { Launched } from './launch.ts';
import { renderSnapshot } from './snapshot.ts';

interface Tab {
  targetId: string;
  sessionId: string;
  refs: Map<string, number>;
  loading: boolean;
  inflight: Set<string>;
  lastNetwork: number;
}

const KEYS: Record<string, { code: string; key: string; vk: number; text?: string }> = {
  enter: { code: 'Enter', key: 'Enter', vk: 13, text: '\r' },
  tab: { code: 'Tab', key: 'Tab', vk: 9 },
  escape: { code: 'Escape', key: 'Escape', vk: 27 },
  backspace: { code: 'Backspace', key: 'Backspace', vk: 8 },
  delete: { code: 'Delete', key: 'Delete', vk: 46 },
  space: { code: 'Space', key: ' ', vk: 32, text: ' ' },
  arrowup: { code: 'ArrowUp', key: 'ArrowUp', vk: 38 },
  arrowdown: { code: 'ArrowDown', key: 'ArrowDown', vk: 40 },
  arrowleft: { code: 'ArrowLeft', key: 'ArrowLeft', vk: 37 },
  arrowright: { code: 'ArrowRight', key: 'ArrowRight', vk: 39 },
  pageup: { code: 'PageUp', key: 'PageUp', vk: 33 },
  pagedown: { code: 'PageDown', key: 'PageDown', vk: 34 },
  home: { code: 'Home', key: 'Home', vk: 36 },
  end: { code: 'End', key: 'End', vk: 35 },
};
KEYS.esc = KEYS.escape!;
KEYS.return = KEYS.enter!;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SessionOptions {
  /** Whether the browser may open a page (Guard Rails → allowed sites). */
  allowed: (url: string) => boolean;
  /** The agent's workspace: files the browser saves (screenshots, PDFs, cookies) stay in it, never through a link. */
  root: string;
  /** Where downloads land (local browsers only). */
  downloads: string;
  /** Cookies are saved here between jobs when the browser itself keeps no profile (cloud browsers). */
  cookieFile: string;
}

/**
 * One job's browser: its tabs, the refs of the last snapshot, and the actions an agent takes through yaho browser.
 * Notes (dialogs, blocked pages, new tabs, downloads) are collected and reported with the next command's result.
 */
export class BrowserSession {
  launched: Launched;
  opts: SessionOptions;
  tabs = new Map<string, Tab>();
  current = '';
  notes: string[] = [];
  closed = false;

  constructor(launched: Launched, opts: SessionOptions) {
    this.launched = launched;
    this.opts = opts;
  }

  get cdp() {
    return this.launched.cdp;
  }

  static async start(launched: Launched, opts: SessionOptions): Promise<BrowserSession> {
    const s = new BrowserSession(launched, opts);
    await s.init();
    return s;
  }

  private async init(): Promise<void> {
    const { cdp } = this;
    cdp.on('Target.attachedToTarget', (p, parent) => {
      const t = p.targetInfo as { targetId: string; type: string; openerId?: string };
      const sessionId = p.sessionId as string;
      if (this.tabs.has(t.targetId)) return;
      if (parent || t.type !== 'page') return void cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
      void this.setup(t.targetId, sessionId).then(() => {
        if (t.openerId) this.notes.push(`A new tab opened (tab ${this.indexOf(t.targetId)}); yaho browser tabs lists them.`);
      });
    });
    cdp.on('Target.targetDestroyed', (p) => {
      const id = p.targetId as string;
      if (!this.tabs.delete(id)) return;
      if (this.current === id) this.current = [...this.tabs.keys()][0] ?? '';
    });
    cdp.on('Fetch.requestPaused', (p, sessionId) => {
      const url = (p.request as { url: string }).url;
      if (this.opts.allowed(url)) void cdp.send('Fetch.continueRequest', { requestId: p.requestId }, sessionId).catch(() => undefined);
      else {
        this.notes.push(`Blocked ${url}: not an allowed site (Settings → Guard Rails).`);
        void cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => undefined);
      }
    });
    cdp.on('Page.javascriptDialogOpening', (p, sessionId) => {
      this.notes.push(`The page showed a ${p.type} dialog: ${JSON.stringify(p.message)}; it was accepted.`);
      void cdp.send('Page.handleJavaScriptDialog', { accept: true, promptText: '' }, sessionId).catch(() => undefined);
    });
    const tabOf = (sessionId?: string) => [...this.tabs.values()].find((t) => t.sessionId === sessionId);
    cdp.on('Network.requestWillBeSent', (p, sid) => {
      const t = tabOf(sid);
      if (!t) return;
      t.inflight.add(p.requestId as string);
      t.lastNetwork = Date.now();
    });
    for (const ev of ['Network.loadingFinished', 'Network.loadingFailed'])
      cdp.on(ev, (p, sid) => {
        const t = tabOf(sid);
        if (!t) return;
        t.inflight.delete(p.requestId as string);
        t.lastNetwork = Date.now();
      });
    cdp.on('Page.frameStartedLoading', (p, sid) => {
      const t = tabOf(sid);
      if (t && p.frameId === t.targetId) t.loading = true;
    });
    cdp.on('Page.loadEventFired', (_p, sid) => {
      const t = tabOf(sid);
      if (t) t.loading = false;
    });
    const downloads = new Map<string, string>();
    cdp.on('Browser.downloadWillBegin', (p) => void downloads.set(p.guid as string, p.suggestedFilename as string));
    cdp.on('Browser.downloadProgress', (p) => {
      if (p.state === 'completed') this.notes.push(`Downloaded ${join(this.opts.downloads, downloads.get(p.guid as string) ?? '')}`);
      else if (p.state === 'canceled') this.notes.push(`A download was canceled.`);
    });

    // New tabs are attached paused, so the allowed-sites check is in place before their first page loads.
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    if (this.launched.keepsProfile)
      await cdp
        .send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: this.opts.downloads, eventsEnabled: true })
        .catch(() => undefined);
    else if (existsSync(this.opts.cookieFile) && !isLink(this.opts.cookieFile)) {
      try {
        assertUnder(this.opts.root, this.opts.cookieFile);
        await cdp.send('Storage.setCookies', { cookies: JSON.parse(readFileSync(this.opts.cookieFile, 'utf8')) });
      } catch {
        /* stale or unreadable cookies: start signed out */
      }
    }
    const { targetInfos } = await cdp.send<{ targetInfos: Array<{ targetId: string; type: string }> }>('Target.getTargets');
    const pages = targetInfos.filter((t) => t.type === 'page');
    if (pages.length) for (const p of pages) await this.attach(p.targetId);
    else await this.newTab('about:blank');
    this.current = [...this.tabs.keys()][0] ?? '';
  }

  private waiting = new Map<string, (t: Tab) => void>();

  private async setup(targetId: string, sessionId: string): Promise<Tab> {
    const tab: Tab = { targetId, sessionId, refs: new Map(), loading: false, inflight: new Set(), lastNetwork: 0 };
    this.tabs.set(targetId, tab);
    const { cdp } = this;
    await Promise.all([cdp.send('Page.enable', {}, sessionId), cdp.send('Network.enable', {}, sessionId)]).catch(() => undefined);
    await cdp
      .send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }, sessionId)
      .catch(() => undefined);
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
    this.waiting.get(targetId)?.(tab);
    this.waiting.delete(targetId);
    return tab;
  }

  /** A tab Yaho just created: auto-attach brings it, or (if that never comes) attach it by hand. */
  private async arrival(targetId: string): Promise<Tab> {
    const known = this.tabs.get(targetId);
    if (known) return known;
    const arrived = new Promise<Tab | null>((resolve) => {
      this.waiting.set(targetId, resolve);
      setTimeout(() => resolve(null), 5000);
    });
    return (await arrived) ?? this.attach(targetId);
  }

  /** A tab that existed before auto-attach was on. */
  private async attach(targetId: string): Promise<Tab> {
    const known = this.tabs.get(targetId);
    if (known) return known;
    const { sessionId } = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    return this.tabs.get(targetId) ?? this.setup(targetId, sessionId);
  }

  private indexOf(targetId: string): number {
    return [...this.tabs.keys()].indexOf(targetId) + 1;
  }

  private tab(): Tab {
    const t = this.tabs.get(this.current) ?? [...this.tabs.values()][0];
    if (!t) throw new Error('no tab is open; yaho browser open <url> opens one');
    this.current = t.targetId;
    return t;
  }

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.cdp.send<T>(method, params, this.tab().sessionId, timeoutMs);
  }

  /** Wait for a navigation the action started to load, then for the network to go quiet. */
  async settle(maxMs = 15_000): Promise<void> {
    const t = this.tab();
    const start = Date.now();
    await sleep(150);
    while (Date.now() - start < maxMs) {
      // A page from the back-forward cache, or a load that never reports, is done once the document is complete.
      if (t.loading && Date.now() - start > 500 && (await this.evaluate('document.readyState').catch(() => '')) === 'complete')
        t.loading = false;
      if (!t.loading && (t.inflight.size === 0 || Date.now() - t.lastNetwork > 2000) && Date.now() - t.lastNetwork > 400) return;
      await sleep(100);
    }
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{
      result: { value?: unknown; description?: string };
      exceptionDetails?: { exception?: { description?: string }; text: string };
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  async where(): Promise<string> {
    const info = await this.evaluate<{ title: string; url: string }>('({ title: document.title, url: location.href })').catch(() => null);
    return info ? `Tab ${this.indexOf(this.current)}: ${info.title ? `${info.title} · ` : ''}${info.url}` : '';
  }

  /** The result of a command: what it said, where the tab is now, and anything that happened meanwhile. */
  async report(text?: string): Promise<string> {
    const lines = [text, await this.where(), ...this.notes.splice(0)].filter(Boolean);
    return lines.join('\n');
  }

  async open(url: string): Promise<string> {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    if (!this.opts.allowed(url)) throw new Error(`${url} is not an allowed site (Settings → Guard Rails)`);
    const t = this.tab();
    t.loading = true;
    const r = await this.send<{ errorText?: string }>('Page.navigate', { url });
    if (r.errorText) {
      t.loading = false;
      throw new Error(`could not open ${url}: ${r.errorText}`);
    }
    await this.settle();
    return this.report();
  }

  async snapshot(): Promise<string> {
    const t = this.tab();
    const { nodes } = await this.send<{ nodes: Parameters<typeof renderSnapshot>[0] }>('Accessibility.getFullAXTree');
    const s = renderSnapshot(nodes);
    t.refs = s.refs;
    return this.report(s.text);
  }

  private node(ref: string): number {
    const id = this.tab().refs.get(ref.replace(/^\[?ref=|\]$/g, ''));
    if (id === undefined) throw new Error(`no element ${ref} on this page: take a new yaho browser snapshot and use a ref from it`);
    return id;
  }

  private async center(backendNodeId: number): Promise<{ x: number; y: number } | null> {
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
    const { quads } = await this.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId }).catch(() => ({
      quads: [] as number[][],
    }));
    const q = quads[0];
    if (!q) return null;
    return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
  }

  private async callOn<T = unknown>(backendNodeId: number, fn: string, args: unknown[] = []): Promise<T> {
    const { object } = await this.send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId });
    const r = await this.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
      'Runtime.callFunctionOn',
      {
        objectId: object.objectId,
        functionDeclaration: fn,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      },
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  async click(ref: string): Promise<string> {
    const id = this.node(ref);
    const at = await this.center(id);
    if (!at) await this.callOn(id, 'function () { this.click(); }');
    else {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    }
    await this.settle();
    return this.report(`Clicked ${ref}`);
  }

  async hover(ref: string): Promise<string> {
    const at = await this.center(this.node(ref));
    if (!at) throw new Error(`${ref} is not visible`);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await sleep(200);
    return this.report(`Hovering over ${ref}`);
  }

  async type(ref: string, text: string, o: { append?: boolean; submit?: boolean } = {}): Promise<string> {
    const id = this.node(ref);
    await this.send('DOM.focus', { backendNodeId: id }).catch(() => this.callOn(id, 'function () { this.focus(); }'));
    if (!o.append)
      await this.callOn(
        id,
        `function () {
          if ('value' in this) { this.value = ''; this.dispatchEvent(new Event('input', { bubbles: true })); }
          else if (this.isContentEditable) this.textContent = '';
        }`,
      );
    await this.send('Input.insertText', { text });
    if (o.submit) return this.press('Enter');
    await sleep(100);
    return this.report(`Typed into ${ref}`);
  }

  async press(key: string): Promise<string> {
    const k = KEYS[key.toLowerCase()];
    if (!k && [...key].length !== 1) throw new Error(`unknown key ${key} (use a character, or ${Object.keys(KEYS).join(', ')})`);
    const d = k ?? { code: '', key, vk: 0, text: key };
    const base = { key: d.key, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk };
    await this.send('Input.dispatchKeyEvent', {
      type: d.text ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(d.text ? { text: d.text, unmodifiedText: d.text } : {}),
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await this.settle();
    return this.report(`Pressed ${d.key}`);
  }

  async select(ref: string, choice: string): Promise<string> {
    const chosen = await this.callOn<string | null>(
      this.node(ref),
      `function (choice) {
        if (!(this instanceof HTMLSelectElement)) throw new Error('not a dropdown (select)');
        const o = [...this.options].find((o) => o.value === choice) ?? [...this.options].find((o) => o.label.trim() === choice.trim());
        if (!o) return null;
        this.value = o.value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return o.label;
      }`,
      [choice],
    );
    if (chosen === null) throw new Error(`${ref} has no option ${JSON.stringify(choice)}`);
    await this.settle();
    return this.report(`Selected ${JSON.stringify(chosen)} in ${ref}`);
  }

  async scroll(dir: string, amount = 700): Promise<string> {
    if (/^e\d+$/.test(dir)) {
      await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: this.node(dir) });
      return this.report(`Scrolled to ${dir}`);
    }
    const dy = { down: amount, up: -amount, top: -1e9, bottom: 1e9 }[dir];
    if (dy === undefined) throw new Error('scroll down, up, top, bottom, or to a ref');
    await this.evaluate(`window.scrollBy(0, ${dy})`);
    await sleep(300);
    return this.report(`Scrolled ${dir}`);
  }

  async history(delta: -1 | 1 | 0): Promise<string> {
    const t = this.tab();
    if (delta === 0) {
      t.loading = true;
      await this.send('Page.reload');
    } else {
      const h = await this.send<{ currentIndex: number; entries: Array<{ id: number }> }>('Page.getNavigationHistory');
      const e = h.entries[h.currentIndex + delta];
      if (!e) throw new Error(`there is no page to go ${delta < 0 ? 'back' : 'forward'} to`);
      t.loading = true;
      await this.send('Page.navigateToHistoryEntry', { entryId: e.id });
    }
    await this.settle();
    return this.report();
  }

  async waitFor(o: { text?: string; selector?: string; gone?: boolean; seconds?: number }): Promise<string> {
    const until = Date.now() + (o.seconds ?? 15) * 1000;
    if (!o.text && !o.selector) {
      await sleep((o.seconds ?? 1) * 1000);
      return this.report(`Waited ${o.seconds ?? 1}s`);
    }
    const probe = o.selector
      ? `!!document.querySelector(${JSON.stringify(o.selector)})`
      : `(document.body?.innerText ?? '').includes(${JSON.stringify(o.text)})`;
    while (Date.now() < until) {
      if ((await this.evaluate<boolean>(probe).catch(() => false)) !== !!o.gone)
        return this.report(`Found ${o.selector ?? JSON.stringify(o.text)}${o.gone ? ' gone' : ''}`);
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${o.selector ?? JSON.stringify(o.text)}${o.gone ? ' to go away' : ''}`);
  }

  async text(): Promise<string> {
    const body = await this.evaluate<string>('document.body ? document.body.innerText : ""');
    const max = 50_000;
    return this.report(body.length > max ? `${body.slice(0, max)}\n… (${body.length - max} more characters)` : body);
  }

  async eval(js: string): Promise<string> {
    const v = await this.evaluate(js);
    return this.report(v === undefined ? 'undefined' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }

  async screenshot(file: string, o: { full?: boolean; ref?: string } = {}): Promise<string> {
    let clip: Record<string, number> | undefined;
    if (o.ref) {
      const id = this.node(o.ref);
      await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: id }).catch(() => undefined);
      const { model } = await this.send<{ model: { border: number[] } }>('DOM.getBoxModel', { backendNodeId: id });
      const xs = model.border.filter((_, i) => i % 2 === 0);
      const ys = model.border.filter((_, i) => i % 2 === 1);
      const sc = await this.evaluate<{ x: number; y: number }>('({ x: scrollX, y: scrollY })');
      clip = {
        x: Math.min(...xs) + sc.x,
        y: Math.min(...ys) + sc.y,
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
        scale: 1,
      };
    }
    const { data } = await this.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : o.full ? { captureBeyondViewport: true } : {}) },
      60_000,
    );
    writeFileUnder(this.opts.root, file, Buffer.from(data, 'base64'));
    return this.report(`Saved ${file}`);
  }

  async pdf(file: string): Promise<string> {
    const { data } = await this.send<{ data: string }>('Page.printToPDF', { printBackground: true }, 60_000);
    writeFileUnder(this.opts.root, file, Buffer.from(data, 'base64'));
    return this.report(`Saved ${file}`);
  }

  async newTab(url: string): Promise<string> {
    if (url !== 'about:blank' && !this.opts.allowed(url)) throw new Error(`${url} is not an allowed site (Settings → Guard Rails)`);
    const { targetId } = await this.cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    await this.arrival(targetId);
    this.current = targetId;
    if (url !== 'about:blank') return this.open(url);
    return this.report();
  }

  async tabList(): Promise<string> {
    const { targetInfos } = await this.cdp.send<{ targetInfos: Array<{ targetId: string; title: string; url: string }> }>(
      'Target.getTargets',
    );
    const info = new Map(targetInfos.map((t) => [t.targetId, t]));
    return [...this.tabs.keys()]
      .map((id, i) => `${id === this.current ? '*' : ' '} ${i + 1}. ${info.get(id)?.title || '(untitled)'} · ${info.get(id)?.url ?? ''}`)
      .join('\n');
  }

  private nth(n: string): string {
    const id = [...this.tabs.keys()][Number(n) - 1];
    if (!id) throw new Error(`there is no tab ${n} (yaho browser tabs lists them)`);
    return id;
  }

  async switchTab(n: string): Promise<string> {
    this.current = this.nth(n);
    await this.cdp.send('Target.activateTarget', { targetId: this.current }).catch(() => undefined);
    return this.report();
  }

  async closeTab(n?: string): Promise<string> {
    const id = n ? this.nth(n) : this.tab().targetId;
    await this.cdp.send('Target.closeTarget', { targetId: id });
    this.tabs.delete(id);
    if (this.current === id) this.current = [...this.tabs.keys()][0] ?? '';
    if (!this.current) await this.newTab('about:blank');
    return this.report('Closed the tab');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.launched.keepsProfile && !this.cdp.closed) {
      const r = await this.cdp.send<{ cookies: unknown[] }>('Storage.getCookies', {}, undefined, 5000).catch(() => null);
      if (r) {
        try {
          writeFileUnder(this.opts.root, this.opts.cookieFile, JSON.stringify(r.cookies), { mode: 0o660 });
        } catch {
          /* a link where the cookie file goes: the sign-ins are not kept */
        }
      }
    }
    await this.launched.close();
  }
}
