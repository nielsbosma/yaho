import { mkdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { Cron } from 'croner';
import type { Ctx } from './context.ts';
import type { Guardrails } from './config.ts';
import { newId, now } from './db/index.ts';

// ---------- shapes (what the API and YAML speak) ----------

export type TriggerSpec = { cron: string } | { inbox: true } | { delay: string; next_fire: string };

export interface Agent {
  name: string;
  enabled: boolean;
  briefing: string;
  harness: string;
  models: string[];
  budget_usd: number;
  max_parallel: number;
  guardrails: Guardrails;
  triggers: TriggerSpec[];
  projects: string[];
  resources: string[];
}

export interface Project {
  name: string;
  title: string;
  briefing: string;
}

export interface ResourceKey {
  name: string;
  secret: boolean;
  has_value?: boolean;
}

export interface Resource {
  name: string;
  briefing: string;
  keys: ResourceKey[];
}

export interface Message {
  id: string;
  from: string;
  to: string;
  type: 'question' | 'instruction' | 'info' | 'reply';
  title: string;
  body: string;
  choices?: string[];
  steps?: Array<{ open: string } | { copy: string }>;
  reply_to: string | null;
  read: boolean;
  hop: number;
  job: string | null;
  created: string;
}

export interface Job {
  id: string;
  agent: string;
  session_id: string | null;
  trigger_type: string;
  trigger_detail: string | null;
  status: string;
  reason: string | null;
  model: string | null;
  cost_usd: number;
  resume_at: string | null;
  hop: number;
  pid: number | null;
  created: string;
  started: string | null;
  ended: string | null;
}

export const ACTIVE = ['queued', 'running'];
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

function assertName(kind: string, name: unknown): asserts name is string {
  if (typeof name !== 'string' || !NAME_RE.test(name))
    throw new HttpError(400, `${kind} name must be lowercase letters, digits and dashes`);
}

// ---------- agents ----------

type Row = Record<string, unknown>;

function agentFromRow(ctx: Ctx, r: Row): Agent {
  const name = r.name as string;
  const triggers: TriggerSpec[] = (
    ctx.db.prepare("SELECT * FROM triggers WHERE agent = ? AND type IN ('cron','inbox') ORDER BY created").all(name) as Row[]
  ).map((t) => (t.type === 'cron' ? { cron: t.cron as string } : { inbox: true as const }));
  return {
    name,
    enabled: !!r.enabled,
    briefing: r.briefing as string,
    harness: r.harness as string,
    models: json(r.models as string, []),
    budget_usd: r.budget_usd as number,
    max_parallel: r.max_parallel as number,
    guardrails: json(r.guardrails as string, {}),
    triggers,
    projects: (ctx.db.prepare('SELECT project FROM agent_projects WHERE agent = ? ORDER BY project').all(name) as Row[]).map(
      (x) => x.project as string,
    ),
    resources: (ctx.db.prepare('SELECT resource FROM agent_resources WHERE agent = ? ORDER BY resource').all(name) as Row[]).map(
      (x) => x.resource as string,
    ),
  };
}

export function listAgents(ctx: Ctx): Array<Agent & { spent_usd: number; running: number; queued: number; unread: number }> {
  return (ctx.db.prepare('SELECT * FROM agents ORDER BY name').all() as Row[]).map((r) => {
    const a = agentFromRow(ctx, r);
    return { ...a, ...agentStats(ctx, a.name) };
  });
}

export function agentStats(ctx: Ctx, name: string) {
  const s = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd),0) spent,
              SUM(status='running') running, SUM(status='queued') queued
       FROM jobs WHERE agent = ?`,
    )
    .get(name) as Row;
  const unread = ctx.db.prepare('SELECT COUNT(*) n FROM messages WHERE to_addr = ? AND read = 0').get(`agent:${name}`) as Row;
  return {
    spent_usd: Number(s.spent ?? 0),
    running: Number(s.running ?? 0),
    queued: Number(s.queued ?? 0),
    unread: Number(unread.n ?? 0),
  };
}

export function getAgent(ctx: Ctx, name: string): Agent {
  const r = ctx.db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as Row | undefined;
  if (!r) throw new HttpError(404, `agent ${name} not found`);
  return agentFromRow(ctx, r);
}

export function agentExists(ctx: Ctx, name: string): boolean {
  return !!ctx.db.prepare('SELECT 1 FROM agents WHERE name = ?').get(name);
}

/** Create or replace an agent from its YAML-shaped definition. `rename` moves an existing agent first. */
export function saveAgent(ctx: Ctx, input: Partial<Agent> & { name: string }, opts: { rename?: string; author?: string } = {}): Agent {
  assertName('agent', input.name);
  const d = ctx.settings.defaults;
  const { db } = ctx;
  const ts = now();
  if (opts.rename && opts.rename !== input.name) {
    if (agentExists(ctx, input.name)) throw new HttpError(409, `agent ${input.name} already exists`);
    db.prepare('UPDATE agents SET name = ? WHERE name = ?').run(input.name, opts.rename);
    db.prepare('UPDATE messages SET to_addr = ? WHERE to_addr = ?').run(`agent:${input.name}`, `agent:${opts.rename}`);
    db.prepare('UPDATE messages SET from_addr = ? WHERE from_addr = ?').run(`agent:${input.name}`, `agent:${opts.rename}`);
    const from = ctx.paths.agent(opts.rename);
    if (existsSync(from)) renameSync(from, ctx.paths.agent(input.name));
  }
  const prev = db.prepare('SELECT * FROM agents WHERE name = ?').get(input.name) as Row | undefined;
  const a: Agent = {
    name: input.name,
    enabled: input.enabled ?? (prev ? !!prev.enabled : true),
    briefing: input.briefing ?? (prev?.briefing as string) ?? '',
    harness: input.harness ?? (prev?.harness as string) ?? d.harness,
    models: input.models ?? json(prev?.models as string, d.models),
    budget_usd: input.budget_usd ?? (prev?.budget_usd as number) ?? d.budget_usd,
    max_parallel: Math.max(1, input.max_parallel ?? (prev?.max_parallel as number) ?? d.max_parallel),
    guardrails: input.guardrails ?? json(prev?.guardrails as string, d.guardrails),
    triggers: input.triggers ?? (prev ? agentFromRow(ctx, prev).triggers : []),
    projects: input.projects ?? (prev ? agentFromRow(ctx, prev).projects : []),
    resources: input.resources ?? (prev ? agentFromRow(ctx, prev).resources : []),
  };
  if (!ctx.settings.harnesses[a.harness]) throw new HttpError(400, `unknown harness ${a.harness}`);
  for (const t of a.triggers) {
    if ('cron' in t) {
      try {
        new Cron(t.cron, { paused: true });
      } catch {
        throw new HttpError(400, `invalid cron expression "${t.cron}"`);
      }
    }
  }
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO agents (name, enabled, briefing, harness, models, budget_usd, max_parallel, guardrails, created, updated)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled, briefing=excluded.briefing, harness=excluded.harness,
         models=excluded.models, budget_usd=excluded.budget_usd, max_parallel=excluded.max_parallel,
         guardrails=excluded.guardrails, updated=excluded.updated`,
    ).run(
      a.name,
      a.enabled ? 1 : 0,
      a.briefing,
      a.harness,
      JSON.stringify(a.models),
      a.budget_usd,
      a.max_parallel,
      JSON.stringify(a.guardrails),
      ts,
      ts,
    );
    if (!prev || prev.briefing !== a.briefing) {
      db.prepare('INSERT INTO briefing_history (agent, briefing, author, created) VALUES (?,?,?,?)').run(
        a.name,
        a.briefing,
        opts.author ?? 'human',
        ts,
      );
    }
    db.prepare("DELETE FROM triggers WHERE agent = ? AND type IN ('cron','inbox')").run(a.name);
    for (const t of a.triggers) {
      if ('cron' in t) {
        db.prepare("INSERT INTO triggers (id, agent, type, cron, next_fire, created) VALUES (?,?,'cron',?,?,?)").run(
          newId('trg'),
          a.name,
          t.cron,
          nextCron(t.cron),
          ts,
        );
      } else if ('inbox' in t && t.inbox) {
        db.prepare("INSERT INTO triggers (id, agent, type, created) VALUES (?,?,'inbox',?)").run(newId('trg'), a.name, ts);
      }
    }
    db.prepare('DELETE FROM agent_projects WHERE agent = ?').run(a.name);
    for (const p of a.projects) {
      if (!db.prepare('SELECT 1 FROM projects WHERE name = ?').get(p)) throw new HttpError(400, `unknown project ${p}`);
      db.prepare('INSERT INTO agent_projects (agent, project) VALUES (?,?)').run(a.name, p);
    }
    db.prepare('DELETE FROM agent_resources WHERE agent = ?').run(a.name);
    for (const r of a.resources) {
      if (!db.prepare('SELECT 1 FROM resources WHERE name = ?').get(r)) throw new HttpError(400, `unknown resource ${r}`);
      db.prepare('INSERT INTO agent_resources (agent, resource) VALUES (?,?)').run(a.name, r);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  ensureAgentWorkspace(ctx, a.name);
  ctx.bus.emitEvent({ type: 'changed', entity: 'agents', name: a.name });
  return getAgent(ctx, a.name);
}

