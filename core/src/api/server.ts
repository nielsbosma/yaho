import { chmodSync, closeSync, constants, createReadStream, existsSync, fstatSync, openSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { basename, extname, join, normalize, relative, sep } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Ctx, BusEvent } from '../context.ts';
import { joinUnder, resolveUnder, UnsafePathError } from '../fsSafe.ts';
import { HttpError } from '../store.ts';
import { OPEN_PATHS } from './fonts.ts';
import { Router, decodePart, parseBody, readBytes, send, type Req } from './http.ts';
import { serverMode, sessionRoute, sessionValid, SESSION_BODY } from './session.ts';
import { handleBridge } from '../bridge.ts';
import { handleWhatsAppWebhook } from '../whatsapp/bridge.ts';
import { handleResendWebhook } from '../email/resend.ts';
import { handleTwilioWebhook, WEBHOOK_PATH as TWILIO_WEBHOOK } from '../sms/twilio.ts';
import { handleMcpOAuthCallback, MCP_OAUTH_CALLBACK } from './mcpRoutes.ts';
import { handleWebhook, HOOK_PREFIX, MAX_BODY } from '../webhooks/hooks.ts';
import { handleMcp } from './mcpServer.ts';
import { handleOAuth, MCP_PATH } from './oauth.ts';

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.yaml': 'application/yaml; charset=utf-8',
  '.yml': 'application/yaml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.woff2': 'font/woff2',
};

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function bearer(req: Req['raw'], query: URLSearchParams): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  // ?token= is for EventSource and links (GET only): a token in a URL ends up in logs and history.
  return req.method === 'GET' ? query.get('token') : null;
}

/** Resolve who is calling. The API token is the human; a live job token is that job's agent. */
function authenticate(ctx: Ctx, token: string | null): Req['caller'] | null {
  if (!token) return null;
  if (eq(token, ctx.apiToken)) return { kind: 'human' };
  const row = ctx.db.prepare('SELECT job, agent, expires FROM job_tokens WHERE token = ?').get(token) as
    | { job: string; agent: string; expires: string }
    | undefined;
  if (!row || row.expires < new Date().toISOString()) return null;
  return { kind: 'agent', agent: row.agent, job: row.job };
}

/** Types a browser would run as a page or script: these files are always downloaded, never shown. */
const ACTIVE = new Set(['.html', '.htm', '.xhtml', '.svg', '.xml', '.js', '.mjs']);

/** Content-Disposition with an ASCII fallback name and the real one in RFC 5987 form. */
export function disposition(kind: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * Stream a file from user or agent content: rel under root, never through a symlink that leaves it. It is sandboxed
 * (no scripts, no same-origin rights) and never sniffed, and pages, SVG and scripts are always downloaded. `download`
 * names the file and sets Content-Disposition: attachment.
 */
export function sendFile(res: Req['res'], root: string, rel: string, download?: string): void {
  let fd: number;
  let file: string;
  try {
    file = resolveUnder(root, rel);
    // Non-blocking, so a FIFO planted in a workspace cannot hang the core.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    if (e instanceof UnsafePathError) throw new HttpError(400, 'bad path');
    throw new HttpError(404, 'file not found');
  }
  const st = fstatSync(fd);
  if (!st.isFile()) {
    closeSync(fd);
    throw new HttpError(404, 'file not found');
  }
  const ext = extname(file).toLowerCase();
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': st.size,
    'X-Content-Type-Options': 'nosniff',
  };
  // Chromium's PDF viewer refuses sandboxed documents; PDFs run no script of the page's origin.
  if (ext !== '.pdf') headers['Content-Security-Policy'] = 'sandbox';
  if (download || ACTIVE.has(ext)) headers['Content-Disposition'] = disposition('attachment', download || basename(file));
  res.writeHead(200, headers);
  createReadStream('', { fd }).pipe(res);
}

