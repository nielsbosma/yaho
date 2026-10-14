import { randomBytes } from 'node:crypto';
import { resolveModel } from '../providers.ts';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Ctx } from '../context.ts';
import { newId, now } from '../db/index.ts';
import { adapters, killTree } from '../harness/index.ts';
import { coreFiles, sandboxGuardCommand, sandboxOn, sandboxProblem } from '../harness/sandbox.ts';
import { COMMAND_GUARD, hookCommand } from '../harness/commandGuard.ts';
import { commandRulesOn } from '../guard/commands.ts';
import type { HarnessEvent, HarnessProcess } from '../harness/types.ts';
import { envForAgent } from '../secrets/dopbase.ts';
import { jobEnv } from '../harness/asAgent.ts';
import type { Agent, Job } from '../store.ts';
import { HttpError, addJobEvent, agentSpend, ensureAgentWorkspace, getAgent, getJob, totalSpend, updateJob } from '../store.ts';
import { contextPrompt, systemPrompt } from './prompt.ts';
import type { ModelPrice } from './litellm.ts';
import { indexJob, writeRecap } from '../history.ts';
import { harnessFits, jobAccess, priceFor } from '../providerApi.ts';

type Row = Record<string, unknown>;

interface Running {
  job: string;
  proc: HarnessProcess | null;
  /** Set when the job is being ended on purpose (finish, sleep, stop, budget). The close handler applies it. */
  ending?: { status: string; reason?: string; summary?: string; resumeAt?: string };
  baseCost: number;
  /** A key minted for this job alone (LiteLLM, OpenRouter with a management key): its spend, and its removal. */
  capped?: { spend(): Promise<number>; release(): Promise<void> };
  /** Live estimate from token usage when LiteLLM cannot report spend per job. Keyed by response id. */
  usage: Map<string, number>;
  price?: ModelPrice | null;
  poll?: NodeJS.Timeout;
}

/**
 * `yaho` first, then the inherited PATH without duplicates or missing folders. Windows PATHs grow past cmd.exe's
 * 8191-character limit, after which cmd sees a truncated PATH and nothing on it resolves.
 */
export function jobPath(bin: string, inherited: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [bin, ...inherited.split(delimiter)]) {
    const key = process.platform === 'win32' ? dir.replace(/[\\/]+$/, '').toLowerCase() : dir;
    if (!dir || seen.has(key) || (dir !== bin && !existsSync(dir))) continue;
    seen.add(key);
    out.push(dir);
  }
  return out.join(delimiter);
}

const ENDED = ['finished', 'sleeping', 'failed', 'budget_exhausted', 'stopped'];

/** Jobs a human started; they run even while the agent is disabled. */
const HUMAN_STARTED = new Set(['manual', 'followup', 'continue', 'approval']);