export function deleteAgent(ctx: Ctx, name: string): void {
  getAgent(ctx, name);
  for (const j of ctx.db.prepare("SELECT id FROM jobs WHERE agent = ? AND status IN ('running','queued')").all(name) as Row[])
    ctx.runner?.stop(j.id as string, 'stopped', 'agent deleted');
  ctx.db.prepare('DELETE FROM agents WHERE name = ?').run(name);
  ctx.bus.emitEvent({ type: 'changed', entity: 'agents', name });
}

export function ensureAgentWorkspace(ctx: Ctx, name: string): string {
  const dir = ctx.paths.agent(name);
  for (const sub of ['scripts', 'memory', 'work']) mkdirSync(`${dir}/${sub}`, { recursive: true });
  return dir;
}

export function briefingHistory(ctx: Ctx, agent: string) {
  return ctx.db.prepare('SELECT id, briefing, author, created FROM briefing_history WHERE agent = ? ORDER BY id DESC').all(agent);
}

export function setBriefing(ctx: Ctx, agent: string, briefing: string, author: string): Agent {
  return saveAgent(ctx, { name: agent, briefing }, { author });
}

export function nextCron(expr: string, after?: Date): string | null {
  return new Cron(expr, { paused: true }).nextRun(after)?.toISOString() ?? null;
}