/**
 * rel within root/folder, as a path relative to root, refusing one that leaves the folder. root is a folder only the
 * core writes (a project's, or the agents' folder), so a symlink planted in place of the folder is caught too.
 */
export function inFolder(root: string, folder: string, rel: string): string {
  try {
    return relative(root, joinUnder(join(root, folder), rel));
  } catch (e) {
    if (e instanceof UnsafePathError) throw new HttpError(400, 'bad path');
    throw e;
  }
}

/** The web UI's own files. */
function sendStatic(res: Req['res'], file: string): void {
  if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'file not found');
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': statSync(file).size,
  });
  createReadStream(file).pipe(res);
}

// ---- tickets: a link to one file for the system browser, so the API token never goes into a URL that leaves the app ----
const TICKET_S = 5 * 60;
const ticketSig = (ctx: Ctx, expires: number | string, path: string) =>
  createHmac('sha256', ctx.apiToken).update(`${expires}:${path}`).digest('hex');

/** A ticket for GET on path (a pathname under /api/, no query), valid for five minutes. */
export function makeTicket(ctx: Ctx, path: string, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + TICKET_S;
  return `${expires}.${ticketSig(ctx, expires, path)}`;
}

function ticketValid(ctx: Ctx, path: string, ticket: string): boolean {
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(ticket);
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  return eq(m[2]!, ticketSig(ctx, m[1]!, path));
}

/** Join a user-supplied relative path under a root, refusing anything that escapes it. */
export function safeJoin(root: string, rel: string): string {
  const full = normalize(join(root, rel));
  if (full !== normalize(root) && !full.startsWith(normalize(root) + sep)) throw new HttpError(400, 'bad path');
  return full;
}

/**
 * Serve the API and UI on host:port, and with socket also on that Unix socket: the way a sandboxed job's yaho reaches the
 * core, as the sandbox has its own network where 127.0.0.1 is not this machine.
 */
