import { randomBytes } from 'node:crypto';
import { resolveModel } from '../providers.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { HttpError, addJobEvent, agentSpend, ensureAgentWorkspace, getAgent, getJob, updateJob } from '../store.ts';
import { procId, sameProc } from '../harness/proc.ts';
import { contextPrompt, systemPrompt } from './prompt.ts';
import type { ModelPrice } from './litellm.ts';
import { indexJob, writeRecap } from '../history.ts';
import { harnessFits, jobAccess, priceFor } from '../providerApi.ts';

type Row = Record<string, unknown>;

interface Running {
  job: string;
  agent: string;
  /** The session it runs in, once known: another job in it waits until this one ends. */
  session: string | null;
  proc: HarnessProcess | null;
  /** Set when the job is being ended on purpose (finish, sleep, stop, budget). The close handler applies it. */
  ending?: { status: string; reason?: string; summary?: string; resumeAt?: string };
  baseCost: number;
  /** The job's cost so far (cost_usd), and the budget it was given at start: what it holds of the agent's budget. */
  cost: number;
  cap?: number;
  killTimer?: NodeJS.Timeout;
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
  /** Spend per agent and in total, from the database at most every few seconds and kept current by setCost between. */
  private spendCache = { at: 0, total: 0, agents: new Map<string, number>() };

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
      // Only the very process that job started (same pid and start time): a pid may belong to another process by now.
      const file = this.pidFile(j.id as string);
      const pid = existsSync(file) ? sameProc(readFileSync(file, 'utf8').trim()) : null;
      if (pid) killTree(pid);
      rmSync(file, { force: true });
      this.requeueInterrupted(j.id as string, 'the Yaho core stopped while the job was running');
    }
  }

  private pidFile(job: string): string {
    return join(this.ctx.paths.root, 'run', `${job}.pid`);
  }

  private refreshSpend(maxAgeMs = 2000): void {
    if (Date.now() - this.spendCache.at < maxAgeMs) return;
    const rows = this.ctx.db.prepare('SELECT agent, COALESCE(SUM(cost_usd),0) s FROM jobs GROUP BY agent').all() as Row[];
    this.spendCache = { at: Date.now(), total: rows.reduce((a, r) => a + Number(r.s), 0), agents: new Map(rows.map((r) => [r.agent as string, Number(r.s)])) };
  }

  private spent(agent?: string): number {
    this.refreshSpend();
    return agent === undefined ? this.spendCache.total : (this.spendCache.agents.get(agent) ?? 0);
  }

  /**
   * What an agent may still spend on a new job: its budget less what it spent, and less what its other running jobs
   * were given and have not used yet, so parallel jobs share the budget instead of each getting all of it.
   */
  private available(agent: Agent, except?: Running): number {
    let held = 0;
    for (const r of this.running.values())
      if (r !== except && r.agent === agent.name && r.cap !== undefined) held += Math.max(0, r.cap - (r.cost - r.baseCost));
    return Math.max(0, agent.budget_usd - this.spent(agent.name) - held);
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
      this.refreshSpend(queued.length ? 0 : 2000);
      for (const job of queued) {
        if (this.spent() >= this.ctx.settings.global_spend_cap_usd) {
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
        const mine = [...this.running.values()].filter((r) => r.agent === agent.name);
        if (mine.length >= agent.max_parallel) continue;
        // One harness per session: a job for a session that is still running waits for it (an answer to an approval
        // that arrives before the paused job has ended, a follow-up).
        if (job.session_id && [...this.running.values()].some((r) => r.session === job.session_id)) continue;
        if (this.spent(agent.name) >= agent.budget_usd) {
          updateJob(this.ctx, job.id, {
            status: 'budget_exhausted',
            reason: `agent budget of $${agent.budget_usd} is spent`,
            ended: now(),
          });
          continue;
        }
        // The rest of the budget is held by the agent's running jobs: wait for one to end.
        if (mine.length && this.available(agent) < 0.01) continue;
        const r: Running = { job: job.id, agent: agent.name, session: job.session_id, proc: null, baseCost: job.cost_usd, cost: job.cost_usd, usage: new Map() };
        this.running.set(job.id, r);
        updateJob(this.ctx, job.id, { status: 'running', started: job.started ?? now(), reason: null });
        this.start(agent, job, r).catch((e) => {
          // A job forgotten meanwhile (its agent was deleted) has nothing left to record.
          if (!this.running.has(r.job)) return this.release(r);
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
    r.session = ses.id;
    const cwd = ensureAgentWorkspace(ctx, agent.name);

    const remaining = this.available(agent, r);
    r.cap = remaining;
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

    if (!this.running.has(r.job)) return this.release(r);
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
    void procId(r.proc.pid).then((id) => {
      if (!id || !this.running.has(r.job)) return;
      mkdirSync(join(ctx.paths.root, 'run'), { recursive: true });
      writeFileSync(this.pidFile(r.job), id);
    });
    if (r.capped) r.poll = setInterval(() => void this.pollCost(r), 10_000);
    const code = await r.proc.done;
    if (r.killTimer) clearTimeout(r.killTimer);
    if (!this.running.has(r.job)) return;
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
    // A job forgotten (its agent deleted) may still print a few lines before its harness is gone.
    if (!this.running.has(r.job)) return;
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
        if (typeof e.cost_usd === 'number' && r.baseCost + e.cost_usd > r.cost) this.setCost(r, r.baseCost + e.cost_usd);
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
    if (spend !== null && this.running.has(r.job) && r.baseCost + spend > r.cost) this.setCost(r, r.baseCost + spend);
  }

  private setCost(r: Running, cost: number): void {
    if (Math.abs(r.cost - cost) < 1e-9) return;
    const delta = cost - r.cost;
    r.cost = cost;
    this.spendCache.total += delta;
    this.spendCache.agents.set(r.agent, (this.spendCache.agents.get(r.agent) ?? 0) + delta);
    updateJob(this.ctx, r.job, { cost_usd: cost });
    addJobEvent(this.ctx, r.job, 'cost', { total_usd: cost });
    this.enforceBudgets(r.agent);
  }

  /** Stop jobs whose agent budget, their share of it, or the global cap is spent. */
  enforceBudgets(agentName?: string): void {
    const { ctx } = this;
    const globalHit = this.spent() >= ctx.settings.global_spend_cap_usd;
    for (const r of this.running.values()) {
      if (agentName && !globalHit && r.agent !== agentName) continue;
      if (globalHit) {
        this.stop(r.job, 'budget_exhausted', 'global spend cap reached');
        continue;
      }
      const agent = getAgent(ctx, r.agent);
      if (this.spent(agent.name) >= agent.budget_usd) this.stop(r.job, 'budget_exhausted', `agent budget of $${agent.budget_usd} is spent`);
      else if (r.cap !== undefined && r.cost - r.baseCost >= r.cap + 1e-9)
        this.stop(r.job, 'budget_exhausted', `its share of the agent budget ($${r.cap.toFixed(2)}) is spent`);
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
    r.killTimer = setTimeout(() => r.proc?.kill(), grace);
  }

  /**
   * Forget a running job whose agent is being deleted: its harness is killed now and nothing more is recorded for it
   * (its rows go with the agent).
   */
  detach(jobId: string): void {
    const r = this.running.get(jobId);
    if (!r) return;
    this.running.delete(jobId);
    r.ending ??= { status: 'stopped', reason: 'agent deleted' };
    if (r.poll) clearInterval(r.poll);
    if (r.killTimer) clearTimeout(r.killTimer);
    this.release(r);
    rmSync(this.pidFile(jobId), { force: true });
    void this.ctx.browser?.close(jobId);
    r.proc?.kill();
  }

  /** Remove the key minted for the job, once. */
  private release(r: Running): void {
    const capped = r.capped;
    r.capped = undefined;
    void capped?.release().catch((e) => console.error(`[yaho] could not remove the key minted for ${r.job}: ${(e as Error).message}`));
  }

  private finalize(r: Running, end: { status: string; reason?: string; summary?: string; resumeAt?: string }): void {
    const { ctx } = this;
    if (!this.running.has(r.job)) return;
    this.running.delete(r.job);
    if (r.poll) clearInterval(r.poll);
    if (r.killTimer) clearTimeout(r.killTimer);
    this.release(r);
    rmSync(this.pidFile(r.job), { force: true });
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