// ---------- projects ----------

export function listProjects(ctx: Ctx) {
  return (ctx.db.prepare('SELECT name, title, briefing FROM projects ORDER BY title').all() as Row[]).map((p) => ({
    ...(p as unknown as Project),
    agents: (ctx.db.prepare('SELECT agent FROM agent_projects WHERE project = ?').all(p.name as string) as Row[]).map(
      (x) => x.agent as string,
    ),
  }));
}

export function getProject(ctx: Ctx, name: string) {
  const p = listProjects(ctx).find((x) => x.name === name);
  if (!p) throw new HttpError(404, `project ${name} not found`);
  return p;
}

export function saveProject(ctx: Ctx, input: Partial<Project> & { name: string; agents?: string[] }, rename?: string) {
  assertName('project', input.name);
  const ts = now();
  if (rename && rename !== input.name) {
    ctx.db.prepare('UPDATE projects SET name = ? WHERE name = ?').run(input.name, rename);
    const from = ctx.paths.project(rename);
    if (existsSync(from)) renameSync(from, ctx.paths.project(input.name));
  }
  const prev = ctx.db.prepare('SELECT * FROM projects WHERE name = ?').get(input.name) as Row | undefined;
  ctx.db
    .prepare(
      `INSERT INTO projects (name, title, briefing, created, updated) VALUES (?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET title=excluded.title, briefing=excluded.briefing, updated=excluded.updated`,
    )
    .run(input.name, input.title ?? (prev?.title as string) ?? input.name, input.briefing ?? (prev?.briefing as string) ?? '', ts, ts);
  if (input.agents) {
    ctx.db.prepare('DELETE FROM agent_projects WHERE project = ?').run(input.name);
    for (const a of input.agents) ctx.db.prepare('INSERT OR IGNORE INTO agent_projects (agent, project) VALUES (?,?)').run(a, input.name);
  }
  for (const sub of ['files', 'artifacts']) mkdirSync(`${ctx.paths.project(input.name)}/${sub}`, { recursive: true });
  ctx.bus.emitEvent({ type: 'changed', entity: 'projects', name: input.name });
  return getProject(ctx, input.name);
}

