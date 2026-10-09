import type { IncomingMessage, ServerResponse } from 'node:http';
import YAML from 'yaml';
import { HttpError } from '../store.ts';

export interface Req {
  raw: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  /** Who is calling: the human (API token) or an agent (job token). */
  caller: { kind: 'human' } | { kind: 'agent'; agent: string; job: string };
  wantsYaml: boolean;
  body<T = unknown>(): Promise<T>;
  bytes(): Promise<Buffer>;
}

export type Handler = (req: Req) => unknown | Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  agent: boolean;
}

/** A tiny path router: `/api/agents/:name`. Routes are human-only unless registered with `agent: true`. */
export class Router {
  routes: Route[] = [];

  on(method: string, path: string, handler: Handler, opts: { agent?: boolean } = {}): void {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler, agent: !!opts.agent });
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const p = route.parts[i]!;
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i]!);
        else if (p !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }
}

export async function readBytes(req: IncomingMessage, limit = 512 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** JSON or YAML, by Content-Type. An empty body is `{}`. */
export function parseBody(buf: Buffer, contentType: string | undefined): unknown {
  const text = buf.toString('utf8');
  if (!text.trim()) return {};
  try {
    if (contentType?.includes('json')) return JSON.parse(text);
    return YAML.parse(text);
  } catch (e) {
    throw new HttpError(400, `could not parse request body: ${(e as Error).message}`);
  }
}

export function send(res: ServerResponse, status: number, data: unknown, yaml: boolean): void {
  if (res.headersSent) return;
  if (data === undefined || data === null) data = { ok: true };
  const body = yaml ? YAML.stringify(data) : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': yaml ? 'application/yaml; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
