import type { Ctx } from '../context.ts';
import { Composio } from '../secrets/composio.ts';
import * as s from '../store.ts';
import { HttpError } from '../store.ts';
import type { Req, Router } from './http.ts';

/** How an agent uses a Composio resource; written into the resource's briefing when it is created. */
export function composioBriefing(resource: string, toolkitName: string, description: string): string {
  return [
    `${toolkitName} through Composio${description ? `: ${description}` : '.'}`,
    '',
    `Find tools with \`yaho tools ${resource} [--search <words>]\` (each has a slug, a description and its input schema), then run one with`,
    `\`yaho tool ${resource} <TOOL_SLUG> < args.yaml\` (the arguments as YAML). YAHO makes the call with the connected account; there are no keys to handle.`,
  ].join('\n');
}

export function composioRoutes(ctx: Ctx, r: Router): void {
  const c = () => new Composio(ctx);

  // ---- the explorer (human) ----
  r.on('GET', '/api/composio/status', () => ({ configured: c().configured, user_id: c().userId }));
  r.on('GET', '/api/composio/toolkits', (req: Req) =>
    c().toolkits({
      search: req.query.get('search') ?? undefined,
      category: req.query.get('category') ?? undefined,
      cursor: req.query.get('cursor') ?? undefined,
    }),
  );
  r.on('GET', '/api/composio/connections', async (req: Req) => {
    const conns = await c().connections({ toolkit: req.query.get('toolkit') ?? undefined });
    // Which YAHO resources already use each connection.
    const used = new Map<string, string[]>();
    for (const res of s.listResources(ctx)) {
      const id = res.config?.connected_account_id;
      if (res.kind === 'composio' && id) used.set(id, [...(used.get(id) ?? []), res.name]);
    }
    return conns.map((x) => ({ ...x, resources: used.get(x.id) ?? [] }));
  });
  r.on('GET', '/api/composio/connections/:id', (req: Req) => c().connection(req.params.id!));
  r.on('POST', '/api/composio/connect', async (req: Req) => {
    const { toolkit } = await req.body<{ toolkit?: string }>();
    if (!toolkit) throw new HttpError(400, 'toolkit is required');
    return c().connect(toolkit);
  });
  r.on('GET', '/api/composio/tools', (req: Req) => {
    const toolkit = req.query.get('toolkit');
    if (!toolkit) throw new HttpError(400, 'toolkit is required');
    return c().tools(toolkit, { search: req.query.get('search') ?? undefined });
  });

  /** Turn a connected account into a resource agents can be granted. */
  r.on('POST', '/api/resources/composio', async (req: Req) => {
    const b = await req.body<{ connected_account_id?: string; name?: string; agents?: string[] }>();
    if (!b.connected_account_id) throw new HttpError(400, 'connected_account_id is required');
    const conn = await c().connection(b.connected_account_id);
    if (conn.status !== 'ACTIVE') throw new HttpError(409, `that connection is ${conn.status.toLowerCase()}, not active yet`);
    const tk = await c()
      .toolkit(conn.toolkit)
      .catch(() => ({ slug: conn.toolkit, name: conn.toolkit, logo: '', description: '' }));
    const name = (b.name?.trim() || conn.toolkit)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-|-$/g, '');
    if (ctx.db.prepare('SELECT 1 FROM resources WHERE name = ?').get(name))
      throw new HttpError(409, `resource ${name} already exists; pick another name`);
    return s.saveResource(ctx, {
      name,
      briefing: composioBriefing(name, tk.name, tk.description),
      keys: [],
      kind: 'composio',
      config: { toolkit: conn.toolkit, toolkit_name: tk.name, logo: tk.logo, connected_account_id: conn.id },
      agents: b.agents,
    });
  });
}