export function deleteProject(ctx: Ctx, name: string) {
  getProject(ctx, name);
  ctx.db.prepare('DELETE FROM projects WHERE name = ?').run(name);
  rmSync(ctx.paths.project(name), { recursive: true, force: true });
  ctx.bus.emitEvent({ type: 'changed', entity: 'projects', name });
}

// ---------- resources ----------

export function listResources(ctx: Ctx) {
  return (ctx.db.prepare('SELECT name, briefing FROM resources ORDER BY name').all() as Row[]).map((r) =>
    getResource(ctx, r.name as string),
  );
}

export function getResource(ctx: Ctx, name: string): Resource & { agents: string[] } {
  const r = ctx.db.prepare('SELECT name, briefing FROM resources WHERE name = ?').get(name) as Row | undefined;
  if (!r) throw new HttpError(404, `resource ${name} not found`);
  return {
    name,
    briefing: r.briefing as string,
    keys: (ctx.db.prepare('SELECT name, secret, has_value FROM resource_keys WHERE resource = ? ORDER BY name').all(name) as Row[]).map(
      (k) => ({
        name: k.name as string,
        secret: !!k.secret,
        has_value: !!k.has_value,
      }),
    ),
    agents: (ctx.db.prepare('SELECT agent FROM agent_resources WHERE resource = ?').all(name) as Row[]).map((x) => x.agent as string),
  };
}

/** Saves names and flags only. Values go to Dopbase through the secrets module. */
export function saveResource(ctx: Ctx, input: Partial<Resource> & { name: string; agents?: string[] }, rename?: string) {
  assertName('resource', input.name);
  const ts = now();
  if (rename && rename !== input.name) ctx.db.prepare('UPDATE resources SET name = ? WHERE name = ?').run(input.name, rename);
  const prev = ctx.db.prepare('SELECT * FROM resources WHERE name = ?').get(input.name) as Row | undefined;
  ctx.db
    .prepare(
      `INSERT INTO resources (name, briefing, created, updated) VALUES (?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET briefing=excluded.briefing, updated=excluded.updated`,
    )
    .run(input.name, input.briefing ?? (prev?.briefing as string) ?? '', ts, ts);
  if (input.keys) {
    const keep = new Set(input.keys.map((k) => k.name));
    for (const k of input.keys) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k.name)) throw new HttpError(400, `key ${k.name} is not a valid environment variable name`);
      ctx.db
        .prepare(
          `INSERT INTO resource_keys (resource, name, secret) VALUES (?,?,?)
           ON CONFLICT(resource, name) DO UPDATE SET secret = excluded.secret`,
        )
        .run(input.name, k.name, k.secret === false ? 0 : 1);
    }
    for (const k of ctx.db.prepare('SELECT name FROM resource_keys WHERE resource = ?').all(input.name) as Row[])
      if (!keep.has(k.name as string))
        ctx.db.prepare('DELETE FROM resource_keys WHERE resource = ? AND name = ?').run(input.name, k.name as string);
  }
  if (input.agents) {
    ctx.db.prepare('DELETE FROM agent_resources WHERE resource = ?').run(input.name);
    for (const a of input.agents) ctx.db.prepare('INSERT OR IGNORE INTO agent_resources (agent, resource) VALUES (?,?)').run(a, input.name);
  }
  ctx.bus.emitEvent({ type: 'changed', entity: 'resources', name: input.name });
  return getResource(ctx, input.name);
}

