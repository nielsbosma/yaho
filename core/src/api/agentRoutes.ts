import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Ctx } from '../context.ts';
import { Composio } from '../secrets/composio.ts';
import { Dopbase } from '../secrets/dopbase.ts';
import { searchHistory, showHistory } from '../history.ts';
import { fileIdea, type Idea } from '../ideas.ts';
import { nativeToolName } from '../mcp/config.ts';
import { checkCommand } from '../guard/commands.ts';
import * as s from '../store.ts';
import { HttpError } from '../store.ts';
import { isLink, resolveUnder, UnsafePathError, writeFileUnder } from '../fsSafe.ts';
import { UPLOAD_LIMIT, type Req, type Router } from './http.ts';
import { inFolder, sendFile } from './server.ts';

/** The agent behind a job token. Every agent route is scoped to it. */
function me(req: Req): { agent: string; job: string } {
  if (req.caller.kind !== 'agent') throw new HttpError(403, 'this endpoint is for agents (use a job token)');
  return req.caller;
}

/** What an artifact is, as the agent names it: a short word such as report or image. */
const KIND_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;

export function parseDuration(d: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(d.trim());
  if (!m) throw new HttpError(400, `bad duration "${d}" (use e.g. 90s, 30m, 2h, 1d)`);
  const ms = Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[(m[2] ?? 's').toLowerCase() as 's']!;
  if (!(ms <= 3650 * 864e5)) throw new HttpError(400, `duration "${d}" is too long`);
  return ms;
}

