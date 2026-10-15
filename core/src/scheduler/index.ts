import type { BusEvent, Ctx } from '../context.ts';
import type { Message } from '../store.ts';
import { agentExists, getAgent, lastCron, nextCron, sendMessage } from '../store.ts';
import { answerApproval } from '../guard/commands.ts';
import { dreamSettings, hasNewWork } from '../jobs/dream.ts';

type Row = Record<string, unknown>;
type Run = { slot: string; start: () => void };

/** A slot this far behind the tick was missed (Yaho was off or asleep), not merely reached. */
const MISSED_MS = 5 * 60_000;

/**
 * Turns triggers into jobs. Cron and delay triggers are polled; inbox triggers react to new messages.
 * After Yaho was off, an agent catches up with one run: the latest of its missed cron slots and dreams. The rest are
 * skipped and every schedule continues from now.
 */
export class Scheduler {
  ctx: Ctx;
  timer: NodeJS.Timeout | null = null;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    ctx.bus.on('event', (e: BusEvent) => {
      if (e.type === 'message') this.onMessage(e.message as Message);
    });
  }

  start(intervalMs = 5000): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  tick(at = new Date()): void {
    const { db } = this.ctx;
    const iso = at.toISOString();
    const runs = new Map<string, Run[]>();
    const offer = (agent: string, run: Run) => runs.set(agent, [...(runs.get(agent) ?? []), run]);
    const due = db
      .prepare("SELECT * FROM triggers WHERE type IN ('cron','delay') AND next_fire IS NOT NULL AND next_fire <= ? ORDER BY next_fire")
      .all(iso) as Row[];
    for (const t of due) {
      const agent = t.agent as string;
      if (!agentExists(this.ctx, agent)) continue;
      const enabled = getAgent(this.ctx, agent).enabled;
      if (t.type === 'cron') {
        const cron = t.cron as string;
        db.prepare('UPDATE triggers SET next_fire = ? WHERE id = ?').run(nextCron(cron, at), t.id as string);
        if (enabled && !this.waitingOnHuman(agent))
          offer(agent, {
            slot: latest(t.next_fire as string, lastCron(cron, at)),
            start: () => this.ctx.runner!.enqueue(agent, 'cron', { detail: cron }),
          });
      } else if (enabled) {
        // A delay resumes the session the agent went to sleep in. While the agent is disabled it waits.
        db.prepare('DELETE FROM triggers WHERE id = ?').run(t.id as string);
        this.ctx.runner!.enqueue(agent, 'delay', { sessionId: t.session_id as string, detail: `woke from yaho sleep` });
      }
    }
    this.dreams(at, offer);
    const missed = new Date(at.getTime() - MISSED_MS).toISOString();
    for (const list of runs.values()) {
      if (!list.some((r) => r.slot < missed)) list.forEach((r) => r.start());
      else list.reduce((a, b) => (b.slot > a.slot ? b : a)).start();
    }
  }

  /**
   * Each agent with dreaming on dreams once per slot of the dreaming schedule (03:00 by default), counted from its last
   * dream, so a night missed while Yaho was off dreams once at start. Nothing new since the last dream: skipped.
   */
  dreams(at = new Date(), offer: (agent: string, run: Run) => void = (_, r) => r.start()): void {
    const cfg = dreamSettings(this.ctx);
    if (!cfg.enabled) return;
    const { db } = this.ctx;
    const iso = at.toISOString();
    for (const a of db.prepare('SELECT name, created, last_dream FROM agents WHERE enabled = 1 AND dreaming = 1').all() as Row[]) {
      const name = a.name as string;
      let due: string | null;
      try {
        due = nextCron(cfg.cron, new Date((a.last_dream ?? a.created) as string));
      } catch {
        return;
      }
      if (!due || due > iso) continue;
      db.prepare('UPDATE agents SET last_dream = ? WHERE name = ?').run(iso, name);
      if (!hasNewWork(this.ctx, name, (a.last_dream ?? a.created) as string)) continue;
      if (db.prepare("SELECT 1 FROM jobs WHERE agent = ? AND trigger_type = 'dream' AND status IN ('queued','running')").get(name))
        continue;
      offer(name, {
        slot: latest(due, lastCron(cfg.cron, at)),
        start: () => this.ctx.runner!.enqueue(name, 'dream', { detail: 'nightly' }),
      });
    }
  }

  /** wait_for_inbox: the human has not read this agent's last messages yet, so its next scheduled run is skipped. */
  waitingOnHuman(agent: string): boolean {
    if (!getAgent(this.ctx, agent).guardrails?.wait_for_inbox) return false;
    return !!this.ctx.db
      .prepare("SELECT 1 FROM messages WHERE from_addr = ? AND to_addr = 'human' AND read = 0 LIMIT 1")
      .get(`agent:${agent}`);
  }

  /** A message for an agent with an inbox trigger starts a job, within the agent's loop guardrails. */
  onMessage(m: Message): void {
    if (answerApproval(this.ctx, m)) return;
    if (!m.to.startsWith('agent:') || m.read || m.wake === false) return;
    const name = m.to.slice(6);
    if (!agentExists(this.ctx, name)) return;
    const agent = getAgent(this.ctx, name);
    if (!agent.enabled || !agent.triggers.some((t) => 'inbox' in t)) return;
    const { db } = this.ctx;
    // One waiting inbox job reads every unread message; no need to queue another.
    if (db.prepare("SELECT 1 FROM jobs WHERE agent = ? AND status = 'queued' AND trigger_type = 'inbox'").get(name)) return;

    if (m.from.startsWith('agent:')) {
      const g = agent.guardrails ?? {};
      const blocked = this.guardrailHit(name, m.hop, g);
      if (blocked) {
        sendMessage(this.ctx, {
          from: 'system',
          to: 'human',
          type: 'info',
          title: `${name} was not woken by ${m.from.slice(6)}`,
          body: `${blocked}. The message waits in ${name}'s inbox for its next regular run.\n\nMessage: ${m.title || m.body.slice(0, 200)}`,
        });
        return;
      }
    }
    this.ctx.runner!.enqueue(name, 'inbox', { detail: `${m.id} from ${m.from}`, hop: m.hop });
  }

  guardrailHit(agent: string, hop: number, g: { rate_per_hour?: number; cooldown_seconds?: number; hop_limit?: number }): string | null {
    if (g.hop_limit !== undefined && g.hop_limit !== null && hop > g.hop_limit)
      return `hop limit reached (chain depth ${hop} > ${g.hop_limit})`;
    const { db } = this.ctx;
    const agentTriggered = "trigger_type = 'inbox' AND trigger_detail LIKE '% from agent:%'";
    if (g.rate_per_hour !== undefined && g.rate_per_hour !== null) {
      const since = new Date(Date.now() - 3600_000).toISOString();
      const n = Number(
        (db.prepare(`SELECT COUNT(*) n FROM jobs WHERE agent = ? AND ${agentTriggered} AND created > ?`).get(agent, since) as Row).n,
      );
      if (n >= g.rate_per_hour) return `rate limit reached (${n} agent-triggered jobs in the last hour, limit ${g.rate_per_hour})`;
    }
    if (g.cooldown_seconds) {
      const last = db.prepare(`SELECT created FROM jobs WHERE agent = ? AND ${agentTriggered} ORDER BY created DESC LIMIT 1`).get(agent) as
        | Row
        | undefined;
      if (last && Date.now() - new Date(last.created as string).getTime() < g.cooldown_seconds * 1000)
        return `cooldown of ${g.cooldown_seconds}s since the last agent-triggered job`;
    }
    return null;
  }

  /** Upcoming cron and delay fires for an agent, and its next dream, for the UI. */
  upcoming(agent: string): Array<{ type: string; at: string; cron?: string }> {
    const cfg = dreamSettings(this.ctx);
    const a = this.ctx.db.prepare('SELECT enabled, dreaming FROM agents WHERE name = ?').get(agent) as Row | undefined;
    let dream: Array<{ type: string; at: string; cron: string }> = [];
    if (cfg.enabled && a?.enabled && a.dreaming) {
      try {
        const at = nextCron(cfg.cron);
        if (at) dream = [{ type: 'dream', at, cron: cfg.cron }];
      } catch {
        // An invalid schedule shows in Settings.
      }
    }
    return [
      ...(
        this.ctx.db
          .prepare(
            "SELECT type, cron, next_fire FROM triggers WHERE agent = ? AND type IN ('cron','delay') AND next_fire IS NOT NULL ORDER BY next_fire",
          )
          .all(agent) as Row[]
      ).map((t) => ({ type: t.type as string, at: t.next_fire as string, ...(t.cron ? { cron: t.cron as string } : {}) })),
      ...dream,
    ].sort((x, y) => x.at.localeCompare(y.at));
  }
}

function latest(a: string, b: string | null): string {
  return b && b > a ? b : a;
}