export function deleteResource(ctx: Ctx, name: string) {
  getResource(ctx, name);
  ctx.db.prepare('DELETE FROM resources WHERE name = ?').run(name);
  ctx.bus.emitEvent({ type: 'changed', entity: 'resources', name });
}

// ---------- messages ----------

function messageFromRow(r: Row): Message {
  const payload = json<Record<string, unknown>>(r.payload as string, {});
  return {
    id: r.id as string,
    from: r.from_addr as string,
    to: r.to_addr as string,
    type: r.type as Message['type'],
    title: r.title as string,
    body: r.body as string,
    ...(payload.choices ? { choices: payload.choices as string[] } : {}),
    ...(payload.steps ? { steps: payload.steps as Message['steps'] } : {}),
    reply_to: (r.reply_to as string) ?? null,
    read: !!r.read,
    hop: r.hop as number,
    job: (r.job as string) ?? null,
    created: r.created as string,
  };
}

export function getMessage(ctx: Ctx, id: string): Message {
  const r = ctx.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new HttpError(404, `message ${id} not found`);
  return messageFromRow(r);
}

export function listMessages(ctx: Ctx, opts: { to?: string; involving?: string; unread?: boolean; limit?: number } = {}): Message[] {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.to) {
    where.push('to_addr = ?');
    args.push(opts.to);
  }
  if (opts.involving) {
    where.push('(to_addr = ? OR from_addr = ?)');
    args.push(opts.involving, opts.involving);
  }
  if (opts.unread) where.push('read = 0');
  const sql = `SELECT * FROM messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY read ASC, created DESC LIMIT ${opts.limit ?? 500}`;
  return (ctx.db.prepare(sql).all(...args) as Row[]).map(messageFromRow);
}

export function thread(ctx: Ctx, id: string): Message[] {
  let root = getMessage(ctx, id);
  while (root.reply_to) root = getMessage(ctx, root.reply_to);
  const out: Message[] = [];
  const walk = (m: Message) => {
    out.push(m);
    for (const r of ctx.db.prepare('SELECT * FROM messages WHERE reply_to = ? ORDER BY created').all(m.id) as Row[])
      walk(messageFromRow(r));
  };
  walk(root);
  return out;
}

export interface SendInput {
  from: string;
  to: string;
  type?: Message['type'];
  title?: string;
  body?: string;
  choices?: string[];
  steps?: Message['steps'];
  reply_to?: string | null;
  job?: string | null;
  hop?: number;
}

