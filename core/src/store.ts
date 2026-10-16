import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { Cron } from 'croner';
import type { Ctx } from './context.ts';
import type { Guardrails } from './config.ts';
import { newId, now } from './db/index.ts';
import { normalizeMcp, referencedKeys, type McpConfig } from './mcp/config.ts';
import { validateRules } from './guard/commandRules.ts';

// ---------- shapes (what the API and YAML speak) ----------

export type TriggerSpec = { cron: string } | { inbox: boolean } |{ delay: string; next_fire: string } | WebhookTrigger;

/** How a webhook's deliveries are checked, besides the secret token in its URL. */
export const WEBHOOK_VERIFY = ['none', 'github', 'stripe', 'svix', 'yaho'] as const;
export type WebhookVerify = (typeof WEBHOOK_VERIFY)[number];

/** A delivery to the webhook's URL starts a job. The URL token and signing secret are not part of the definition. */
export interface WebhookTrigger {
  webhook: string;
  verify?: WebhookVerify;
  /** Added to the prompt of each job the webhook starts. */
  instructions?: string;
  /** Deliveries per hour; more are refused. Default 60. */
  limit?: number;
  paused?: boolean;
}

export const WEBHOOK_LIMIT = 60;

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
  /** An address of its own through Resend (<name>@<domain>) to send email from and get replies at. */
  email?: boolean;
  /** Text people from Yaho's Twilio number and get their replies. */
  sms?: boolean;
  /** A browser of its own in each job (yaho browser). */
  browser?: boolean;
  /** The nightly dream that tidies its memory, scripts and database. On unless false. */
  dreaming?: boolean;
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
  /**
   * keys: values in Dopbase, injected as env vars. composio: a Composio connected account, used through yaho tool.
   * mcp: an MCP server the core connects to (its keys fill in ${KEY} in its config), used as native tools or yaho tool.
   */
  kind?: 'keys' | 'composio' | 'mcp';
  config?: { toolkit?: string; toolkit_name?: string; logo?: string; connected_account_id?: string; mcp?: McpConfig };
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
  /** The sender waits for an answer: the inbox shows Done (or the choices). Default: true for questions and instructions. */
  expects_response: boolean;
  reply_to: string | null;
  read: boolean;
  /** false when the message was delivered with a job already started for it. */
  wake?: boolean;
  artifacts?: string[];
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
  summary: string | null;
  recap: string | null;
  /** The workspace's version when the job started, and the one it ended with (null when nothing changed). */
  base_sha: string | null;
  commit_sha: string | null;
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
  for (const w of ctx.db.prepare('SELECT * FROM webhooks WHERE agent = ? ORDER BY created, name').all(name) as Row[])
    triggers.push({
      webhook: w.name as string,
      ...(w.verify !== 'none' ? { verify: w.verify as WebhookVerify } : {}),
      ...(w.instructions ? { instructions: w.instructions as string } : {}),
      ...(w.hourly_limit !== WEBHOOK_LIMIT ? { limit: w.hourly_limit as number } : {}),
      ...(w.paused ? { paused: true } : {}),
    });
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
    ...(r.email ? { email: true } : {}),
    ...(r.sms ? { sms: true } : {}),
    ...(r.browser ? { browser: true } : {}),
    ...(r.dreaming ? {} : { dreaming: false }),
  };
}

