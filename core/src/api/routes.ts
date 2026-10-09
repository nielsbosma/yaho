import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { saveSettings, type Settings } from '../config.ts';
import type { Ctx } from '../context.ts';
import { litellmModels } from '../jobs/litellm.ts';
import { Dopbase } from '../secrets/dopbase.ts';
import * as s from '../store.ts';
import { HttpError } from '../store.ts';
import { Router, type Req } from './http.ts';
import { safeJoin, sendFile } from './server.ts';

const runner = (ctx: Ctx) => {
  if (!ctx.runner) throw new HttpError(503, 'job runner not started');
  return ctx.runner;
};

/** Accept either a parsed object or `{ yaml: "..." }` and return the object. */
async function definition<T>(req: Req): Promise<T> {
  const b = await req.body<Record<string, unknown>>();
  if (typeof b?.yaml === 'string') {
    const parsed = YAML.parse(b.yaml);
    if (!parsed || typeof parsed !== 'object') throw new HttpError(400, 'YAML must be a mapping');
    return parsed as T;
  }
  return b as T;
}

function listDir(root: string): Array<{ path: string; size: number; modified: string; dir: boolean }> {
  if (!existsSync(root)) return [];
  const out: Array<{ path: string; size: number; modified: string; dir: boolean }> = [];
  const walk = (d: string, depth: number) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      out.push({
        path: relative(root, full).replaceAll('\\', '/'),
        size: st.size,
        modified: st.mtime.toISOString(),
        dir: st.isDirectory(),
      });
      if (st.isDirectory() && depth < 4) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

const cleanFileName = (n: string) => {
  const name = basename(n.replaceAll('\\', '/')).trim();
  if (!name || name === '.' || name === '..') throw new HttpError(400, 'bad file name');
  return name;
};

export function humanRoutes(ctx: Ctx, r: Router): void {
  // ---- overview ----
  r.on('GET', '/api/state', () => ({
    unread: s.unreadCount(ctx),
    running: ctx.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'running'").get()!.n,
    queued: ctx.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'queued'").get()!.n,
    spent_usd: s.totalSpend(ctx),
    global_spend_cap_usd: ctx.settings.global_spend_cap_usd,
  }));

  // ---- settings ----
  r.on('GET', '/api/settings', () => ctx.settings);
  r.on('PUT', '/api/settings', async (req) => {
    const next = await definition<Settings>(req);
    Object.assign(ctx.settings, next);
    saveSettings(ctx.settings);
    ctx.bus.emitEvent({ type: 'changed', entity: 'settings' });
    runner(ctx).pump();
    return ctx.settings;
  });
  r.on('GET', '/api/settings/yaml', () => ({ yaml: YAML.stringify(ctx.settings) }));
  r.on('POST', '/api/settings/dopbase/test', async () => {
    const d = new Dopbase(ctx);
    const health = await d.health();
    if (!d.configured) return { ok: false, health, error: 'no token set' };
    await d.call('GET', '/projects');
    return { ok: true, health };
  });
  r.on('GET', '/api/settings/litellm/models', async () => ({ models: await litellmModels(ctx.settings) }));

  // ---- agents ----
  r.on('GET', '/api/agents', () => s.listAgents(ctx));
  r.on('POST', '/api/agents', async (req) => {
    const a = await definition<s.Agent>(req);
    if (s.agentExists(ctx, a.name)) throw new HttpError(409, `agent ${a.name} already exists`);
    return s.saveAgent(ctx, a);
  });
  r.on('GET', '/api/agents/:name', (req) => ({
    ...s.getAgent(ctx, req.params.name!),
    ...s.agentStats(ctx, req.params.name!),
    upcoming: ctx.scheduler?.upcoming(req.params.name!) ?? [],
  }));
  r.on('GET', '/api/agents/:name/yaml', (req) => ({ yaml: YAML.stringify(s.getAgent(ctx, req.params.name!)) }));
  r.on('PUT', '/api/agents/:name', async (req) => {
    const a = await definition<s.Agent>(req);
    s.getAgent(ctx, req.params.name!);
    return s.saveAgent(ctx, { ...a, name: a.name ?? req.params.name! }, { rename: req.params.name! });
  });
  r.on('PATCH', '/api/agents/:name', async (req) => {
    const patch = await req.body<Partial<s.Agent>>();
    return s.saveAgent(ctx, { ...patch, name: req.params.name! });
  });
  r.on('DELETE', '/api/agents/:name', (req) => s.deleteAgent(ctx, req.params.name!));
  r.on('POST', '/api/agents/:name/run', (req) => runner(ctx).enqueue(req.params.name!, 'manual', { force: true }));
  r.on('GET', '/api/agents/:name/briefings', (req) => s.briefingHistory(ctx, req.params.name!));
  r.on('POST', '/api/agents/:name/briefings/:id/revert', (req) => {
    const row = ctx.db
      .prepare('SELECT briefing FROM briefing_history WHERE id = ? AND agent = ?')
      .get(Number(req.params.id), req.params.name!) as { briefing: string } | undefined;
    if (!row) throw new HttpError(404, 'briefing version not found');
    return s.setBriefing(ctx, req.params.name!, row.briefing, 'human (revert)');
  });
  r.on('GET', '/api/agents/:name/workspace', (req) => listDir(ctx.paths.agent(req.params.name!)));
  r.on('GET', '/api/agents/:name/workspace/file', (req) =>
    sendFile(req.res, safeJoin(ctx.paths.agent(req.params.name!), req.query.get('path') ?? ''), req.query.get('download') ?? undefined),
  );

  // ---- jobs ----
  r.on('GET', '/api/jobs', (req) =>
    s.listJobs(ctx, {
      agent: req.query.get('agent') ?? undefined,
      active: req.query.get('active') === '1',
      limit: Number(req.query.get('limit') ?? 200),
    }),
  );
  r.on('GET', '/api/jobs/:id', (req) => s.getJob(ctx, req.params.id!));
  r.on('GET', '/api/jobs/:id/events', (req) => s.jobEvents(ctx, req.params.id!, Number(req.query.get('after') ?? 0)));
  r.on('POST', '/api/jobs/:id/stop', (req) => runner(ctx).stop(req.params.id!, 'stopped', 'stopped by the human'));
  r.on('POST', '/api/jobs/:id/continue', (req) => runner(ctx).continueJob(req.params.id!));

  // ---- messages ----
  r.on('GET', '/api/messages', (req) =>
    s.listMessages(ctx, {
      to: req.query.get('to') ?? undefined,
      involving: req.query.get('involving') ?? undefined,
      unread: req.query.get('unread') === '1',
    }),
  );
  r.on('GET', '/api/messages/:id', (req) => s.getMessage(ctx, req.params.id!));
  r.on('GET', '/api/messages/:id/thread', (req) => s.thread(ctx, req.params.id!));
  r.on('POST', '/api/messages', async (req) => {
    const m = await req.body<s.SendInput>();
    const msg = s.sendMessage(ctx, { ...m, from: 'human' });
    if (m.reply_to) s.markRead(ctx, m.reply_to, true);
    return msg;
  });
  r.on('POST', '/api/messages/:id/read', async (req) => {
    const b = await req.body<{ read?: boolean }>();
    s.markRead(ctx, req.params.id!, b.read ?? true);
  });

  // ---- projects ----
  r.on('GET', '/api/projects', () => s.listProjects(ctx));
  r.on('POST', '/api/projects', async (req) => {
    const p = await definition<s.Project & { agents?: string[] }>(req);
    if (ctx.db.prepare('SELECT 1 FROM projects WHERE name = ?').get(p.name)) throw new HttpError(409, `project ${p.name} already exists`);
    return s.saveProject(ctx, p);
  });
  r.on('GET', '/api/projects/:name', (req) => s.getProject(ctx, req.params.name!));
  r.on('PUT', '/api/projects/:name', async (req) => {
    const p = await definition<s.Project & { agents?: string[] }>(req);
    s.getProject(ctx, req.params.name!);
    return s.saveProject(ctx, { ...p, name: p.name ?? req.params.name! }, req.params.name!);
  });
  r.on('DELETE', '/api/projects/:name', (req) => s.deleteProject(ctx, req.params.name!));
  r.on('GET', '/api/projects/:name/files', (req) => listDir(join(ctx.paths.project(req.params.name!), 'files')));
  r.on('POST', '/api/projects/:name/files', async (req) => {
    s.getProject(ctx, req.params.name!);
    const name = cleanFileName(req.query.get('name') ?? '');
    const dir = join(ctx.paths.project(req.params.name!), 'files');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), await req.bytes());
    ctx.bus.emitEvent({ type: 'changed', entity: 'projects', name: req.params.name! });
    return { name };
  });
  r.on('GET', '/api/projects/:name/files/:file', (req) =>
    sendFile(
      req.res,
      safeJoin(join(ctx.paths.project(req.params.name!), 'files'), req.params.file!),
      req.query.get('download') ? req.params.file! : undefined,
    ),
  );
  r.on('DELETE', '/api/projects/:name/files/:file', (req) => {
    rmSync(safeJoin(join(ctx.paths.project(req.params.name!), 'files'), req.params.file!), { force: true });
    ctx.bus.emitEvent({ type: 'changed', entity: 'projects', name: req.params.name! });
  });

  // ---- artifacts ----
  r.on('GET', '/api/artifacts', (req) =>
    s.listArtifacts(ctx, {
      project: req.query.get('project') ?? undefined,
      agent: req.query.get('agent') ?? undefined,
      job: req.query.get('job') ?? undefined,
    }),
  );
  r.on('GET', '/api/artifacts/:id/file', (req) => {
    const a = ctx.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(req.params.id!) as
      | { project: string; file_path: string }
      | undefined;
    if (!a) throw new HttpError(404, 'artifact not found');
    const file = safeJoin(join(ctx.paths.project(a.project), 'artifacts'), a.file_path);
    sendFile(req.res, file, req.query.get('download') ? basename(a.file_path) : undefined);
  });
  r.on('GET', '/api/artifacts/:id/path', (req) => {
    const a = ctx.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(req.params.id!) as
      | { project: string; file_path: string }
      | undefined;
    if (!a) throw new HttpError(404, 'artifact not found');
    return { path: join(ctx.paths.project(a.project), 'artifacts', a.file_path) };
  });

  // ---- resources ----
  r.on('GET', '/api/resources', () => s.listResources(ctx));
  r.on('POST', '/api/resources', async (req) => {
    const x = await definition<s.Resource & { agents?: string[] }>(req);
    if (ctx.db.prepare('SELECT 1 FROM resources WHERE name = ?').get(x.name)) throw new HttpError(409, `resource ${x.name} already exists`);
    return s.saveResource(ctx, x);
  });
  r.on('GET', '/api/resources/:name', (req) => s.getResource(ctx, req.params.name!));
  r.on('PUT', '/api/resources/:name', async (req) => {
    const x = await definition<s.Resource & { agents?: string[] }>(req);
    s.getResource(ctx, req.params.name!);
    return s.saveResource(ctx, { ...x, name: x.name ?? req.params.name! }, req.params.name!);
  });
  r.on('DELETE', '/api/resources/:name', (req) => s.deleteResource(ctx, req.params.name!));
  r.on('PUT', '/api/resources/:name/keys/:key/value', async (req) => {
    const { value } = await req.body<{ value?: string }>();
    if (typeof value !== 'string') throw new HttpError(400, 'value is required');
    if (!s.getResource(ctx, req.params.name!).keys.some((k) => k.name === req.params.key)) throw new HttpError(404, 'unknown key');
    await new Dopbase(ctx).setValue(req.params.name!, req.params.key!, value);
    ctx.bus.emitEvent({ type: 'changed', entity: 'resources', name: req.params.name! });
  });
  r.on('DELETE', '/api/resources/:name/keys/:key/value', async (req) => {
    await new Dopbase(ctx).deleteValue(req.params.name!, req.params.key!);
    ctx.bus.emitEvent({ type: 'changed', entity: 'resources', name: req.params.name! });
  });
}

