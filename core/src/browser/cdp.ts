import type { Readable, Writable } from 'node:stream';

type Listener = (params: Record<string, unknown>, sessionId?: string) => void;

/**
 * A Chrome DevTools Protocol connection to a whole browser, over Chromium's debugging pipe (a browser Yaho started)
 * or a WebSocket (a cloud browser). Pages are reached through flattened sessions: every command and event carries the
 * page's sessionId.
 */
export class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; method: string }>();
  private listeners = new Map<string, Set<Listener>>();
  private writeRaw: (s: string) => void;
  private closeRaw: () => void;
  closed = false;
  onClose?: () => void;

  constructor(write: (s: string) => void, close: () => void) {
    this.writeRaw = write;
    this.closeRaw = close;
  }

  /** Chromium started with --remote-debugging-pipe: commands go to its fd 3, replies come from its fd 4, NUL-separated. */
  static overPipe(input: Writable, output: Readable): Cdp {
    const c = new Cdp(
      (s) => input.write(`${s}\0`),
      () => input.end(),
    );
    let buf = '';
    output.setEncoding('utf8');
    output.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\0')) >= 0) {
        const msg = buf.slice(0, i);
        buf = buf.slice(i + 1);
        c.receive(msg);
      }
    });
    output.on('close', () => c.gone());
    input.on('error', () => c.gone());
    return c;
  }

  static async overWebSocket(url: string, timeoutMs = 30_000): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out connecting to the browser')), timeoutMs);
      ws.addEventListener('open', () => (clearTimeout(t), resolve()));
      ws.addEventListener('error', () => (clearTimeout(t), reject(new Error('could not connect to the browser'))));
    });
    const c = new Cdp(
      (s) => ws.send(s),
      () => ws.close(),
    );
    ws.addEventListener('message', (e) =>
      c.receive(typeof e.data === 'string' ? e.data : Buffer.from(e.data as ArrayBuffer).toString('utf8')),
    );
    ws.addEventListener('close', () => c.gone());
    return c;
  }

  private receive(raw: string): void {
    let m: {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: { message: string };
      sessionId?: string;
    };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result ?? {});
      return;
    }
    if (m.method) for (const l of this.listeners.get(m.method) ?? []) l(m.params ?? {}, m.sessionId);
  }

  private gone(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('the browser closed'));
    this.pending.clear();
    this.onClose?.();
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the browser closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => (clearTimeout(t), resolve(v as T)),
        reject: (e) => (clearTimeout(t), reject(e)),
      });
      this.writeRaw(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, l: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(l);
    return () => set.delete(l);
  }

  close(): void {
    try {
      this.closeRaw();
    } catch {
      /* already closed */
    }
    this.gone();
  }
}
