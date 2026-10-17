import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools } from '../assistant/index.ts';
import type { Ctx } from '../context.ts';
import * as s from '../store.ts';
import { HttpError } from '../store.ts';
import { parseBody, readBytes } from './http.ts';
import { accessValid, challenge } from './oauth.ts';
import { yahoVersion } from './routes.ts';
import { serverMode } from './session.ts';

/**
 * Yaho as an MCP server, at /mcp (Streamable HTTP), so another agent (Claude Code, Codex, Cursor) can do what Yaho's
 * chat can, with the chat's tools and its limits. On this computer it is open to programs on this computer; the server
 * version asks for a sign-in (oauth.ts), or the API token.
 */

const INSTRUCTIONS = `Yaho runs long-lived AI agents on a schedule. Each agent has a briefing, a workspace it keeps between runs and a budget; agents talk to the human through an inbox. These tools act as the human: list and change agents, run them, read jobs, search and answer the inbox, manage projects and resources.
- Never ask for or pass secret values (API keys, tokens, passwords): create the key names and leave the values to the human, in Yaho.
- Delete only after the human confirmed; then pass confirmed: true.
- Raising budgets, loosening guardrails and approving commands are left to the human, in Yaho.`;

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const hostName = (v: string | undefined) => {
  try {
    return new URL(`http://${v ?? ''}`).hostname;
  } catch {
    return '';
  }
};
const localName = (h: string) => h === 'localhost' || h === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(h);

/**
 * A program on this computer, not a web page: a loopback connection (not the agents' Unix socket) to a loopback name,
 * so a site cannot reach it by rebinding its own name to 127.0.0.1.
 */
function fromThisComputer(req: IncomingMessage): boolean {
  if (!LOOPBACK.test(req.socket.remoteAddress ?? '')) return false;
  return localName(hostName(req.headers.host));
}

/** Who may call: true to go on, false when a 401 or 403 was sent. */
function allowed(ctx: Ctx, req: IncomingMessage, res: ServerResponse): boolean {
  // A web page's request carries its Origin; only a page on this computer's own names may call.
  const origin = req.headers.origin;
  if (origin && origin !== 'null' && !localName(hostName(origin.replace(/^[a-z]+:\/\//, '')))) {
    res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'web pages may not call Yaho' }));
    return false;
  }
  const h = req.headers.authorization;
  const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (token) {
    if (eq(token, ctx.apiToken) || (serverMode() && accessValid(ctx, token))) return true;
    if (serverMode()) challenge(req, res, true);
    else res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'invalid token' }));
    return false;
  }
  if (!serverMode() && fromThisComputer(req)) return true;
  if (serverMode()) challenge(req, res, false);
  else res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'use the API token from another computer' }));
  return false;
}

/** The chat's tools, less the one that only moves the app's own window, plus a few the chat does not need. */
function toolSet(ctx: Ctx) {
  const t: Record<string, { description: string; parameters: Record<string, unknown>; run: (a: Record<string, unknown>) => unknown }> = {
    get_overview: {
      description: 'What Yaho is doing now: unread inbox messages, running and queued jobs, total spend and the spend cap.',
      parameters: { type: 'object', properties: {} },
      run: () => ({
        version: yahoVersion(),
        server: serverMode(),
        unread: s.unreadCount(ctx),
        running: (ctx.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'running'").get() as { n: number }).n,
        queued: (ctx.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'queued'").get() as { n: number }).n,
        spent_usd: s.totalSpend(ctx),
        global_spend_cap_usd: ctx.settings.global_spend_cap_usd,
      }),
    },
  };
  for (const [name, x] of Object.entries(tools(ctx))) {
    if (name === 'open_page') continue;
    t[name] = {
      description: x.description.replaceAll('in this chat', 'in this conversation'),
      parameters: x.parameters,
      run: (a) => x.run(a, {}),
    };
  }
  return t;
}

function mcpServer(ctx: Ctx): Server {
  const server = new Server({ name: 'yaho', version: yahoVersion() }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const t = toolSet(ctx);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: Object.entries(t).map(([name, x]) => ({ name, description: x.description, inputSchema: x.parameters as never })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = t[req.params.name];
    if (!tool) return { content: [{ type: 'text', text: `no tool ${req.params.name}` }], isError: true };
    try {
      const result = await tool.run((req.params.arguments ?? {}) as Record<string, unknown>);
      if (result && typeof result === 'object' && 'image' in result && typeof result.image === 'string') {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(result.image);
        const { image: _image, ...rest } = result as { image: string };
        if (m)
          return {
            content: [
              { type: 'text', text: JSON.stringify(rest) },
              { type: 'image', mimeType: m[1]!, data: m[2]! },
            ],
          };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  });
  return server;
}

/** /mcp: one server and transport per request (stateless), answered as JSON. */
export async function handleMcp(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!allowed(ctx, req, res)) return;
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'POST only' }));
    return;
  }
  let body: unknown;
  try {
    body = parseBody(await readBytes(req, 16 * 1024 * 1024), 'application/json');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: (e as Error).message }));
    return;
  }
  const server = mcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport as never);
  await transport.handleRequest(req, res, body);
}
