import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { Ctx, BusEvent } from '../context.ts';
import { HttpError } from '../store.ts';
import { OPEN_PATHS } from './fonts.ts';
import { Router, parseBody, readBytes, send, type Req } from './http.ts';

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

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function bearer(req: Req['raw'], query: URLSearchParams): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  return query.get('token');
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

/** Stream a file with the right type. `download` sets Content-Disposition: attachment. */
export function sendFile(res: Req['res'], file: string, download?: string): void {
  if (!existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'file not found');
  const headers: Record<string, string | number> = {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': statSync(file).size,
  };
  if (download) headers['Content-Disposition'] = `attachment; filename="${download.replace(/"/g, '')}"`;
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

/** Join a user-supplied relative path under a root, refusing anything that escapes it. */
export function safeJoin(root: string, rel: string): string {
  const full = normalize(join(root, rel));
  if (full !== normalize(root) && !full.startsWith(normalize(root) + sep)) throw new HttpError(400, 'bad path');
  return full;
}

export function startServer(ctx: Ctx, router: Router, opts: { host: string; port: number; webRoot?: string }): Promise<Server> {
  const sse = new Set<Req['res']>();
  ctx.bus.on('event', (e: BusEvent) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of sse) res.write(line);
  });
  setInterval(() => {
    for (const res of sse) res.write(': ping\n\n');
  }, 25_000).unref();

  const server = createServer(async (raw, res) => {
    const url = new URL(raw.url ?? '/', 'http://local');
    const path = url.pathname;
    const wantsYaml = !!raw.headers.accept?.includes('yaml');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (raw.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    try {
      if (path === '/api/health') return send(res, 200, { ok: true, name: 'yaho', pid: process.pid }, wantsYaml);

      if (path.startsWith('/api/')) {
        // Font files are the only open routes: CSS url() cannot carry a token.
        const caller =
          authenticate(ctx, bearer(raw, url.searchParams)) ??
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
        const bytes = async () => (cached ??= await readBytes(raw));
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
        let file = safeJoin(opts.webRoot, decodeURIComponent(path));
        if (!existsSync(file) || statSync(file).isDirectory()) file = join(opts.webRoot, 'index.html');
        return sendFile(res, file);
      }
      throw new HttpError(404, 'not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      send(res, status, { error: (e as Error).message }, wantsYaml);
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve(server));
  });
}
