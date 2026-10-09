import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { saveSettings, type Settings } from '../config.ts';
import type { Ctx } from '../context.ts';
import { chat, type ChatMessage } from '../assistant/index.ts';
import { litellmModels } from '../jobs/litellm.ts';
import { Dopbase } from '../secrets/dopbase.ts';
import * as s from '../store.ts';
import { HttpError } from '../store.ts';
import { stats } from '../stats.ts';
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
    version: yahoVersion(),
    unread: s.unreadCount(ctx),
    running: ctx.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'running'").get()!.n,
    queued: ctx.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'queued'").get()!.n,
    spent_usd: s.totalSpend(ctx),
    global_spend_cap_usd: ctx.settings.global_spend_cap_usd,
  }));

  r.on('GET', '/api/stats', (req) => {
    const days = Math.min(365, Math.max(1, Number(req.query.get('days')) || 30));
    return stats(ctx.db, days);
  });

  // ---- settings ----
  r.on('GET', '/api/settings', () => ctx.settings);
  r.on('PUT', '/api/settings', async (req) => {
    const next = await definition<Settings>(req);
    Object.assign(ctx.settings, next);
    saveSettings(ctx.settings);
    if (ctx.settings.dopbase.mode === 'bundled' && ctx.localDopbase && !ctx.localDopbase.child) await ctx.localDopbase.start();
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

  // ---- assistant ----
  r.on('POST', '/api/assistant', async (req) => {
    const { messages } = await req.body<{ messages?: ChatMessage[] }>();
    if (!Array.isArray(messages) || !messages.length) throw new HttpError(400, 'messages is required');
    return chat(ctx, messages);
  });

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
  /** Run Now, optionally with instructions for this run: delivered to the agent's inbox, and the run starts at once. */
  r.on('POST', '/api/agents/:name/run', async (req) => {
    const name = req.params.name!;
    const message = (await req.body<{ message?: string }>()).message?.trim();
    if (!s.getAgent(ctx, name).enabled) throw new HttpError(409, `agent ${name} is disabled`);
    // The message first, so it is in the inbox the job's prompt lists; wake: false keeps it from starting a second job.
    if (message)
      s.sendMessage(ctx, {
        from: 'human',
        to: `agent:${name}`,
        type: 'info',
        title: 'Instructions for this run',
        body: message,
        wake: false,
      });
    return runner(ctx).enqueue(name, 'manual', { force: true, detail: message ? 'with instructions' : undefined });
  });
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
  r.on('DELETE', '/api/agents/:name/workspace/file', (req) => {
    const name = req.params.name!;
    const rel = req.query.get('path') ?? '';
    if (!rel) throw new HttpError(400, 'path is required');
    // The agent may have the file open, or be about to read it: only while it is idle.
    if (s.agentStats(ctx, name).running) throw new HttpError(409, `${name} is running; stop it or wait for the job to end`);
    const file = safeJoin(ctx.paths.agent(name), rel);
    if (!existsSync(file) || statSync(file).isDirectory()) throw new HttpError(404, 'file not found');
    rmSync(file, { force: true });
    for (const side of ['-wal', '-shm', '-journal']) if (/\.(db|sqlite3?)$/i.test(file)) rmSync(file + side, { force: true });
    ctx.bus.emitEvent({ type: 'changed', entity: 'workspace', name });
    return { deleted: rel };
  });
  /** A read-only look into a SQLite database in the workspace: its tables, or one table's rows. */
  r.on('GET', '/api/agents/:name/workspace/sqlite', (req) => {
    const file = safeJoin(ctx.paths.agent(req.params.name!), req.query.get('path') ?? '');
    if (!existsSync(file)) throw new HttpError(404, 'file not found');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const table = req.query.get('table');
      if (!table) {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as Array<{ name: string }>;
        return tables.map((t) => ({
          name: t.name,
          rows: Number((db.prepare(`SELECT COUNT(*) n FROM "${t.name.replaceAll('"', '""')}"`).get() as { n: number }).n),
          columns: (db.prepare(`PRAGMA table_info("${t.name.replaceAll('"', '""')}")`).all() as Array<{ name: string; type: string }>).map(
            (c) => ({ name: c.name, type: c.type }),
          ),
        }));
      }
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!exists) throw new HttpError(404, `no table ${table}`);
      const limit = Math.min(500, Number(req.query.get('limit') ?? 200));
      const offset = Math.max(0, Number(req.query.get('offset') ?? 0));
      const rows = db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" LIMIT ? OFFSET ?`).all(limit, offset);
      // Blobs do not survive JSON; describe them instead.
      return rows.map((r) =>
        Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? `<${v.length} bytes>` : v])),
      );
    } finally {
      db.close();
    }
  });

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
  /** What a message shows: the artifacts it attached, or else what its job made. */
  r.on('GET', '/api/messages/:id/artifacts', (req) => {
    const m = s.getMessage(ctx, req.params.id!);
    if (m.artifacts?.length) {
      const ids = m.artifacts;
      return s.listArtifacts(ctx).filter((a) => ids.includes(a.id as string));
    }
    return m.job ? s.listArtifacts(ctx, { job: m.job }) : [];
  });
  r.on('POST', '/api/messages', async (req) => {
    const m = await req.body<s.SendInput>();
    const msg = s.sendMessage(ctx, { ...m, from: 'human' });
    if (m.reply_to) s.markRead(ctx, m.reply_to, true);
    return msg;
  });
  r.on('DELETE', '/api/messages/:id', (req) => s.deleteMessage(ctx, req.params.id!));
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
  /** Delete many artifacts at once (the gallery's Delete All), by id. */
  r.on('POST', '/api/artifacts/delete', async (req) => {
    const { ids } = await req.body<{ ids?: string[] }>();
    if (!Array.isArray(ids)) throw new HttpError(400, 'ids is required');
    return { deleted: s.deleteArtifacts(ctx, ids) };
  });
  r.on('DELETE', '/api/artifacts/:id', (req) => {
    const a = ctx.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(req.params.id!) as
      | { project: string; file_path: string }
      | undefined;
    if (!a) throw new HttpError(404, 'artifact not found');
    // Another artifact can point at the same file only by copying it, so the file goes with its record.
    rmSync(safeJoin(join(ctx.paths.project(a.project), 'artifacts'), a.file_path), { force: true });
    ctx.db.prepare('DELETE FROM artifacts WHERE id = ?').run(req.params.id!);
    ctx.bus.emitEvent({ type: 'changed', entity: 'artifacts', name: req.params.id! });
    return { deleted: req.params.id };
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

/**
 * Example metadata lives in the YAML's leading comments, so the definition stays a plain agent:
 *   # One-line summary.
 *   # category: Marketing
 *   # tags: ads, experiments
 */
function exampleMeta(text: string): { summary: string; category: string; tags: string[] } {
  const head = text
    .split(/\r?\n/)
    .filter((l) => l.startsWith('#'))
    .map((l) => l.replace(/^#\s?/, ''));
  const field = (k: string) =>
    head
      .find((l) => l.toLowerCase().startsWith(`${k}:`))
      ?.slice(k.length + 1)
      .trim();
  return {
    summary: head.find((l) => !/^(category|tags):/i.test(l)) ?? '',
    category: field('category') ?? 'Other',
    tags: (field('tags') ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  };
}

/** The example agents under examples/: listed with their YAML, installed with the projects and resources they use. */
export function exampleRoutes(ctx: Ctx, r: Router): void {
  r.on('GET', '/api/examples', () => {
    const dir = join(examplesDir(), 'agents');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.yaml'))
      .map((f) => {
        const ex = readExample('agents', f.slice(0, -5))!;
        const meta = exampleMeta(ex.text);
        const agent = ex.data as unknown as s.Agent;
        const has = (table: string, n: string) => !!ctx.db.prepare(`SELECT 1 FROM ${table} WHERE name = ?`).get(n);
        return {
          name: agent.name,
          about: meta.summary,
          category: meta.category,
          tags: meta.tags,
          yaml: ex.text,
          briefing: agent.briefing ?? '',
          models: agent.models ?? [],
          budget_usd: agent.budget_usd,
          triggers: agent.triggers ?? [],
          projects: (agent.projects ?? []).map((p) => ({ name: p, exists: has('projects', p) })),
          resources: (agent.resources ?? []).map((r) => ({
            name: r,
            exists: has('resources', r),
            keys: ((readExample('resources', r)?.data as { keys?: Array<{ name: string; secret?: boolean }> } | undefined)?.keys ?? []).map(
              (k) => ({
                name: k.name,
                secret: k.secret !== false,
              }),
            ),
          })),
          installed: s.agentExists(ctx, agent.name),
        };
      })
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  });
  r.on('POST', '/api/examples/:name/install', async (req) => {
    const ex = readExample('agents', req.params.name!);
    if (!ex) throw new HttpError(404, `no example ${req.params.name}`);
    const agent = ex.data as unknown as s.Agent;
    // Install under another name to have the same example twice.
    const as = (await req.body<{ name?: string }>()).name?.trim();
    if (as) agent.name = as;
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

let version: string | undefined;
/** The app version: the repo's package.json in development, the staged one in a packaged app. */
export function yahoVersion(): string {
  if (version) return version;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '../../../package.json'), join(here, '../package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'yaho' && pkg.version) return (version = pkg.version);
    } catch {
      /* try the next */
    }
  }
  return (version = 'dev');
}