export function startServer(
  ctx: Ctx,
  router: Router,
  opts: { host: string; port: number; webRoot?: string; socket?: string },
): Promise<Server> {
  const sse = new Set<Req['res']>();
  ctx.bus.on('event', (e: BusEvent) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of sse) res.write(line);
  });
  setInterval(() => {
    for (const res of sse) res.write(': ping\n\n');
  }, 25_000).unref();

  const handler = async (raw: Req['raw'], res: Req['res']) => {
    const url = new URL(raw.url ?? '/', 'http://local');
    const path = url.pathname;
    const wantsYaml = !!raw.headers.accept?.includes('yaml');
    // Yaho's own MCP server and, on the server version, the sign-in MCP clients use: never open to other sites' pages.
    try {
      if (path === MCP_PATH) return await handleMcp(ctx, raw, res);
      if (serverMode() && (path.startsWith('/.well-known/') || path.startsWith('/oauth/')) && (await handleOAuth(ctx, raw, res, url)))
        return;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message }, false);
    }
    // The desktop's UI runs on another origin in development; a server only answers its own pages.
    if (!serverMode()) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (raw.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    try {
      if (path === '/api/health') return send(res, 200, { ok: true, name: 'yaho', pid: process.pid }, wantsYaml);
      // Claude Code to Chat Completions providers (bridge.ts); it checks the job token itself.
      if (path.startsWith('/bridge/') && (await handleBridge(ctx, raw, res, path, () => readBytes(raw, 64 * 1024 * 1024)))) return;
      // Meta's webhook for WhatsApp; it checks the app secret's signature itself.
      if (path === '/api/whatsapp/webhook')
        return await handleWhatsAppWebhook(ctx, raw, res, url.searchParams, () => readBytes(raw, 4 * 1024 * 1024));
      // Resend's webhook for inbound email; it checks the signing secret itself.
      if (path === '/api/resend/webhook') return await handleResendWebhook(ctx, raw, res, () => readBytes(raw, 4 * 1024 * 1024));
      // Twilio's webhook for incoming texts; it checks the auth token's signature itself.
      if (path === TWILIO_WEBHOOK) return await handleTwilioWebhook(ctx, raw, res, () => readBytes(raw, 256 * 1024));
      // An MCP server's sign-in page sends the browser back here; the state ties it to a sign-in Yaho started.
      if (path === MCP_OAUTH_CALLBACK && raw.method === 'GET') return await handleMcpOAuthCallback(ctx, url, res);
      // Agents' own webhooks: the token in the URL finds one, which checks its signature itself.
      if (path.startsWith(HOOK_PREFIX))
        return await handleWebhook(ctx, raw, res, path.slice(HOOK_PREFIX.length), () => readBytes(raw, MAX_BODY));

      if (path.startsWith('/api/')) {
        // Sign in and out (server version) are open, like health.
        const session = await sessionRoute(
          ctx,
          raw,
          res,
          path,
          async () => (parseBody(await readBytes(raw, SESSION_BODY), raw.headers['content-type']) ?? {}) as Record<string, unknown>,
        );
        if (session !== undefined) return send(res, 200, session, wantsYaml);
        // A ticket opens the one path it was made for (GET only). Font files are the only open routes: CSS url()
        // cannot carry a token.
        const ticket = raw.method === 'GET' ? url.searchParams.get('ticket') : null;
        const caller =
          authenticate(ctx, bearer(raw, url.searchParams)) ??
          (ticket && ticketValid(ctx, path, ticket) ? { kind: 'human' as const } : null) ??
          (sessionValid(ctx, raw, res) ? { kind: 'human' as const } : null) ??
          (OPEN_PATHS.test(path) && raw.method === 'GET' ? { kind: 'human' as const } : null);
        if (!caller) throw new HttpError(401, 'missing or invalid token');

        if (path === '/api/events' && caller.kind === 'human') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          res.write(': connected\n\n');
          sse.add(res);
          raw.on('close', () => sse.delete(res));
          return;
        }

        const m = router.match(raw.method ?? 'GET', path);
        if (!m) throw new HttpError(404, `no route ${raw.method} ${path}`);
        if (caller.kind === 'agent' && !m.route.agent) throw new HttpError(403, 'agents may not call this endpoint');
        let cached: Buffer | null = null;
        const bytes = async () => (cached ??= await readBytes(raw, m.route.maxBody));
        const req: Req = {
          raw,
          res,
          method: raw.method ?? 'GET',
          path,
          query: url.searchParams,
          params: m.params,
          caller,
          wantsYaml,
          bytes,
          body: async <T>() => parseBody(await bytes(), raw.headers['content-type']) as T,
        };
        const out = await m.route.handler(req);
        if (!res.headersSent) send(res, 200, out, wantsYaml);
        return;
      }

      // Everything else is the web UI (when built), with SPA fallback.
      if (opts.webRoot && existsSync(opts.webRoot)) {
        let file = safeJoin(opts.webRoot, decodePart(path));
        if (!existsSync(file) || statSync(file).isDirectory()) file = join(opts.webRoot, 'index.html');
        // index.html names the current build's files: never cache it, or a browser keeps the old app after an update.
        // The built files under /assets/ have hashed names and can be cached for good.
        res.setHeader(
          'Cache-Control',
          path.startsWith('/assets/') && !file.endsWith('index.html') ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
        return sendStatic(res, file);
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      // Internal errors are logged, not shown: their messages can name paths and other internals.
      send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message }, wantsYaml);
    }
  };

  const server = createServer(handler);
  if (opts.socket) {
    const socket = opts.socket;
    const local = createServer(handler);
    rmSync(socket, { force: true });
    local.on('error', (e) => console.error(`[server] no Unix socket at ${socket}: ${e.message}`));
    // Agents may run as their own user (server version); the job token still decides what a caller may do.
    local.listen(socket, () => chmodSync(socket, 0o666));
    server.on('close', () => {
      local.closeAllConnections();
      local.close();
      rmSync(socket, { force: true });
    });
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
