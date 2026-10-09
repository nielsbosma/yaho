import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Ctx } from '../context.ts';
import { Dopbase } from '../secrets/dopbase.ts';
import * as s from '../store.ts';
import { HttpError } from '../store.ts';
import type { Req, Router } from './http.ts';
import { safeJoin, sendFile } from './server.ts';

/** The agent behind a job token. Every agent route is scoped to it. */
function me(req: Req): { agent: string; job: string } {
  if (req.caller.kind !== 'agent') throw new HttpError(403, 'this endpoint is for agents (use a job token)');
  return req.caller;
}

export function parseDuration(d: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(d.trim());
  if (!m) throw new HttpError(400, `bad duration "${d}" (use e.g. 90s, 30m, 2h, 1d)`);
  const n = Number(m[1]);
  return n * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[(m[2] ?? 's').toLowerCase() as 's']!;
}

export function agentRoutes(ctx: Ctx, r: Router): void {
  const on = (method: string, path: string, h: (req: Req, who: { agent: string; job: string }) => unknown) =>
    r.on(method, `/api/agent${path}`, (req) => h(req, me(req)), { agent: true });

  const assigned = (agent: string, project: string) => {
    if (!s.getAgent(ctx, agent).projects.includes(project)) throw new HttpError(403, `project ${project} is not assigned to you`);
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
    const job = s.getJob(ctx, w.job);
    const msg = s.sendMessage(ctx, { ...m, from: `agent:${w.agent}`, job: w.job, hop: m.to === 'human' ? 0 : job.hop + 1 });
    return { id: msg.id, to: msg.to, type: msg.type };
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
    const dir = join(ctx.paths.project(req.params.project!), 'files');
    return existsSync(dir) ? readdirSync(dir).map((f) => ({ name: f, size: statSync(join(dir, f)).size })) : [];
  });
  on('GET', '/projects/:project/files/:file', (req, w) => {
    assigned(w.agent, req.params.project!);
    sendFile(req.res, safeJoin(join(ctx.paths.project(req.params.project!), 'files'), req.params.file!));
  });
  on('POST', '/projects/:project/artifacts', async (req, w) => {
    const project = req.params.project!;
    assigned(w.agent, project);
    const kind = req.query.get('kind') || 'file';
    const name = basename((req.query.get('name') ?? '').replaceAll('\\', '/'));
    if (!name) throw new HttpError(400, 'name is required');
    const dir = join(ctx.paths.project(project), 'artifacts');
    mkdirSync(dir, { recursive: true });
    let target = name;
    for (let i = 2; existsSync(join(dir, target)); i++) target = name.replace(/(\.[^.]*)?$/, `-${i}$1`);
    writeFileSync(join(dir, target), await req.bytes());
    const a = s.addArtifact(ctx, { project, agent: w.agent, job: w.job, kind, file_path: target });
    return { id: a.id, project, file: target, kind };
  });

  // ---- briefing ----
  on('GET', '/briefing', (_req, w) => ({ briefing: s.getAgent(ctx, w.agent).briefing }));
  on('PUT', '/briefing', async (req, w) => {
    const raw = (await req.bytes()).toString('utf8');
    const briefing = req.raw.headers['content-type']?.includes('json')
      ? String((JSON.parse(raw) as { briefing?: string }).briefing ?? '')
      : raw;
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
  on('POST', '/sleep', async (req, w) => {
    const { duration } = await req.body<{ duration?: string }>();
    const until = ctx.runner!.sleep(w.job, parseDuration(String(duration ?? '')));
    return { sleeping_until: until, note: 'this process ends now; the same session resumes then' };
  });
  on('POST', '/finish', async (req, w) => {
    const { summary } = await req.body<{ summary?: string }>();
    ctx.runner!.stop(w.job, 'finished', undefined, summary ? { summary } : {});
    return { finished: true };
  });
}