export function listAgents(
  ctx: Ctx,
): Array<Agent & { folder: string | null; spent_usd: number; running: number; queued: number; unread: number }> {
  return (ctx.db.prepare('SELECT * FROM agents ORDER BY name').all() as Row[]).map((r) => {
    const a = agentFromRow(ctx, r);
    return { ...a, folder: (r.folder as string | null) ?? null, ...agentStats(ctx, a.name) };
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
export function saveAgent(
  ctx: Ctx,
  input: Partial<Agent> & { name: string },
  opts: { rename?: string; author?: string; job?: string } = {},
): Agent {
  assertName('agent', input.name);
  const d = ctx.settings.defaults;
  const { db } = ctx;
  const ts = now();
  const rename = opts.rename && opts.rename !== input.name ? opts.rename : undefined;
  if (rename) {
    if (agentExists(ctx, input.name)) throw new HttpError(409, `agent ${input.name} already exists`);
    if (!agentExists(ctx, rename)) throw new HttpError(404, `agent ${rename} not found`);
    // Its running jobs work in the folder that moves.
    if (db.prepare("SELECT 1 FROM jobs WHERE agent = ? AND status = 'running'").get(rename))
      throw new HttpError(409, `${rename} has a running job: stop it before renaming`);
  }
  const prev = db.prepare('SELECT * FROM agents WHERE name = ?').get(rename ?? input.name) as Row | undefined;
  const a: Agent = {
    name: input.name,
    enabled: input.enabled ?? (prev ? !!prev.enabled : true),
    briefing: input.briefing ?? (prev?.briefing as string) ?? '',
    harness: input.harness ?? (prev?.harness as string) ?? d.harness,
    models: input.models ?? json(prev?.models as string, d.models),
    budget_usd: input.budget_usd ?? (prev?.budget_usd as number) ?? d.budget_usd,
    max_parallel: Math.max(1, input.max_parallel ?? (prev?.max_parallel as number) ?? d.max_parallel),
    guardrails: input.guardrails ?? json(prev?.guardrails as string, d.guardrails),
    // A new agent starts when a message arrives for it, unless it says otherwise ({ inbox: false }).
    triggers: prev
      ? (input.triggers ?? agentFromRow(ctx, prev).triggers)
      : [...(input.triggers ?? []), ...((input.triggers ?? []).some((t) => 'inbox' in t) ? [] : [{ inbox: true as const }])],
    projects: input.projects ?? (prev ? agentFromRow(ctx, prev).projects : []),
    resources: input.resources ?? (prev ? agentFromRow(ctx, prev).resources : []),
    email: input.email ?? !!prev?.email,
    sms: input.sms ?? !!prev?.sms,
    browser: input.browser ?? !!prev?.browser,
    dreaming: input.dreaming ?? (prev ? !!prev.dreaming : true),
  };
  if (!ctx.settings.harnesses[a.harness]) throw new HttpError(400, `unknown harness ${a.harness}`);
  if (a.guardrails.command_rules !== undefined)
    try {
      a.guardrails = { ...a.guardrails, command_rules: validateRules(a.guardrails.command_rules) };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  for (const t of a.triggers) {
    if ('cron' in t) {
      try {
        new Cron(t.cron, { paused: true });
      } catch {
        throw new HttpError(400, `invalid cron expression "${t.cron}"`);
      }
    }
  }
  const hooks = a.triggers.filter((t): t is WebhookTrigger => 'webhook' in t);
  for (const w of hooks) {
    assertName('webhook', w.webhook);
    if (hooks.filter((x) => x.webhook === w.webhook).length > 1) throw new HttpError(400, `two webhooks are named ${w.webhook}`);
    if (w.verify && !WEBHOOK_VERIFY.includes(w.verify))
      throw new HttpError(400, `webhook verify must be one of ${WEBHOOK_VERIFY.join(', ')}`);
    if (w.limit !== undefined && !(Number.isInteger(w.limit) && w.limit >= 1 && w.limit <= 10_000))
      throw new HttpError(400, 'webhook limit must be a whole number from 1 to 10000');
  }
  db.exec('BEGIN');
  try {
    if (rename) {
      db.prepare('UPDATE agents SET name = ? WHERE name = ?').run(input.name, rename);
      for (const col of ['to_addr', 'from_addr'])
        db.prepare(`UPDATE messages SET ${col} = ? WHERE ${col} = ?`).run(`agent:${input.name}`, `agent:${rename}`);
      for (const table of ['job_tokens', 'artifacts', 'job_search'])
        db.prepare(`UPDATE ${table} SET agent = ? WHERE agent = ?`).run(input.name, rename);
    }
    db.prepare(
      `INSERT INTO agents (name, enabled, briefing, harness, models, budget_usd, max_parallel, guardrails, email, sms, browser, dreaming, created, updated)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled, briefing=excluded.briefing, harness=excluded.harness,
         models=excluded.models, budget_usd=excluded.budget_usd, max_parallel=excluded.max_parallel,
         guardrails=excluded.guardrails, email=excluded.email, sms=excluded.sms, browser=excluded.browser, dreaming=excluded.dreaming, updated=excluded.updated`,
    ).run(
      a.name,
      a.enabled ? 1 : 0,
      a.briefing,
      a.harness,
      JSON.stringify(a.models),
      a.budget_usd,
      a.max_parallel,
      JSON.stringify(a.guardrails),
      a.email ? 1 : 0,
      a.sms ? 1 : 0,
      a.browser ? 1 : 0,
      a.dreaming === false ? 0 : 1,
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
    syncWebhooks(ctx, a.name, hooks, ts);
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
  if (rename)
    for (const [from, to] of [
      [ctx.paths.agent(rename), ctx.paths.agent(a.name)],
      [join(ctx.paths.root, 'codex', rename), join(ctx.paths.root, 'codex', a.name)],
      [join(ctx.paths.root, 'versions', rename), join(ctx.paths.root, 'versions', a.name)],
    ])
      if (existsSync(from!)) renameSync(from!, to!);
  ensureAgentWorkspace(ctx, a.name);
  const what = !prev ? 'Created' : prev.briefing !== a.briefing ? 'Briefing changed' : 'Definition changed';
  void ctx.versions
    ?.snapshot(a.name, `${what} by ${opts.author ?? 'human'}`, { paths: ['agent.yaml'], author: opts.author ?? 'human', job: opts.job })
    .catch((e) => console.error(`[yaho] versioning ${a.name}: ${(e as Error).message}`));
  ctx.bus.emitEvent({ type: 'changed', entity: 'agents', name: a.name });
  return getAgent(ctx, a.name);
}

export function deleteAgent(ctx: Ctx, name: string): void {
  getAgent(ctx, name);
  // Its running jobs are forgotten before their rows go: nothing they still print is recorded.
  for (const j of ctx.db.prepare("SELECT id FROM jobs WHERE agent = ? AND status = 'running'").all(name) as Row[])
    ctx.runner?.detach(j.id as string);
  ctx.db.prepare('DELETE FROM agents WHERE name = ?').run(name);
  ctx.bus.emitEvent({ type: 'changed', entity: 'agents', name });
  ctx.runner?.pump();
}

/** Keep each webhook's token and secret across saves: rows are matched by name, new ones get their own. */
function syncWebhooks(ctx: Ctx, agent: string, hooks: WebhookTrigger[], ts: string): void {
  const { db } = ctx;
  const keep = hooks.map((w) => w.webhook);
  for (const r of db.prepare('SELECT name FROM webhooks WHERE agent = ?').all(agent) as Row[])
    if (!keep.includes(r.name as string)) db.prepare('DELETE FROM webhooks WHERE agent = ? AND name = ?').run(agent, r.name as string);
  for (const w of hooks) {
    const verify = w.verify ?? 'none';
    const prev = db.prepare('SELECT verify FROM webhooks WHERE agent = ? AND name = ?').get(agent, w.webhook) as Row | undefined;
    if (prev) {
      db.prepare('UPDATE webhooks SET verify = ?, instructions = ?, hourly_limit = ?, paused = ? WHERE agent = ? AND name = ?').run(
        verify,
        w.instructions ?? '',
        w.limit ?? WEBHOOK_LIMIT,
        w.paused ? 1 : 0,
        agent,
        w.webhook,
      );
      // Svix secrets have their own shape; a switch to or from it needs a fresh one.
      if ((prev.verify === 'svix') !== (verify === 'svix'))
        db.prepare('UPDATE webhooks SET secret = ? WHERE agent = ? AND name = ?').run(webhookSecret(verify), agent, w.webhook);
    } else {
      db.prepare(
        'INSERT INTO webhooks (id, agent, name, token, verify, secret, instructions, hourly_limit, paused, created) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).run(
        newId('whk'),
        agent,
        w.webhook,
        webhookToken(),
        verify,
        webhookSecret(verify),
        w.instructions ?? '',
        w.limit ?? WEBHOOK_LIMIT,
        w.paused ? 1 : 0,
        ts,
      );
    }
  }
}

export const webhookToken = () => randomBytes(24).toString('base64url');
export const webhookSecret = (verify: string) =>
  verify === 'svix' ? `whsec_${randomBytes(24).toString('base64')}` : randomBytes(32).toString('hex');

export function ensureAgentWorkspace(ctx: Ctx, name: string): string {
  const dir = ctx.paths.agent(name);
  for (const sub of ['scripts', 'memory', 'work']) mkdirSync(`${dir}/${sub}`, { recursive: true });
  return dir;
}

export function briefingHistory(ctx: Ctx, agent: string) {
  return ctx.db.prepare('SELECT id, briefing, author, created FROM briefing_history WHERE agent = ? ORDER BY id DESC').all(agent);
}

export function setBriefing(ctx: Ctx, agent: string, briefing: string, author: string, job?: string): Agent {
  return saveAgent(ctx, { name: agent, briefing }, { author, job });
}

export function nextCron(expr: string, after?: Date): string | null {
  return new Cron(expr, { paused: true }).nextRun(after)?.toISOString() ?? null;
}

/** The latest slot of a cron expression at or before `at`. */
export function lastCron(expr: string, at = new Date()): string | null {
  return new Cron(expr, { paused: true }).previousRuns(1, new Date(at.getTime() + 1))[0]?.toISOString() ?? null;
}

// ---------- agent folders ----------
// Folders only group agents in the sidebar; they are not part of an agent's definition.

export function listFolders(ctx: Ctx): string[] {
  return (ctx.db.prepare('SELECT name FROM agent_folders ORDER BY position, name').all() as Row[]).map((r) => r.name as string);
}

function folderName(name: unknown): string {
  const n = String(name ?? '').trim();
  if (!n || n.length > 60) throw new HttpError(400, 'a folder name is 1 to 60 characters');
  return n;
}

export function createFolder(ctx: Ctx, name: unknown): string[] {
  const n = folderName(name);
  if (ctx.db.prepare('SELECT 1 FROM agent_folders WHERE name = ?').get(n)) throw new HttpError(409, `folder ${n} already exists`);
  const pos = Number((ctx.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 p FROM agent_folders').get() as Row).p);
  ctx.db.prepare('INSERT INTO agent_folders (name, position, created) VALUES (?, ?, ?)').run(n, pos, now());
  return listFolders(ctx);
}

export function renameFolder(ctx: Ctx, from: string, to: unknown): string[] {
  const n = folderName(to);
  if (!ctx.db.prepare('SELECT 1 FROM agent_folders WHERE name = ?').get(from)) throw new HttpError(404, `folder ${from} not found`);
  if (n !== from && ctx.db.prepare('SELECT 1 FROM agent_folders WHERE name = ?').get(n))
    throw new HttpError(409, `folder ${n} already exists`);
  ctx.db.prepare('UPDATE agent_folders SET name = ? WHERE name = ?').run(n, from);
  ctx.db.prepare('UPDATE agents SET folder = ? WHERE folder = ?').run(n, from);
  return listFolders(ctx);
}

/** Deleting a folder moves its agents out to the top level, or deletes them too with `agents: true`. */
export function deleteFolder(ctx: Ctx, name: string, opts: { agents?: boolean } = {}): string[] {
  // Agents are deleted one by one; any that fail stay, moved to the top level with the rest, and are named in the error.
  const failed: string[] = [];
  if (opts.agents)
    for (const r of ctx.db.prepare('SELECT name FROM agents WHERE folder = ?').all(name) as Row[]) {
      try {
        deleteAgent(ctx, r.name as string);
      } catch (e) {
        failed.push(`${r.name as string} (${(e as Error).message})`);
      }
    }
  ctx.db.prepare('UPDATE agents SET folder = NULL WHERE folder = ?').run(name);
  ctx.db.prepare('DELETE FROM agent_folders WHERE name = ?').run(name);
  if (failed.length) throw new HttpError(500, `folder deleted, but these agents could not be and are now ungrouped: ${failed.join(', ')}`);
  return listFolders(ctx);
}

/** Put an agent in a folder, or take it out with null. */
export function moveAgentToFolder(ctx: Ctx, agent: string, folder: string | null): void {
  if (!agentExists(ctx, agent)) throw new HttpError(404, `agent ${agent} not found`);
  if (folder !== null && !ctx.db.prepare('SELECT 1 FROM agent_folders WHERE name = ?').get(folder))
    throw new HttpError(404, `folder ${folder} not found`);
  ctx.db.prepare('UPDATE agents SET folder = ? WHERE name = ?').run(folder, agent);
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
  const r = ctx.db.prepare('SELECT name, briefing, kind, config FROM resources WHERE name = ?').get(name) as Row | undefined;
  if (!r) throw new HttpError(404, `resource ${name} not found`);
  return {
    name,
    briefing: r.briefing as string,
    kind: (r.kind as Resource['kind']) ?? 'keys',
    config: json(r.config as string, {}),
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
  // Its Dopbase project holds Yaho's own keys (secrets/settingsSecrets.ts).
  if (input.name === 'settings') throw new HttpError(400, 'the name settings is reserved; choose another');
  const ts = now();
  if (rename && rename !== input.name) ctx.db.prepare('UPDATE resources SET name = ? WHERE name = ?').run(input.name, rename);
  const prev = ctx.db.prepare('SELECT * FROM resources WHERE name = ?').get(input.name) as Row | undefined;
  const kind = input.kind ?? (prev?.kind as Resource['kind']) ?? 'keys';
  if (kind !== 'keys' && kind !== 'composio' && kind !== 'mcp')
    throw new HttpError(400, `kind must be keys, composio or mcp (not ${kind})`);
  const config = input.config ?? json<NonNullable<Resource['config']>>(prev?.config as string, {});
  if (kind === 'mcp') {
    const before = json<NonNullable<Resource['config']>>(prev?.config as string, {}).mcp;
    config.mcp = normalizeMcp(config.mcp, before);
  }
  ctx.db
    .prepare(
      `INSERT INTO resources (name, briefing, kind, config, created, updated) VALUES (?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET briefing=excluded.briefing, kind=excluded.kind, config=excluded.config, updated=excluded.updated`,
    )
    .run(input.name, input.briefing ?? (prev?.briefing as string) ?? '', kind, JSON.stringify(config), ts, ts);
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
  // Every ${KEY} an MCP server's config names is a key of the resource, secret unless said otherwise.
  if (kind === 'mcp')
    for (const k of referencedKeys(config.mcp!))
      ctx.db.prepare('INSERT OR IGNORE INTO resource_keys (resource, name, secret) VALUES (?,?,1)').run(input.name, k);
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
    // Choices are text; an agent writing choices: [1, 2, 3] in YAML sends numbers.
    ...(Array.isArray(payload.choices) ? { choices: (payload.choices as unknown[]).map(String) } : {}),
    ...(payload.steps ? { steps: payload.steps as Message['steps'] } : {}),
    // Messages from before the field existed: questions and instructions waited for an answer.
    expects_response:
      typeof payload.expects_response === 'boolean' ? payload.expects_response : r.type === 'question' || r.type === 'instruction',
    ...(payload.no_wake ? { wake: false } : {}),
    ...(payload.artifacts ? { artifacts: payload.artifacts as string[] } : {}),
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
  const sql = `SELECT * FROM messages ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY read ASC, created DESC LIMIT ${limitOf(opts.limit, 500)}`;
  return (ctx.db.prepare(sql).all(...args) as Row[]).map(messageFromRow);
}

export interface MessageQuery {
  /** Words that must all appear in the title or body (case-insensitive). */
  text?: string;
  /** An agent name: messages it sent or received. */
  agent?: string;
  /** 'from_human', 'to_human' or 'between_agents'. */
  direction?: 'from_human' | 'to_human' | 'between_agents';
  type?: Message['type'];
  unread?: boolean;
  /** ISO dates or datetimes, inclusive. */
  since?: string;
  until?: string;
  limit?: number;
}

/** Search all messages, newest first, with the total that matched (the page may be shorter). */
export function searchMessages(ctx: Ctx, q: MessageQuery = {}): { total: number; messages: Message[] } {
  const where: string[] = [];
  const args: string[] = [];
  for (const word of (q.text ?? '').split(/\s+/).filter(Boolean)) {
    where.push("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')");
    const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    args.push(like, like);
  }
  if (q.agent) {
    where.push('(from_addr = ? OR to_addr = ?)');
    args.push(`agent:${q.agent}`, `agent:${q.agent}`);
  }
  if (q.direction === 'from_human') where.push("from_addr = 'human'");
  if (q.direction === 'to_human') where.push("to_addr = 'human'");
  if (q.direction === 'between_agents') where.push("from_addr LIKE 'agent:%' AND to_addr LIKE 'agent:%'");
  if (q.type) {
    where.push('type = ?');
    args.push(q.type);
  }
  if (q.unread) where.push('read = 0');
  if (q.since) {
    where.push('created >= ?');
    args.push(new Date(q.since).toISOString());
  }
  if (q.until) {
    // A bare date means the whole day.
    const end = /^\d{4}-\d{2}-\d{2}$/.test(q.until) ? new Date(new Date(q.until).getTime() + 86_400_000) : new Date(q.until);
    where.push('created < ?');
    args.push(end.toISOString());
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((ctx.db.prepare(`SELECT COUNT(*) n FROM messages ${filter}`).get(...args) as Row).n);
  const limit = Math.min(200, Math.max(1, q.limit ?? 30));
  const rows = ctx.db.prepare(`SELECT * FROM messages ${filter} ORDER BY created DESC LIMIT ${limit}`).all(...args) as Row[];
  return { total, messages: rows.map(messageFromRow) };
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
  /** Defaults to true for question and instruction, false otherwise. */
  expects_response?: boolean;
  reply_to?: string | null;
  job?: string | null;
  hop?: number;
  /** false: deliver without starting an inbox job (the caller starts the job itself). */
  wake?: boolean;
  /** Artifact ids to show with the message. */
  artifacts?: string[];
}

/** Store a message and fan it out: UI event, human notification, or an inbox trigger for the receiving agent. */
export function sendMessage(ctx: Ctx, m: SendInput): Message {
  const to = m.to.startsWith('agent:') || m.to.startsWith('email:') || m.to.startsWith('sms:') || m.to === 'human' ? m.to : `agent:${m.to}`;
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
      JSON.stringify({
        choices: m.choices?.map(String),
        steps: m.steps,
        expects_response: m.expects_response ?? (type === 'question' || type === 'instruction'),
        ...(m.wake === false ? { no_wake: true } : {}),
        ...(m.artifacts?.length ? { artifacts: m.artifacts } : {}),
      }),
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

/** Discard a message. Replies to it stay, unthreaded. */
export function deleteMessage(ctx: Ctx, id: string): void {
  const m = getMessage(ctx, id);
  ctx.db.prepare('UPDATE messages SET reply_to = NULL WHERE reply_to = ?').run(id);
  ctx.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  ctx.bus.emitEvent({ type: 'message', message: { ...m, deleted: true } });
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

/** A LIMIT from a query string: a positive whole number, or the default. */
const limitOf = (n: unknown, fallback: number): number => {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

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
      .prepare(
        `SELECT *, (SELECT COUNT(*) FROM messages m WHERE m.job = jobs.id) AS messages FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created DESC LIMIT ${limitOf(opts.limit, 200)}`,
      )
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
  let r;
  try {
    r = ctx.db.prepare('INSERT INTO job_events (job, kind, data, created) VALUES (?,?,?,?)').run(job, kind, JSON.stringify(data), created);
  } catch (e) {
    // The job is gone (its agent was deleted): there is nothing to record it on.
    if (/FOREIGN KEY/i.test((e as Error).message)) return;
    throw e;
  }
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

/** Delete artifacts and their files. Returns how many existed. */
export function deleteArtifacts(ctx: Ctx, ids: string[]): number {
  let n = 0;
  for (const id of ids) {
    const a = ctx.db.prepare('SELECT project, file_path FROM artifacts WHERE id = ?').get(id) as Row | undefined;
    if (!a) continue;
    const dir = join(ctx.paths.project(a.project as string), 'artifacts');
    const file = join(dir, a.file_path as string);
    // Only files inside the project's artifacts folder.
    if (file.startsWith(dir + sep)) rmSync(file, { force: true });
    ctx.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
    n++;
  }
  if (n) ctx.bus.emitEvent({ type: 'changed', entity: 'artifacts' });
  return n;
}
