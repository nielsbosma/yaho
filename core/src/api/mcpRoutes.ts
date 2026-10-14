import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from '../context.ts';
import { normalizeMcp, parseImport, referencedKeys, type McpConfig } from '../mcp/config.ts';
import { Dopbase } from '../secrets/dopbase.ts';
import * as s from '../store.ts';
import { HttpError } from '../store.ts';
import type { Req, Router } from './http.ts';

export const MCP_OAUTH_CALLBACK = '/api/mcp/oauth/callback';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();

/** The address the browser reached the core on, for the OAuth redirect back to it. */
function origin(raw: IncomingMessage): string {
  const host = first(raw.headers['x-forwarded-host']) ?? first(raw.headers.host) ?? '127.0.0.1';
  const proto = first(raw.headers['x-forwarded-proto']) ?? ((raw.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

interface NewMcp {
  name?: string;
  briefing?: string;
  config?: unknown;
  keys?: Array<{ name: string; value?: string; secret?: boolean }>;
  agents?: string[];
}

/** Create an MCP resource: its config, a key for every ${KEY} it names, and the values given for them. */
async function createMcp(ctx: Ctx, b: NewMcp): Promise<s.Resource> {
  const name = String(b.name ?? '').trim();
  if (!name) throw new HttpError(400, 'name is required');
  if (ctx.db.prepare('SELECT 1 FROM resources WHERE name = ?').get(name))
    throw new HttpError(409, `resource ${name} already exists; pick another name`);
  const config: McpConfig = normalizeMcp(b.config);
  const given = new Map((b.keys ?? []).map((k) => [k.name, k]));
  const names = new Set([...referencedKeys(config), ...given.keys()]);
  const keys = [...names].map((k) => ({ name: k, secret: given.get(k)?.secret !== false }));
  const withValues = (b.keys ?? []).filter((k) => typeof k.value === 'string' && k.value !== '');
  const dop = new Dopbase(ctx);
  if (withValues.length && !dop.configured) throw new HttpError(503, 'Dopbase is not configured, so the key values cannot be stored');
  const res = s.saveResource(ctx, { name, briefing: b.briefing ?? '', kind: 'mcp', config: { mcp: config }, keys, agents: b.agents });
  for (const k of withValues) await dop.setValue(name, k.name, k.value!);
  return withValues.length ? s.getResource(ctx, name) : res;
}

export function mcpRoutes(ctx: Ctx, r: Router): void {
  const hub = () => {
    if (!ctx.mcp) throw new HttpError(503, 'MCP is not running');
    return ctx.mcp;
  };

  r.on('POST', '/api/resources/mcp', async (req: Req) => createMcp(ctx, await req.body<NewMcp>()));
  /** Paste an mcpServers JSON (Claude Desktop, Claude Code, Cursor): one resource per server. */
  r.on('POST', '/api/resources/mcp/import', async (req: Req) => {
    const b = await req.body<{ json?: string; agents?: string[] }>();
    const drafts = parseImport(String(b.json ?? ''));
    const created: s.Resource[] = [];
    for (const d of drafts) {
      let name = d.name;
      for (let i = 2; ctx.db.prepare('SELECT 1 FROM resources WHERE name = ?').get(name); i++) name = `${d.name}-${i}`;
      created.push(await createMcp(ctx, { name, config: d.config, keys: d.keys, agents: b.agents }));
    }
    return created;
  });

  r.on('GET', '/api/resources/:name/mcp', (req: Req) => hub().status(req.params.name!));
  r.on('POST', '/api/resources/:name/mcp/reconnect', async (req: Req) => {
    await hub().close(req.params.name!);
    return hub().status(req.params.name!);
  });
  /** Which tools agents may use: a list of names, or null for all of them. */
  r.on('PUT', '/api/resources/:name/mcp/tools', async (req: Req) => {
    const { tools } = await req.body<{ tools?: string[] | null }>();
    const res = s.getResource(ctx, req.params.name!);
    if (res.kind !== 'mcp' || !res.config?.mcp) throw new HttpError(400, `${res.name} is not an MCP resource`);
    if (tools !== null && !Array.isArray(tools)) throw new HttpError(400, 'tools must be a list of tool names, or null for all');
    const mcp = { ...res.config.mcp, tools: tools ?? undefined };
    if (tools === null) delete mcp.tools;
    return s.saveResource(ctx, { name: res.name, config: { ...res.config, mcp } });
  });
  /** Try a tool from the resource page; the human may call any of them, turned off or not. */
  r.on('POST', '/api/resources/:name/mcp/tools/:tool', async (req: Req) => {
    const name = req.params.name!;
    const res = s.getResource(ctx, name);
    if (res.kind !== 'mcp' || !res.config?.mcp) throw new HttpError(400, `${name} is not an MCP resource`);
    const conn = await hub().connection(name);
    return conn.client.callTool({ name: req.params.tool!, arguments: await req.body<Record<string, unknown>>() }, undefined, {
      timeout: (res.config.mcp.timeout_s ?? 120) * 1000,
      resetTimeoutOnProgress: true,
    });
  });
  r.on('GET', '/api/resources/:name/mcp/read', (req: Req) => {
    const uri = req.query.get('uri');
    if (!uri) throw new HttpError(400, 'uri is required');
    return hub().read(req.params.name!, uri);
  });
  r.on('POST', '/api/resources/:name/mcp/sign-in', (req: Req) => hub().signIn(req.params.name!, origin(req.raw)));
  r.on('POST', '/api/resources/:name/mcp/sign-out', async (req: Req) => {
    await hub().signOut(req.params.name!);
    return hub().status(req.params.name!);
  });
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>` +
  `<body style="font:16px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222">` +
  `<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body>`;

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Where an MCP server's sign-in page sends the browser back. Open (no token): the state ties it to a sign-in Yaho started. */
export async function handleMcpOAuthCallback(ctx: Ctx, url: URL, res: ServerResponse): Promise<void> {
  const html = (status: number, title: string, body: string) =>
    void res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(page(title, body));
  const error = url.searchParams.get('error');
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  if (error) return html(400, 'Sign-in was not completed', esc(url.searchParams.get('error_description') ?? error));
  if (!ctx.mcp || !state || !code)
    return html(400, 'Sign-in was not completed', 'The sign-in page sent no code back. Start again from Yaho.');
  try {
    const name = await ctx.mcp.finishSignIn(state, code);
    html(200, `Signed in to ${esc(name)}`, 'Yaho can use this MCP server now. You can close this tab.');
  } catch (e) {
    html(400, 'Sign-in failed', esc((e as Error).message));
  }
}