/** Copy a file into a project's artifacts folder, never overwriting an existing artifact. */
export function storeArtifactFile(ctx: Ctx, project: string, source: string): string {
  const dir = join(ctx.paths.project(project), 'artifacts');
  mkdirSync(dir, { recursive: true });
  const name = cleanFileName(source);
  let target = name;
  for (let i = 2; existsSync(join(dir, target)); i++) target = name.replace(/(\.[^.]*)?$/, `-${i}$1`);
  copyFileSync(source, join(dir, target));
  return target;
}

function examplesDir(): string {
  if (process.env.YAHO_EXAMPLES_DIR) return process.env.YAHO_EXAMPLES_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, '../../../examples'), join(here, '../examples'), join(here, 'examples')]) if (existsSync(c)) return c;
  return join(here, '../../../examples');
}

const readExample = (kind: string, name: string) => {
  const file = join(examplesDir(), kind, `${name}.yaml`);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  return { text, data: YAML.parse(text) as Record<string, unknown> };
};

/** The example agents under examples/: listed with their YAML, installed with the projects and resources they use. */
export function exampleRoutes(ctx: Ctx, r: Router): void {
  r.on('GET', '/api/examples', () => {
    const dir = join(examplesDir(), 'agents');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => {
        const ex = readExample('agents', f.slice(0, -5))!;
        return {
          name: ex.data.name,
          about: String(ex.text.split('\n')[0] ?? '').replace(/^#\s*/, ''),
          yaml: ex.text,
          installed: s.agentExists(ctx, String(ex.data.name)),
        };
      });
  });
  r.on('POST', '/api/examples/:name/install', (req) => {
    const ex = readExample('agents', req.params.name!);
    if (!ex) throw new HttpError(404, `no example ${req.params.name}`);
    const agent = ex.data as unknown as s.Agent;
    if (s.agentExists(ctx, agent.name)) throw new HttpError(409, `agent ${agent.name} already exists`);
    const created: string[] = [];
    for (const p of agent.projects ?? []) {
      if (ctx.db.prepare('SELECT 1 FROM projects WHERE name = ?').get(p)) continue;
      s.saveProject(ctx, (readExample('projects', p)?.data as unknown as s.Project) ?? { name: p, title: p, briefing: '' });
      created.push(`project ${p}`);
    }
    for (const res of agent.resources ?? []) {
      if (ctx.db.prepare('SELECT 1 FROM resources WHERE name = ?').get(res)) continue;
      s.saveResource(ctx, (readExample('resources', res)?.data as unknown as s.Resource) ?? { name: res, briefing: '', keys: [] });
      created.push(`resource ${res}`);
    }
    return { agent: s.saveAgent(ctx, agent), created };
  });
}
