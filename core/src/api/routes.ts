import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { saveSettings, type Settings } from '../config.ts';
import { checkClaude, checkCodex, lastClaudeCheck, lastCodexCheck } from '../checks.ts';
import { PROVIDERS, defaultProvider, litellmProvider } from '../providers.ts';
import { allModels, listModels } from '../providerApi.ts';
import { revealToken, serverMode } from './session.ts';
import { sandboxOn, sandboxProblem } from '../harness/sandbox.ts';
import { applySettingsUpdate, publicSettings, storeSecrets } from '../secrets/settingsSecrets.ts';
import type { Ctx } from '../context.ts';
import { chat, type ChatFocus, type ChatMessage } from '../assistant/index.ts';
import { litellmModels } from '../jobs/litellm.ts';
import { Dopbase } from '../secrets/dopbase.ts';
import * as s from '../store.ts';
import { HttpError } from '../store.ts';
import { schedule } from '../schedule.ts';
import { slackCreateUrl, slackManifest } from '../slack/manifest.ts';
import { WEBHOOK_PATH as TWILIO_WEBHOOK } from '../sms/twilio.ts';
import { stats } from '../stats.ts';
import { listWebhooks, rotateUrl, setSecret } from '../webhooks/hooks.ts';
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
    onboarded: !!ctx.settings.onboarded_at,
    /** The server version (Docker): signs in with a password, has no desktop features. */
    server: serverMode(),
    unread: s.unreadCount(ctx),
    running: ctx.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'running'").get()!.n,
    queued: ctx.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'queued'").get()!.n,
    spent_usd: s.totalSpend(ctx),
    global_spend_cap_usd: ctx.settings.global_spend_cap_usd,
    /** Debug mode (the dev session, or YAHO_DEBUG=1): the UI shows developer-only settings. */
    debug: process.env.YAHO_DEBUG === '1',
  }));

  r.on('GET', '/api/stats', (req) => {
    const days = Math.min(365, Math.max(1, Number(req.query.get('days')) || 30));
    return stats(ctx.db, days);
  });

  r.on('GET', '/api/schedule', (req) => schedule(ctx.db, Math.min(168, Math.max(1, Number(req.query.get('hours')) || 24))));

  // ---- settings ----
  // Secret values never leave the core: the UI sees which are set, and sends a value only to replace one.
  r.on('GET', '/api/settings', () => publicSettings(ctx.settings));
  r.on('PUT', '/api/settings', async (req) => {
    const next = await definition<Settings>(req);
    const slackBefore = JSON.stringify([ctx.settings.slack?.bot_token, ctx.settings.slack?.app_token]);
    const wa = () => JSON.stringify([ctx.settings.whatsapp?.access_token, ctx.settings.whatsapp?.app_secret, ctx.settings.whatsapp?.phone_number_id, ctx.settings.whatsapp?.number]);
    const waBefore = wa();
    const rs = () => JSON.stringify([ctx.settings.resend?.api_key, ctx.settings.resend?.domain]);
    const rsBefore = rs();
    const tw = () => JSON.stringify([ctx.settings.twilio?.account_sid, ctx.settings.twilio?.auth_token, ctx.settings.twilio?.number]);
    const twBefore = tw();
    const tg = () => JSON.stringify([ctx.settings.telegram?.bot_token]);
    const tgBefore = tg();
    applySettingsUpdate(ctx.settings, next);
    if (ctx.settings.dopbase.mode === 'bundled' && ctx.localDopbase && !ctx.localDopbase.child) await ctx.localDopbase.start();
    await storeSecrets(ctx);
    ctx.bus.emitEvent({ type: 'changed', entity: 'settings' });
    runner(ctx).pump();
    if (JSON.stringify([ctx.settings.slack?.bot_token, ctx.settings.slack?.app_token]) !== slackBefore) void ctx.slack?.start();
    if (serverMode() && wa() !== waBefore) void ctx.whatsapp?.start();
    if (serverMode() && rs() !== rsBefore) void ctx.email?.start();
    if (serverMode() && tw() !== twBefore) void ctx.sms?.start();
    if (tg() !== tgBefore) void ctx.telegram?.start();
    return publicSettings(ctx.settings);
  });

  // ---- first-run setup and checks ----
  r.on('POST', '/api/onboarding/done', () => {
    ctx.settings.onboarded_at = new Date().toISOString();
    saveSettings(ctx.settings);
    ctx.bus.emitEvent({ type: 'changed', entity: 'settings' });
    return { onboarded: true };
  });
  r.on('POST', '/api/onboarding/reset', () => {
    delete ctx.settings.onboarded_at;
    saveSettings(ctx.settings);
    ctx.bus.emitEvent({ type: 'changed', entity: 'settings' });
    return { onboarded: false };
  });
  r.on('GET', '/api/providers', () => PROVIDERS);
  // Server version: end every session (the current one too), and show the API token after the password and code.
  r.on('POST', '/api/session/revoke-all', () => {
    ctx.settings.server.session_epoch = (ctx.settings.server.session_epoch ?? 0) + 1;
    saveSettings(ctx.settings);
    ctx.bus.emitEvent({ type: 'changed', entity: 'settings' });
    return { revoked: true };
  });
  r.on('POST', '/api/session/token', async (req) => {
    const b = await req.body<{ password?: string; code?: string }>();
    return revealToken(ctx, req.raw, b.password, b.code);
  });
  r.on('GET', '/api/update', () => ctx.updates?.state ?? null);
  r.on('POST', '/api/update/check', () => ctx.updates?.check());
  r.on('POST', '/api/update/install', () => {
    if (!ctx.updates) throw new HttpError(503, 'updates are not available');
    try {
      return ctx.updates.install();
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });
  // One check per harness: codex, and claude-code (also answered as claude, as older clients ask).
  r.on('GET', '/api/checks/:harness', (req) => (req.params.harness === 'codex' ? lastCodexCheck() : lastClaudeCheck()));
  r.on('POST', '/api/checks/:harness', async (req) => {
    const r = req.params.harness === 'codex' ? await checkCodex(ctx) : await checkClaude(ctx);
    ctx.bus.emitEvent({ type: 'changed', entity: 'checks' });
    return r;
  });

  // ---- WhatsApp ----
  r.on('GET', '/api/whatsapp', () => ({
    ...(ctx.whatsapp?.status ?? { configured: false, connected: false, owner: false, linked: false, window_open: false }),
    webhook_path: '/api/whatsapp/webhook',
    verify_token: ctx.whatsapp?.verifyToken(),
  }));
  r.on('POST', '/api/whatsapp/reconnect', async () => {
    if (serverMode()) await ctx.whatsapp?.start();
    return ctx.whatsapp?.status;
  });

  // ---- Email (Resend) ----
  r.on('GET', '/api/resend', () => ({ ...(ctx.email?.status ?? { configured: false, connected: false }), webhook_path: '/api/resend/webhook' }));
  r.on('POST', '/api/resend/reconnect', async () => {
    if (serverMode()) await ctx.email?.start();
    return ctx.email?.status;
  });

  // ---- SMS (Twilio) ----
  r.on('GET', '/api/twilio', () => ({ ...(ctx.sms?.status ?? { configured: false, connected: false }), webhook_path: TWILIO_WEBHOOK }));
  r.on('POST', '/api/twilio/reconnect', async () => {
    if (serverMode()) await ctx.sms?.start();
    return ctx.sms?.status;
  });

  // ---- Webhooks (agents define them as triggers; the URL and secret are only shown here) ----
  r.on('GET', '/api/webhooks', (req) => listWebhooks(ctx, req.query.get('agent') ?? undefined));
  r.on('POST', '/api/webhooks/:id/rotate', (req) => rotateUrl(ctx, req.params.id!));
  r.on('PUT', '/api/webhooks/:id/secret', async (req) => setSecret(ctx, req.params.id!, (await req.body<{ secret?: string }>()).secret));
  // ---- the browser for agents ----
  r.on('GET', '/api/browser', () => ctx.browser?.status() ?? { provider: 'local', ready: false, detail: 'not available', running: 0 });
  r.on('POST', '/api/browser/test', async () => (ctx.browser ? ctx.browser.test() : { ok: false, error: 'not available' }));

  // ---- Guard Rails: Sandbox Mode ----
  r.on('GET', '/api/sandbox', () => ({
    on: sandboxOn(ctx.settings),
    default: serverMode(),
    problems: Object.fromEntries(Object.keys(ctx.settings.harnesses).map((h) => [h, sandboxProblem(h)])),
  }));

  // ---- Telegram ----
  r.on('GET', '/api/telegram', () => ({ ...(ctx.telegram?.status ?? { configured: false, connected: false, linked: false }), link_url: ctx.telegram?.linkUrl() }));
  r.on('POST', '/api/telegram/reconnect', async () => {
    await ctx.telegram?.start();
    return ctx.telegram?.status;
  });
  r.on('POST', '/api/telegram/forget-owner', async () => {
    // A new owner is whoever opens the bot's new link next.
    if (ctx.settings.telegram) {
      delete ctx.settings.telegram.owner;
      delete ctx.settings.telegram.since;
      delete ctx.settings.telegram.link_code;
      saveSettings(ctx.settings);
    }
    await ctx.telegram?.start();
    return ctx.telegram?.status;
  });

  // ---- Slack ----
  r.on('GET', '/api/slack', () => ({ ...(ctx.slack?.status ?? { configured: false, connected: false, owner: false }), create_url: slackCreateUrl(), manifest: JSON.stringify(slackManifest(), null, 2) }));
  r.on('POST', '/api/slack/reconnect', async () => {
    await ctx.slack?.start();
    return ctx.slack?.status;
  });
  r.on('POST', '/api/slack/forget-owner', () => {
    // A new owner is whoever opens the app in Slack next.
    if (ctx.settings.slack) {
      delete ctx.settings.slack.owner;
      delete ctx.settings.slack.since;
      saveSettings(ctx.settings);
    }
    return ctx.slack?.start().then(() => ctx.slack?.status);
  });
  r.on('GET', '/api/settings/yaml', () => ({ yaml: YAML.stringify(publicSettings(ctx.settings)) }));
  r.on('POST', '/api/settings/dopbase/test', async () => {
    const d = new Dopbase(ctx);
    const health = await d.health();
    if (!d.configured) return { ok: false, health, error: 'no token set' };
    await d.call('GET', '/projects');
    return { ok: true, health };
  });
  r.on('GET', '/api/settings/litellm/models', async () => ({ models: await litellmModels(litellmProvider(ctx.settings)) }));
  r.on('GET', '/api/models', async () => allModels(ctx.settings, defaultProvider(ctx.settings).id));
  r.on('GET', '/api/providers/:id/models', async (req) => {
    const p = ctx.settings.providers.find((x) => x.id === req.params.id);
    if (!p) throw new HttpError(404, `no provider ${req.params.id}`);
    return { models: await listModels(ctx.settings, p) };
  });

  // ---- assistant ----
  r.on('POST', '/api/assistant', async (req) => {
    const { messages, focus } = await req.body<{ messages?: ChatMessage[]; focus?: ChatFocus }>();
    if (!Array.isArray(messages) || !messages.length) throw new HttpError(400, 'messages is required');
    return chat(ctx, messages, focus);
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
  r.on('DELETE', '/api/agents/:name/browser', async (req) => {
    s.getAgent(ctx, req.params.name!);
    await ctx.browser?.forget(req.params.name!);
    return { forgotten: true };
  });
  r.on('PUT', '/api/agents/:name/folder', async (req) => {
    s.moveAgentToFolder(ctx, req.params.name!, (await req.body<{ folder?: string | null }>()).folder ?? null);
    ctx.bus.emitEvent({ type: 'changed', entity: 'agents' });
    return { ok: true };
  });

  // ---- agent folders (sidebar grouping only) ----
  r.on('GET', '/api/folders', () => s.listFolders(ctx));
  r.on('POST', '/api/folders', async (req) => {
    const f = s.createFolder(ctx, (await req.body<{ name?: string }>()).name);
    ctx.bus.emitEvent({ type: 'changed', entity: 'agents' });
    return f;
  });
  r.on('PUT', '/api/folders/:name', async (req) => {
    const f = s.renameFolder(ctx, req.params.name!, (await req.body<{ name?: string }>()).name);
    ctx.bus.emitEvent({ type: 'changed', entity: 'agents' });
    return f;
  });
  r.on('DELETE', '/api/folders/:name', (req) => {
    const f = s.deleteFolder(ctx, req.params.name!, { agents: req.query.get('agents') === '1' });
    ctx.bus.emitEvent({ type: 'changed', entity: 'agents' });
    return f;
  });
  /** Run Now, optionally with instructions for this run: delivered to the agent's inbox, and the run starts at once. */
  r.on('POST', '/api/agents/:name/run', async (req) => {
    const name = req.params.name!;
    const message = (await req.body<{ message?: string }>()).message?.trim();
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
  /** A follow-up from the human: a new job that resumes this job's session with their message. */
  r.on('POST', '/api/jobs/:id/followup', async (req) => {
    const job = s.getJob(ctx, req.params.id!);
    const { message } = await req.body<{ message?: string }>();
    if (!message?.trim()) throw new HttpError(400, 'message is required');
    if (!job.session_id) throw new HttpError(409, 'this job has no session to continue');
    const busy = ctx.db
      .prepare("SELECT id FROM jobs WHERE session_id = ? AND status IN ('queued','running') LIMIT 1")
      .get(job.session_id) as { id: string } | undefined;
    if (busy) throw new HttpError(409, `${busy.id} is still working in this session`);
    return runner(ctx).enqueue(job.agent, 'followup', { detail: message.trim(), sessionId: job.session_id, force: true });
  });
  /** Every job in this job's session, oldest first, with what the agent said in each. */
  r.on('GET', '/api/jobs/:id/thread', (req) => {
    const job = s.getJob(ctx, req.params.id!);
    const jobs = job.session_id
      ? (ctx.db.prepare('SELECT * FROM jobs WHERE session_id = ? ORDER BY created').all(job.session_id) as unknown as s.Job[])
      : [job];
    return jobs.map((j) => ({
      ...j,
      texts: s
        .jobEvents(ctx, j.id)
        .filter((e) => (e as { kind?: string }).kind === 'text')
        .map((e) => String((e.data as { text?: string } | null)?.text ?? '')),
    }));
  });

  // ---- messages ----
  r.on('GET', '/api/messages', (req) =>
    // q: words that must all appear in the title or body (the inbox search).
    req.query.get('q')?.trim()
      ? s.searchMessages(ctx, {
          text: req.query.get('q')!,
          ...(req.query.get('to') === 'human' ? { direction: 'to_human' as const } : {}),
          ...(req.query.get('involving')?.startsWith('agent:') ? { agent: req.query.get('involving')!.slice(6) } : {}),
          unread: req.query.get('unread') === '1',
          limit: 200,
        }).messages
      : s.listMessages(ctx, {
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
    if (String(m.to ?? '').startsWith('email:')) throw new HttpError(400, 'email is sent by agents (yaho email), not from the inbox');
    if (String(m.to ?? '').startsWith('sms:')) throw new HttpError(400, 'texts are sent by agents (yaho sms), not from the inbox');
    const msg = s.sendMessage(ctx, { ...m, from: 'human' });
    if (m.reply_to) s.markRead(ctx, m.reply_to, true);
    return msg;
  });
  r.on('DELETE', '/api/messages/:id', (req) => s.deleteMessage(ctx, req.params.id!));
  /** Delete every message in the human's inbox (what agents sent you). Your own messages to agents stay. */
  r.on('POST', '/api/inbox/delete-all', () => {
    const ids = (ctx.db.prepare("SELECT id FROM messages WHERE to_addr = 'human'").all() as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) s.deleteMessage(ctx, id);
    return { deleted: ids.length };
  });
  r.on('POST', '/api/inbox/read-all', () => {
    const ids = (ctx.db.prepare("SELECT id FROM messages WHERE to_addr = 'human' AND read = 0").all() as Array<{ id: string }>).map((r) => r.id);
    for (const id of ids) s.markRead(ctx, id, true);
    return { marked: ids.length };
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
  /**
   * Rename a resource. Its values live in a Dopbase project named after it, so they are copied to the new project
   * first and removed from the old one after; agents keep their access through the cascade.
   */
  const renameResource = async (from: string, to: string) => {
    const res = s.getResource(ctx, from);
    if (from === to) return res;
    if (ctx.db.prepare('SELECT 1 FROM resources WHERE name = ?').get(to)) throw new HttpError(409, `a resource named ${to} already exists`);
    const dop = new Dopbase(ctx);
    const set = res.keys.filter((k) => k.has_value).map((k) => k.name);
    const values = set.length && dop.configured ? await dop.runtimeValues(from) : {};
    s.saveResource(ctx, { name: to }, from);
    try {
      for (const [k, v] of Object.entries(values)) await dop.setValue(to, k, v);
    } catch (e) {
      s.saveResource(ctx, { name: from }, to);
      throw e;
    }
    for (const k of Object.keys(values)) await dop.deleteValue(from, k).catch(() => undefined);
    ctx.bus.emitEvent({ type: 'changed', entity: 'resources', name: from });
    ctx.bus.emitEvent({ type: 'changed', entity: 'agents' });
    return s.getResource(ctx, to);
  };
  r.on('POST', '/api/resources/:name/rename', async (req) => {
    const { to } = await req.body<{ to?: string }>();
    if (typeof to !== 'string' || !to.trim()) throw new HttpError(400, 'to is required');
    return renameResource(req.params.name!, to.trim());
  });
  r.on('PUT', '/api/resources/:name', async (req) => {
    const x = await definition<s.Resource & { agents?: string[] }>(req);
    s.getResource(ctx, req.params.name!);
    const name = x.name ?? req.params.name!;
    if (name !== req.params.name) await renameResource(req.params.name!, name);
    return s.saveResource(ctx, { ...x, name });
  });
  r.on('DELETE', '/api/resources/:name', (req) => s.deleteResource(ctx, req.params.name!));
  /** The values of the keys that are not secret (agents see them anyway). Secret values never leave Dopbase this way. */
  r.on('GET', '/api/resources/:name/values', async (req) => {
    const open = s.getResource(ctx, req.params.name!).keys.filter((k) => !k.secret && k.has_value).map((k) => k.name);
    if (!open.length) return {};
    const all = await new Dopbase(ctx).runtimeValues(req.params.name!);
    return Object.fromEntries(open.filter((k) => k in all).map((k) => [k, all[k]!]));
  });
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