export function agentRoutes(ctx: Ctx, r: Router): void {
  const on = (method: string, path: string, h: (req: Req, who: { agent: string; job: string }) => unknown, maxBody?: number) =>
    r.on(method, `/api/agent${path}`, (req) => h(req, me(req)), { agent: true, maxBody });

  const assigned = (agent: string, project: string) => {
    if (!s.getAgent(ctx, agent).projects.includes(project)) throw new HttpError(403, `project ${project} is not assigned to you`);
  };
  /** A dream works in its own workspace only: no outreach and no briefing rewrites (it suggests them). */
  const notDreaming = (job: string, what: string) => {
    if (s.getJob(ctx, job).trigger_type === 'dream') throw new HttpError(403, `a dream cannot ${what}`);
  };
  const allowed = (agent: string, resource: string) => {
    if (!s.getAgent(ctx, agent).resources.includes(resource)) throw new HttpError(403, `resource ${resource} is not granted to you`);
  };

  // ---- inbox ----
  on('GET', '/inbox', (req, w) => s.listMessages(ctx, { to: `agent:${w.agent}`, unread: req.query.get('all') !== '1' }));
  on('GET', '/inbox/:id', (req, w) => {
    const m = s.getMessage(ctx, req.params.id!);
    const addr = `agent:${w.agent}`;
    if (m.to !== addr && m.from !== addr) throw new HttpError(403, 'not your message');
    return { message: m, thread: s.thread(ctx, m.id).filter((t) => t.to === addr || t.from === addr) };
  });
  on('POST', '/inbox/:id/read', async (req, w) => {
    const b = await req.body<{ read?: boolean }>();
    s.markRead(ctx, req.params.id!, b.read ?? true, `agent:${w.agent}`);
    return { id: req.params.id, read: b.read ?? true };
  });

  on('POST', '/send', async (req, w) => {
    const m = await req.body<s.SendInput>();
    if (!m.to) throw new HttpError(400, 'to is required: human or agent:<name>');
    if (String(m.to).startsWith('email:')) throw new HttpError(400, 'send email with yaho email send (or yaho email reply)');
    if (String(m.to).startsWith('sms:')) throw new HttpError(400, 'send texts with yaho sms send (or yaho sms reply)');
    const job = s.getJob(ctx, w.job);
    if (job.trigger_type === 'dream' && m.to !== 'human') throw new HttpError(403, 'a dream can only message the human');
    if (m.artifacts !== undefined) {
      if (!Array.isArray(m.artifacts)) throw new HttpError(400, 'artifacts must be a list of artifact ids');
      for (const id of m.artifacts) {
        const a = ctx.db.prepare('SELECT agent FROM artifacts WHERE id = ?').get(String(id)) as { agent: string } | undefined;
        if (!a) throw new HttpError(400, `no artifact ${id} (use the id that yaho artifact add printed)`);
        if (a.agent !== w.agent) throw new HttpError(403, `artifact ${id} is not yours`);
      }
    }
    const msg = s.sendMessage(ctx, { ...m, from: `agent:${w.agent}`, job: w.job, hop: m.to === 'human' ? 0 : job.hop + 1 });
    return { id: msg.id, to: msg.to, type: msg.type };
  });

  // ---- email through Resend ----
  on('POST', '/email', async (req, w) => {
    notDreaming(w.job, 'send email');
    if (!ctx.email) throw new HttpError(400, 'email is not set up in Yaho');
    return ctx.email.send(w.agent, w.job, await req.body());
  });

  // ---- SMS through Twilio ----
  on('POST', '/sms', async (req, w) => {
    notDreaming(w.job, 'send texts');
    if (!ctx.sms) throw new HttpError(400, 'SMS is not set up in Yaho');
    return ctx.sms.send(w.agent, w.job, await req.body());
  });

  // ---- history: the agent's own past jobs ----
  on('GET', '/history/search', (req, w) => {
    const since = req.query.get('since');
    return searchHistory(ctx, w.agent, req.query.get('q') ?? '', {
      since: since ? new Date(Date.now() - parseDuration(since)).toISOString() : undefined,
      limit: Number(req.query.get('limit')) || undefined,
    });
  });
  on('GET', '/history/:job', (req, w) => showHistory(ctx, w.agent, req.params.job!));
  // ---- the browser (yaho browser) ----
  on('POST', '/browser', async (req, w) => {
    notDreaming(w.job, 'browse');
    if (!ctx.browser) throw new HttpError(400, 'the browser is not available in Yaho');
    return ctx.browser.run(w.agent, w.job, await req.body());
  });

  // ---- query (read-only, scoped) ----
  on('GET', '/query/:what', (req, w) => {
    const agent = s.getAgent(ctx, w.agent);
    switch (req.params.what) {
      case 'agents':
        return s.listAgents(ctx).map((a) => ({ name: a.name, enabled: a.enabled, about: a.briefing.split('\n')[0]?.slice(0, 200) ?? '' }));
      case 'projects':
        return agent.projects.map((p) => {
          const x = s.getProject(ctx, p);
          return { name: x.name, title: x.title, briefing: x.briefing, agents: x.agents };
        });
      case 'resources':
        return agent.resources.map((n) => {
          const x = s.getResource(ctx, n);
          return { name: x.name, briefing: x.briefing, keys: x.keys.map((k) => ({ name: k.name, secret: k.secret })) };
        });
      case 'jobs':
        return s.listJobs(ctx, { agent: w.agent, limit: 30 }).map((j) => ({
          id: j.id,
          trigger: j.trigger_type,
          status: j.status,
          reason: j.reason,
          cost_usd: j.cost_usd,
          created: j.created,
          ended: j.ended,
        }));
      default:
        throw new HttpError(400, 'query one of: agents, projects, resources, jobs');
    }
  });

  // ---- projects and artifacts ----
  on('GET', '/projects/:project/files', (req, w) => {
    assigned(w.agent, req.params.project!);
    const root = ctx.paths.project(req.params.project!);
    const dir = join(root, 'files');
    try {
      resolveUnder(root, 'files');
    } catch {
      return [];
    }
    if (!existsSync(dir)) return [];
    // Symlinks are left out: their size would be read through the link.
    return readdirSync(dir).flatMap((f) => {
      const st = lstatSync(join(dir, f), { throwIfNoEntry: false });
      return st?.isFile() ? [{ name: f, size: st.size }] : [];
    });
  });
  on('GET', '/projects/:project/files/:file', (req, w) => {
    assigned(w.agent, req.params.project!);
    const root = ctx.paths.project(req.params.project!);
    sendFile(req.res, root, inFolder(root, 'files', req.params.file!));
  });
  on(
    'POST',
    '/projects/:project/artifacts',
    async (req, w) => {
      const project = req.params.project!;
      assigned(w.agent, project);
      const kind = req.query.get('kind') || 'file';
      if (!KIND_RE.test(kind)) throw new HttpError(400, 'kind must be a short word: letters, digits, - and _');
      const name = basename((req.query.get('name') ?? '').replaceAll('\\', '/'));
      if (!name || name === '.' || name === '..') throw new HttpError(400, 'name is required');
      const root = ctx.paths.project(project);
      const dir = join(root, 'artifacts');
      let target = name;
      for (let i = 2; existsSync(join(dir, target)) || isLink(join(dir, target)); i++) target = name.replace(/(\.[^.]*)?$/, `-${i}$1`);
      const bytes = await req.bytes();
      try {
        writeFileUnder(root, inFolder(root, 'artifacts', target), bytes);
      } catch (e) {
        if (e instanceof UnsafePathError) throw new HttpError(400, 'the artifacts folder is not a plain folder in the project');
        throw e;
      }
      const a = s.addArtifact(ctx, { project, agent: w.agent, job: w.job, kind, file_path: target });
      return { id: a.id, project, file: target, kind };
    },
    UPLOAD_LIMIT,
  );

  // ---- briefing ----
  on('GET', '/briefing', (_req, w) => ({ briefing: s.getAgent(ctx, w.agent).briefing }));
  on('PUT', '/briefing', async (req, w) => {
    const raw = (await req.bytes()).toString('utf8');
    let briefing = raw;
    if (req.raw.headers['content-type']?.includes('json')) {
      try {
        briefing = String((JSON.parse(raw) as { briefing?: string } | null)?.briefing ?? '');
      } catch {
        throw new HttpError(400, 'could not parse the briefing as JSON');
      }
    }
    notDreaming(w.job, 'rewrite the briefing: send the human a suggestion instead');
    if (!briefing.trim()) throw new HttpError(400, 'refusing to save an empty briefing');
    s.setBriefing(ctx, w.agent, briefing, `agent (${w.job})`);
    return { saved: true, versions: s.briefingHistory(ctx, w.agent).length };
  });

  // ---- resources: names always, values only for non-secret keys ----
  on('GET', '/resources/:resource/keys', async (req, w) => {
    const name = req.params.resource!;
    allowed(w.agent, name);
    const res = s.getResource(ctx, name);
    const dop = new Dopbase(ctx);
    let values: Record<string, string> = {};
    if (dop.configured && res.keys.some((k) => !k.secret)) values = await dop.runtimeValues(name).catch(() => ({}));
    return res.keys.map((k) => ({ name: k.name, secret: k.secret, ...(k.secret ? {} : { value: values[k.name] ?? null }), env: k.name }));
  });

  // ---- Composio and MCP resources: the core makes the call, so their keys never reach the agent ----
  const toolResource = (agent: string, name: string) => {
    allowed(agent, name);
    const res = s.getResource(ctx, name);
    if (res.kind === 'mcp' && res.config?.mcp) return res;
    if (res.kind !== 'composio' || !res.config?.connected_account_id || !res.config.toolkit)
      throw new HttpError(400, `${name} is not a Composio or MCP resource; its keys are in your environment`);
    return res;
  };
  const hub = () => {
    if (!ctx.mcp) throw new HttpError(503, 'MCP is not running');
    return ctx.mcp;
  };
  const mcpResource = (agent: string, name: string) => {
    const res = toolResource(agent, name);
    if (res.kind !== 'mcp') throw new HttpError(400, `${name} is not an MCP resource`);
    return res;
  };
  on('GET', '/resources/:resource/tools', async (req, w) => {
    const res = toolResource(w.agent, req.params.resource!);
    if (res.kind === 'mcp') {
      const words = (req.query.get('search') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      return (await hub().tools(res.name))
        .filter((t) => words.every((x) => `${t.name} ${t.description ?? ''}`.toLowerCase().includes(x)))
        .map((t) => ({ slug: t.name, name: t.title ?? t.name, description: t.description ?? '', input_parameters: t.inputSchema }));
    }
    return new Composio(ctx).tools(res.config!.toolkit!, { search: req.query.get('search') ?? undefined, limit: 50 });
  });
  on('POST', '/resources/:resource/tools/:tool', async (req, w) => {
    const res = toolResource(w.agent, req.params.resource!);
    if (res.kind !== 'mcp') {
      // Only the toolkit's own tools (GMAIL_SEND_EMAIL for gmail): the connected account is for that toolkit alone.
      const prefix = `${res.config!.toolkit!.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
      if (!req.params.tool!.toUpperCase().startsWith(prefix)) throw new HttpError(403, `${req.params.tool} is not a tool of ${res.name}`);
    }
    const args = await req.body<Record<string, unknown>>();
    if (res.kind === 'mcp') return hub().call(res.name, req.params.tool!, args);
    return new Composio(ctx).execute(req.params.tool!, res.config!.connected_account_id!, args);
  });
  on('GET', '/resources/:resource/mcp/resources', (req, w) => hub().resources(mcpResource(w.agent, req.params.resource!).name));
  on('GET', '/resources/:resource/mcp/read', (req, w) => {
    const uri = req.query.get('uri');
    if (!uri) throw new HttpError(400, 'uri is required');
    return hub().read(mcpResource(w.agent, req.params.resource!).name, uri);
  });
  on('GET', '/resources/:resource/mcp/prompts', (req, w) => hub().prompts(mcpResource(w.agent, req.params.resource!).name));
  on('POST', '/resources/:resource/mcp/prompts/:prompt', async (req, w) =>
    hub().prompt(mcpResource(w.agent, req.params.resource!).name, req.params.prompt!, await req.body<Record<string, string>>()),
  );

  /**
   * For `yaho mcp serve`, the MCP server Yaho gives the harness: the tools of every MCP resource the agent may use,
   * named <resource>__<tool>. A server that cannot be reached is reported, not fatal.
   */
  on('GET', '/mcp/tools', async (_req, w) => {
    const names = s.getAgent(ctx, w.agent).resources.filter((n) => s.getResource(ctx, n).kind === 'mcp');
    const tools: unknown[] = [];
    const errors: Array<{ resource: string; error: string }> = [];
    await Promise.all(
      names.map(async (name) => {
        try {
          for (const t of await hub().tools(name))
            tools.push({ ...t, name: nativeToolName(name, t.name), title: t.title ?? t.name, resource: name, tool: t.name });
        } catch (e) {
          errors.push({ resource: name, error: (e as Error).message });
        }
      }),
    );
    return { tools, errors };
  });
  on('POST', '/mcp/call', async (req, w) => {
    const b = await req.body<{ resource?: string; tool?: string; arguments?: Record<string, unknown> }>();
    if (!b.resource || !b.tool) throw new HttpError(400, 'resource and tool are required');
    return hub().call(mcpResource(w.agent, b.resource).name, b.tool, b.arguments ?? {});
  });

  // ---- budget and ending the job ----
  on('GET', '/budget', (_req, w) => {
    const a = s.getAgent(ctx, w.agent);
    const spent = s.agentSpend(ctx, w.agent);
    return {
      budget_usd: a.budget_usd,
      spent_usd: Number(spent.toFixed(6)),
      remaining_usd: Number(Math.max(0, a.budget_usd - spent).toFixed(6)),
      this_job_usd: s.getJob(ctx, w.job).cost_usd,
    };
  });
  /** Command Rules: the hook asks here before each shell command runs. */
  on('POST', '/guard/command', async (req, w) => {
    const { command } = await req.body<{ command?: string }>();
    return checkCommand(ctx, w, String(command ?? ''));
  });

  on('POST', '/sleep', async (req, w) => {
    const { duration } = await req.body<{ duration?: string }>();
    const until = ctx.runner!.sleep(w.job, parseDuration(String(duration ?? '')));
    return { sleeping_until: until, note: 'this process ends now; the same session resumes then' };
  });
  on('POST', '/idea', async (req, w) => fileIdea(ctx, w, await req.body<Idea>()));
  on('POST', '/finish', async (req, w) => {
    const { summary } = await req.body<{ summary?: string }>();
    ctx.runner!.stop(w.job, 'finished', undefined, summary ? { summary } : {});
    return { finished: true };
  });
}
