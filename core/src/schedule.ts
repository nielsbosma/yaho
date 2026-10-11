import type { DatabaseSync } from 'node:sqlite';
import { Cron } from 'croner';

type Row = Record<string, unknown>;

export interface PlannedRun {
  agent: string;
  type: 'cron' | 'delay';
  at: string;
  cron?: string;
  /** A disabled agent's cron slots pass without a job; shown so the human sees what is switched off. */
  enabled: boolean;
}

/**
 * Every cron and delay fire in the next `hours`, per agent, for the schedule timeline. Cron fires are expanded from
 * the trigger's next_fire on; an overdue next_fire (Yaho was off) counts as now, as the scheduler fires it at once.
 * Typical job length per agent (median of its last 20 finished jobs) lets the UI draw runs as bars.
 */
export function schedule(db: DatabaseSync, hours = 24, now = new Date()) {
  const end = new Date(now.getTime() + hours * 3_600_000);
  const runs: PlannedRun[] = [];
  const triggers = db
    .prepare(
      `SELECT t.agent, t.type, t.cron, t.next_fire, a.enabled FROM triggers t JOIN agents a ON a.name = t.agent
       WHERE t.type IN ('cron','delay') AND t.next_fire IS NOT NULL`,
    )
    .all() as Row[];
  for (const t of triggers) {
    const enabled = !!t.enabled;
    const agent = t.agent as string;
    let at = new Date(Math.max(new Date(t.next_fire as string).getTime(), now.getTime()));
    if (t.type === 'delay') {
      if (at <= end) runs.push({ agent, type: 'delay', at: at.toISOString(), enabled });
      continue;
    }
    const cron = t.cron as string;
    const c = new Cron(cron, { paused: true });
    // Cron's finest step is a minute (seconds fields aside), so this bound never cuts a schedule short.
    for (let i = 0, max = hours * 60 + 1; at <= end && i < max; i++) {
      runs.push({ agent, type: 'cron', at: at.toISOString(), cron, enabled });
      const next = c.nextRun(at);
      if (!next) break;
      at = next;
    }
  }
  runs.sort((a, b) => a.at.localeCompare(b.at));

  const agents = [...new Set(runs.map((r) => r.agent))].sort();
  const duration: Record<string, number> = {};
  for (const agent of agents) {
    const secs = (
      db
        .prepare(
          `SELECT (julianday(ended) - julianday(started)) * 86400 AS s FROM jobs
           WHERE agent = ? AND status = 'finished' AND started IS NOT NULL AND ended IS NOT NULL ORDER BY created DESC LIMIT 20`,
        )
        .all(agent) as Row[]
    )
      .map((r) => Number(r.s))
      .sort((a, b) => a - b);
    duration[agent] = secs.length ? secs[Math.floor(secs.length / 2)]! : 0;
  }
  return { from: now.toISOString(), to: end.toISOString(), hours, runs, agents, duration_seconds: duration };
}