export class JobRunner {
  ctx: Ctx;
  running = new Map<string, Running>();
  pumping = false;
  shuttingDown = false;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    ctx.runner = this;
  }

  /**
   * Jobs left 'running' by a core that died without shutting down. Their harness may still be alive (Windows does not
   * kill children with the parent), so kill it, then queue the job to resume its session.
   */
  recover(): void {
    for (const j of this.ctx.db.prepare("SELECT id, pid FROM jobs WHERE status = 'running'").all() as Row[]) {
      if (j.pid) killTree(Number(j.pid));
      this.requeueInterrupted(j.id as string, 'the Yaho core stopped while the job was running');
    }
  }

  private requeueInterrupted(id: string, why: string): void {
    updateJob(this.ctx, id, { status: 'queued', trigger_type: 'continue', trigger_detail: why, reason: null, ended: null, pid: null });
    addJobEvent(this.ctx, id, 'status', { text: `Interrupted: ${why}. It resumes when the core is back.` });
  }

  /** Create a queued job. Returns null when the agent is disabled (its triggers are ignored), unless forced by the human. */
  enqueue(
    agentName: string,
    trigger: string,
    opts: { detail?: string; hop?: number; sessionId?: string | null; force?: boolean } = {},
  ): Job | null {
    const agent = getAgent(this.ctx, agentName);
    // Disabled means no automatic runs; the human can still start one by hand (force).
    if (!agent.enabled && !opts.force) return null;
    const id = newId('job');
    this.ctx.db
      .prepare('INSERT INTO jobs (id, agent, session_id, trigger_type, trigger_detail, status, hop, created) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, agentName, opts.sessionId ?? null, trigger, opts.detail ?? null, 'queued', opts.hop ?? 0, now());
    const job = updateJob(this.ctx, id, {});
    this.pump();
    return job;
  }

  /** Start every queued job that has a free slot, budget, and is under the global cap. */
  pump(): void {
    if (this.pumping || this.shuttingDown) return;
    this.pumping = true;
    try {
      const queued = this.ctx.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created").all() as unknown as Job[];
      for (const job of queued) {
        if (totalSpend(this.ctx) >= this.ctx.settings.global_spend_cap_usd) {
          if (job.reason !== 'global spend cap reached') updateJob(this.ctx, job.id, { reason: 'global spend cap reached' });
          continue;
        }
        let agent: Agent;
        try {
          agent = getAgent(this.ctx, job.agent);
        } catch {
          continue;
        }
        if (!agent.enabled && !HUMAN_STARTED.has(job.trigger_type)) {
          updateJob(this.ctx, job.id, { status: 'stopped', reason: 'agent disabled', ended: now() });
          continue;
        }
        const active = [...this.running.values()].filter((r) => getJob(this.ctx, r.job).agent === agent.name).length;
        if (active >= agent.max_parallel) continue;
        if (agentSpend(this.ctx, agent.name) >= agent.budget_usd) {
          updateJob(this.ctx, job.id, {
            status: 'budget_exhausted',
            reason: `agent budget of $${agent.budget_usd} is spent`,
            ended: now(),
          });
          continue;
        }
        const r: Running = { job: job.id, proc: null, baseCost: job.cost_usd, usage: new Map() };
        this.running.set(job.id, r);
        updateJob(this.ctx, job.id, { status: 'running', started: job.started ?? now(), reason: null });
        this.start(agent, job, r).catch((e) => {
          addJobEvent(this.ctx, job.id, 'system', { text: `failed to start: ${(e as Error).message}` });
          this.finalize(r, { status: 'failed', reason: (e as Error).message });
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private session(agent: Agent, job: Job): { id: string; harnessId: string | null; summary: string | null; resumed: boolean } {
    const db = this.ctx.db;
    if (job.session_id) {
      const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get(job.session_id) as Row | undefined;
      if (s)
        return {
          id: s.id as string,
          harnessId: (s.harness_session_id as string) ?? null,
          summary: (s.summary as string) ?? null,
          resumed: !!s.harness_session_id,
        };
    }
    const last = db
      .prepare('SELECT summary FROM sessions WHERE agent = ? AND summary IS NOT NULL ORDER BY updated DESC LIMIT 1')
      .get(agent.name) as Row | undefined;
    const id = newId('ses');
    db.prepare('INSERT INTO sessions (id, agent, created, updated) VALUES (?,?,?,?)').run(id, agent.name, now(), now());
    updateJob(this.ctx, job.id, { session_id: id });
    return { id, harnessId: null, summary: (last?.summary as string) ?? null, resumed: false };
  }

  private async start(agent: Agent, job: Job, r: Running): Promise<void> {
    const { ctx } = this;
    const settings = ctx.settings;
    const harnessCfg = settings.harnesses[agent.harness];
    const adapter = adapters[agent.harness];
    if (!harnessCfg || !adapter) throw new Error(`harness ${agent.harness} is not available`);
    const sandbox = sandboxOn(settings);
    const unsandboxable = sandbox ? sandboxProblem(agent.harness) : null;
    if (unsandboxable) throw new Error(`Sandbox Mode is on, but ${unsandboxable}. Turn it off in Settings → Guard Rails to run without it.`);
    const model = agent.models[0] ?? settings.defaults.models[0];
    if (!model) throw new Error('the agent has no allowed models');
    const ses = this.session(agent, job);
    const cwd = ensureAgentWorkspace(ctx, agent.name);

    const remaining = Math.max(0, agent.budget_usd - agentSpend(ctx, agent.name));
    // The provider serving the model, and how Claude Code reaches it (a capped key per job where the provider can).
    const { provider, model: providerModel } = resolveModel(settings, model);

    const token = randomBytes(24).toString('hex');
    ctx.db
      .prepare('INSERT INTO job_tokens (token, job, agent, expires, provider) VALUES (?,?,?,?,?)')
      .run(token, job.id, agent.name, new Date(Date.now() + 7 * 864e5).toISOString(), provider.id);
    if (!harnessFits(provider, agent.harness))
      throw new Error(`${agent.harness} cannot use ${provider.id}: Codex needs a provider with OpenAI's Responses API (OpenAI, LiteLLM, Opper, OpenRouter)`);
    const access = await jobAccess(settings, provider, {
      models: agent.models.map((m) => resolveModel(settings, m).model),
      remaining,
      agent: agent.name,
      job: job.id,
      harness: agent.harness,
      bridge: { apiUrl: ctx.apiUrl, token },
    });
    r.capped = access.capped;
    const secrets = await envForAgent(ctx, agent.resources);
    for (const w of secrets.warnings) addJobEvent(ctx, job.id, 'system', { text: w });

    // Background calls (titles, summaries) go to the same provider: the agent's last model served by it.
    const background =
      agent.models
        .map((m) => resolveModel(settings, m))
        .filter((x) => x.provider.id === provider.id)
        .at(-1)?.model ?? providerModel;
    // Never another Claude session's identity or credentials (the harness talks only to the provider Yaho gives it), and
    // never the core's passwords or keys.
    const env = jobEnv();
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    Object.assign(env, secrets.env, {
      [pathKey]: jobPath(ctx.paths.bin, env[pathKey] ?? ''),
      YAHO_API_URL: ctx.apiUrl,
      YAHO_JOB_TOKEN: token,
      YAHO_AGENT: agent.name,
      YAHO_JOB: job.id,
      YAHO_AGENT_DB: join(cwd, 'agent.db'),
      // The sandbox has its own network, where 127.0.0.1 is not this machine: yaho goes through the core's socket.
      ...(sandbox && agent.harness === 'claude-code' && process.platform !== 'win32' ? { YAHO_API_SOCKET: ctx.paths.socket } : {}),
      ...access.env,
      // Codex keeps its sessions and settings here, apart from the person's own ~/.codex; one folder per agent, so one
      // agent cannot read another's.
      CODEX_HOME: join(ctx.paths.root, 'codex', agent.name),
      // Background calls (titles, summaries) must also use a model the provider knows.
      ANTHROPIC_DEFAULT_HAIKU_MODEL: background,
      ANTHROPIC_SMALL_FAST_MODEL: background,
      DISABLE_TELEMETRY: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    });

    const fresh = getJob(ctx, job.id);
    let prompt = contextPrompt(ctx, agent, fresh, ses.summary, ses.resumed);
    if (ses.resumed && job.trigger_type === 'continue') prompt = `Your budget was raised. Continue exactly where you stopped.\n\n${prompt}`;
    updateJob(ctx, job.id, { model });
    // Without a capped key Yaho counts the cost itself, from the tokens the harness reports.
    if (!r.capped) r.price = await priceFor(settings, provider, providerModel);
    addJobEvent(ctx, job.id, 'prompt', { system: systemPrompt(agent), user: prompt });
    addJobEvent(ctx, job.id, 'status', { text: `${ses.resumed ? 'Resuming' : 'Starting'} ${agent.harness} with ${model}` });

    if (r.ending) return this.finalize(r, r.ending); // stopped while starting
    // Raw harness output, kept per session in the agent's workspace under .yaho/ (the Session's transcript ref).
    mkdirSync(join(cwd, '.yaho'), { recursive: true });
    const transcript = join(cwd, '.yaho', `${ses.id}.jsonl`);
    ctx.db.prepare('UPDATE sessions SET transcript_ref = ? WHERE id = ?').run(transcript, ses.id);
    r.proc = adapter.start(
      {
        command: harnessCfg.command,
        args: harnessCfg.args,
        cwd,
        env,
        model: providerModel,
        systemPrompt: systemPrompt(agent),
        prompt,
        resumeSessionId: ses.harnessId,
        transcriptPath: transcript,
        maxBudgetUsd: remaining,
        sandbox: sandbox ? { guard: sandboxGuardCommand(ctx.paths.bin), socket: ctx.paths.socket, denyRead: coreFiles(ctx.paths) } : undefined,
        commandGuard: commandRulesOn(settings) ? hookCommand(ctx.paths.bin, COMMAND_GUARD) : undefined,
      },
      (e) => this.onEvent(r, ses.id, e),
    );
    updateJob(ctx, job.id, { pid: r.proc.pid ?? null });
    if (r.capped) r.poll = setInterval(() => void this.pollCost(r), 10_000);
    const code = await r.proc.done;
    if (r.capped) await this.pollCost(r);
    const end =
      r.ending ??
      (code === 0
        ? { status: 'finished', reason: 'harness exited without calling yaho finish' }
        : { status: 'failed', reason: `harness exited with code ${code}` });
    this.finalize(r, end);
  }

  private onEvent(r: Running, sessionId: string, e: HarnessEvent): void {
    const { ctx } = this;
    switch (e.kind) {
      case 'usage':
        if (!r.capped && r.price) {
          const p = r.price;
          r.usage.set(e.id, e.input * p.input + e.output * p.output + e.cache_read * p.cache_read + e.cache_write * p.cache_write);
          this.setCost(r, r.baseCost + [...r.usage.values()].reduce((a, b) => a + b, 0));
        }
        return;
      case 'session':
        ctx.db.prepare('UPDATE sessions SET harness_session_id = ?, updated = ? WHERE id = ?').run(e.sessionId, now(), sessionId);
        return;
      case 'result':
        if (e.summary)
          ctx.db.prepare('UPDATE sessions SET last_state = ?, updated = ? WHERE id = ?').run(e.summary.slice(0, 4000), now(), sessionId);
        // The harness's own total only ever raises the cost: the provider's usage and the estimate from tokens may be higher.
        if (typeof e.cost_usd === 'number' && r.baseCost + e.cost_usd > getJob(this.ctx, r.job).cost_usd) this.setCost(r, r.baseCost + e.cost_usd);
        if (!e.ok && !r.ending) {
          const budget = /budget/i.test(e.error ?? '');
          r.ending = { status: budget ? 'budget_exhausted' : 'failed', reason: e.error };
        }
        // A harness we killed on purpose reports a failure; that is not news.
        if (!(r.ending && !e.ok)) addJobEvent(ctx, r.job, 'result', e);
        return;
      default:
        addJobEvent(ctx, r.job, e.kind, e);
    }
  }

  private async pollCost(r: Running): Promise<void> {
    if (!r.capped) return;
    const spend = await r.capped.spend().catch(() => null);
    // Only upward: the harness may already have reported a higher total than the provider's (lagging) usage.
    if (spend !== null && r.baseCost + spend > getJob(this.ctx, r.job).cost_usd) this.setCost(r, r.baseCost + spend);
  }

  private setCost(r: Running, cost: number): void {
    const job = getJob(this.ctx, r.job);
    if (Math.abs(job.cost_usd - cost) < 1e-9) return;
    updateJob(this.ctx, r.job, { cost_usd: cost });
    addJobEvent(this.ctx, r.job, 'cost', { total_usd: cost });
    this.enforceBudgets(job.agent);
  }

  /** Stop jobs whose agent budget, or the global cap, is spent. */
  enforceBudgets(agentName?: string): void {
    const { ctx } = this;
    const globalHit = totalSpend(ctx) >= ctx.settings.global_spend_cap_usd;
    for (const r of this.running.values()) {
      const job = getJob(ctx, r.job);
      if (agentName && !globalHit && job.agent !== agentName) continue;
      const agent = getAgent(ctx, job.agent);
      if (globalHit) this.stop(job.id, 'budget_exhausted', 'global spend cap reached');
      else if (agentSpend(ctx, agent.name) >= agent.budget_usd)
        this.stop(job.id, 'budget_exhausted', `agent budget of $${agent.budget_usd} is spent`);
    }
  }

  /** End a running or queued job on purpose. The harness is killed; the session is kept. */
  stop(jobId: string, status = 'stopped', reason?: string, extra: { summary?: string; resumeAt?: string; grace?: number } = {}): void {
    const r = this.running.get(jobId);
    if (!r) {
      const job = getJob(this.ctx, jobId);
      if (job.status === 'queued') updateJob(this.ctx, jobId, { status, reason: reason ?? null, ended: now() });
      return;
    }
    if (r.ending) return;
    const { grace: wait, ...rest } = extra;
    r.ending = { status, reason, ...rest };
    // finish and sleep come from the agent itself: let the harness wrap up and report its cost, but not for long.
    // A stop from the human (or a budget) is immediate, after the calling request has had its response.
    const grace = wait ?? (status === 'finished' || status === 'sleeping' ? 30_000 : 750);
    setTimeout(() => r.proc?.kill(), grace);
  }

  private finalize(r: Running, end: { status: string; reason?: string; summary?: string; resumeAt?: string }): void {
    const { ctx } = this;
    if (!this.running.has(r.job)) return;
    this.running.delete(r.job);
    if (r.poll) clearInterval(r.poll);
    if (r.capped) void r.capped.release().catch(() => undefined);
    ctx.db.prepare('DELETE FROM job_tokens WHERE job = ?').run(r.job);
    void ctx.browser?.close(r.job);
    if (this.shuttingDown) return this.requeueInterrupted(r.job, 'the Yaho core restarted');
    const job = getJob(ctx, r.job);
    if (end.summary && job.session_id)
      ctx.db.prepare('UPDATE sessions SET summary = ?, updated = ? WHERE id = ?').run(end.summary, now(), job.session_id);
    updateJob(ctx, r.job, {
      status: end.status,
      reason: end.reason ?? null,
      ended: now(),
      resume_at: end.resumeAt ?? null,
      pid: null,
      ...(end.summary ? { summary: end.summary } : {}),
    });
    addJobEvent(ctx, r.job, 'status', { text: `Job ${end.status}${end.reason ? `: ${end.reason}` : ''}` });
    indexJob(ctx, r.job);
    void writeRecap(ctx, r.job).catch((e) => addJobEvent(ctx, r.job, 'system', { text: `no recap: ${(e as Error).message}` }));
    if (end.status === 'failed') {
      ctx.bus.emitEvent({ type: 'notify', title: `${job.agent}: job failed`, body: end.reason ?? '' });
    }
    this.pump();
  }

  /** Re-run a stopped/failed/budget-exhausted job in place, resuming its session. */
  continueJob(jobId: string): void {
    const job = getJob(this.ctx, jobId);
    if (!ENDED.includes(job.status) || job.status === 'finished' || job.status === 'sleeping')
      throw new HttpError(409, `a ${job.status} job cannot be continued`);
    const agent = getAgent(this.ctx, job.agent);
    if (agentSpend(this.ctx, agent.name) >= agent.budget_usd)
      throw new HttpError(
        409,
        `raise ${agent.name}'s budget first (spent $${agentSpend(this.ctx, agent.name).toFixed(2)} of $${agent.budget_usd})`,
      );
    updateJob(this.ctx, jobId, { status: 'queued', trigger_type: 'continue', trigger_detail: job.reason, reason: null, ended: null });
    this.pump();
  }

  /** `yaho sleep`: end now and schedule a delay trigger that resumes the same session. */
  sleep(jobId: string, ms: number): string {
    const job = getJob(this.ctx, jobId);
    const at = new Date(Date.now() + ms).toISOString();
    this.ctx.db
      .prepare("INSERT INTO triggers (id, agent, type, next_fire, session_id, created) VALUES (?,?,'delay',?,?,?)")
      .run(newId('trg'), job.agent, at, job.session_id, now());
    this.stop(jobId, 'sleeping', `sleeping until ${at}`, { resumeAt: at });
    return at;
  }

  /** Stop every harness and queue its job to resume on the next start. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const all = [...this.running.values()];
    for (const r of all) r.proc?.kill();
    await Promise.race([Promise.all(all.map((r) => r.proc?.done)), new Promise((res) => setTimeout(res, 5000))]);
    // A copy: finalize() deletes from the map while we walk it.
    for (const r of Array.from(this.running.values())) this.finalize(r, { status: 'queued' });
  }
}