/** Store a message and fan it out: UI event, human notification, or an inbox trigger for the receiving agent. */
export function sendMessage(ctx: Ctx, m: SendInput): Message {
  const to = m.to.startsWith('agent:') || m.to === 'human' ? m.to : `agent:${m.to}`;
  if (to.startsWith('agent:') && !agentExists(ctx, to.slice(6))) throw new HttpError(400, `no agent named ${to.slice(6)}`);
  const type = m.type ?? (m.reply_to ? 'reply' : 'info');
  if (!['question', 'instruction', 'info', 'reply'].includes(type)) throw new HttpError(400, `unknown message type ${type}`);
  let hop = m.hop ?? 0;
  if (m.reply_to) {
    const parent = getMessage(ctx, m.reply_to);
    if (m.from.startsWith('agent:')) hop = Math.max(hop, parent.hop + 1);
  }
  const id = newId('msg');
  ctx.db
    .prepare(
      `INSERT INTO messages (id, from_addr, to_addr, type, title, body, payload, reply_to, hop, job, created)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      m.from,
      to,
      type,
      m.title ?? '',
      m.body ?? '',
      JSON.stringify({ choices: m.choices, steps: m.steps }),
      m.reply_to ?? null,
      hop,
      m.job ?? null,
      now(),
    );
  const msg = getMessage(ctx, id);
  ctx.bus.emitEvent({ type: 'message', message: msg });
  if (to === 'human') {
    const who = m.from.replace(/^agent:/, '');
    ctx.bus.emitEvent({ type: 'notify', title: `${who}: ${msg.title || msg.type}`, body: msg.body.slice(0, 200), message: msg.id });
  }
  return msg;
}

export function markRead(ctx: Ctx, id: string, read = true, owner?: string) {
  const m = getMessage(ctx, id);
  if (owner && m.to !== owner) throw new HttpError(403, 'not your message');
  ctx.db.prepare('UPDATE messages SET read = ? WHERE id = ?').run(read ? 1 : 0, id);
  ctx.bus.emitEvent({ type: 'message', message: { ...m, read } });
}

export function unreadCount(ctx: Ctx, to = 'human'): number {
  return Number((ctx.db.prepare('SELECT COUNT(*) n FROM messages WHERE to_addr = ? AND read = 0').get(to) as Row).n);
}

// ---------- jobs ----------

export function getJob(ctx: Ctx, id: string): Job {
  const r = ctx.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as Job | undefined;
  if (!r) throw new HttpError(404, `job ${id} not found`);
  return { ...r };
}

export function listJobs(ctx: Ctx, opts: { agent?: string; active?: boolean; limit?: number } = {}): Job[] {
  const where: string[] = [];
  const args: string[] = [];
  if (opts.agent) {
    where.push('agent = ?');
    args.push(opts.agent);
  }
  if (opts.active) where.push("status IN ('running','queued')");
  return (
    ctx.db
      .prepare(`SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created DESC LIMIT ${opts.limit ?? 200}`)
      .all(...args) as unknown as Job[]
  ).map((j) => ({ ...j }));
}

export function updateJob(ctx: Ctx, id: string, fields: Partial<Job>): Job {
  const keys = Object.keys(fields);
  if (keys.length) {
    ctx.db
      .prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...(Object.values(fields) as (string | number | null)[]), id);
  }
  const job = getJob(ctx, id);
  ctx.bus.emitEvent({ type: 'job', job });
  return job;
}

export function addJobEvent(ctx: Ctx, job: string, kind: string, data: unknown) {
  const created = now();
  const r = ctx.db
    .prepare('INSERT INTO job_events (job, kind, data, created) VALUES (?,?,?,?)')
    .run(job, kind, JSON.stringify(data), created);
  ctx.bus.emitEvent({ type: 'job_event', job, event: { id: Number(r.lastInsertRowid), kind, data, created } });
}

export function jobEvents(ctx: Ctx, job: string, after = 0) {
  return (
    ctx.db.prepare('SELECT id, kind, data, created FROM job_events WHERE job = ? AND id > ? ORDER BY id').all(job, after) as Row[]
  ).map((e) => ({
    ...e,
    data: json(e.data as string, null),
  }));
}

export function totalSpend(ctx: Ctx): number {
  return Number((ctx.db.prepare('SELECT COALESCE(SUM(cost_usd),0) s FROM jobs').get() as Row).s);
}

export function agentSpend(ctx: Ctx, agent: string): number {
  return Number((ctx.db.prepare('SELECT COALESCE(SUM(cost_usd),0) s FROM jobs WHERE agent = ?').get(agent) as Row).s);
}

// ---------- artifacts ----------

export function listArtifacts(ctx: Ctx, f: { project?: string; agent?: string; job?: string } = {}) {
  const where: string[] = [];
  const args: string[] = [];
  for (const [k, v] of Object.entries(f)) {
    if (v) {
      where.push(`${k} = ?`);
      args.push(v);
    }
  }
  return ctx.db
    .prepare(`SELECT * FROM artifacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created DESC`)
    .all(...args) as Row[];
}

export function addArtifact(ctx: Ctx, a: { project: string; agent: string; job: string | null; kind: string; file_path: string }) {
  const id = newId('art');
  ctx.db
    .prepare('INSERT INTO artifacts (id, project, agent, job, kind, file_path, created) VALUES (?,?,?,?,?,?,?)')
    .run(id, a.project, a.agent, a.job, a.kind, a.file_path, now());
  ctx.bus.emitEvent({ type: 'changed', entity: 'artifacts', name: id });
  return ctx.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row;
}
