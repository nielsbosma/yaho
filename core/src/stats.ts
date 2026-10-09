import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);

export interface Stats {
  days: number;
  totals: {
    jobs: number;
    finished: number;
    failed: number;
    cost_usd: number;
    avg_cost_usd: number;
    avg_seconds: number;
    messages: number;
    unread: number;
    artifacts: number;
    agents: number;
    active_agents: number;
  };
  /** The same totals for the period before, for the trend arrows. */
  previous: { jobs: number; cost_usd: number; failed: number };
  daily: Array<{ day: string; jobs: number; failed: number; cost_usd: number }>;
  by_agent: Array<{ agent: string; jobs: number; failed: number; cost_usd: number; avg_seconds: number; last: string | null }>;
  by_model: Array<{ model: string; jobs: number; cost_usd: number }>;
  by_trigger: Array<{ trigger: string; jobs: number }>;
  by_status: Array<{ status: string; jobs: number }>;
  /** Jobs per weekday (0 = Sunday) and hour, in local time. */
  heatmap: Array<{ dow: number; hour: number; jobs: number }>;
  artifact_kinds: Array<{ kind: string; count: number }>;
  failures: Array<{ id: string; agent: string; status: string; reason: string | null; created: string }>;
}

const FAILED = "status IN ('failed','budget_exhausted','stopped')";
const DURATION = "(julianday(ended) - julianday(started)) * 86400";

/** Activity over the last `days` days, bucketed in local time. */
export function stats(db: DatabaseSync, days: number, now = new Date()): Stats {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const before = new Date(now.getTime() - 2 * days * 86_400_000).toISOString();
  const all = (sql: string, ...p: Array<string | number>) => db.prepare(sql).all(...p) as Row[];
  const one = (sql: string, ...p: Array<string | number>) => (db.prepare(sql).get(...p) ?? {}) as Row;

  const t = one(
    `SELECT COUNT(*) jobs, SUM(status = 'finished') finished, SUM(${FAILED}) failed, COALESCE(SUM(cost_usd),0) cost,
            AVG(CASE WHEN ended IS NOT NULL AND started IS NOT NULL THEN ${DURATION} END) secs, COUNT(DISTINCT agent) active
       FROM jobs WHERE created >= ?`,
    since,
  );
  const prev = one(
    `SELECT COUNT(*) jobs, COALESCE(SUM(cost_usd),0) cost, SUM(${FAILED}) failed FROM jobs WHERE created >= ? AND created < ?`,
    before,
    since,
  );

  // Every day in the range, also the quiet ones.
  const byDay = new Map(
    all(
      `SELECT date(created,'localtime') day, COUNT(*) jobs, SUM(${FAILED}) failed, COALESCE(SUM(cost_usd),0) cost
         FROM jobs WHERE created >= ? GROUP BY day`,
      since,
    ).map((r) => [String(r.day), r]),
  );
  const daily: Stats['daily'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const r = byDay.get(day);
    daily.push({ day, jobs: n(r?.jobs), failed: n(r?.failed), cost_usd: n(r?.cost) });
  }

  const jobs = n(t.jobs);
  const cost = n(t.cost);
  return {
    days,
    totals: {
      jobs,
      finished: n(t.finished),
      failed: n(t.failed),
      cost_usd: cost,
      avg_cost_usd: jobs ? cost / jobs : 0,
      avg_seconds: n(t.secs),
      messages: n(one("SELECT COUNT(*) c FROM messages WHERE from_addr LIKE 'agent:%' AND created >= ?", since).c),
      unread: n(one("SELECT COUNT(*) c FROM messages WHERE to_addr = 'human' AND read = 0").c),
      artifacts: n(one('SELECT COUNT(*) c FROM artifacts WHERE created >= ?', since).c),
      agents: n(one('SELECT COUNT(*) c FROM agents').c),
      active_agents: n(t.active),
    },
    previous: { jobs: n(prev.jobs), cost_usd: n(prev.cost), failed: n(prev.failed) },
    daily,
    by_agent: all(
      `SELECT agent, COUNT(*) jobs, SUM(${FAILED}) failed, COALESCE(SUM(cost_usd),0) cost,
              AVG(CASE WHEN ended IS NOT NULL AND started IS NOT NULL THEN ${DURATION} END) secs, MAX(created) last
         FROM jobs WHERE created >= ? GROUP BY agent ORDER BY cost DESC, jobs DESC`,
      since,
    ).map((r) => ({
      agent: String(r.agent),
      jobs: n(r.jobs),
      failed: n(r.failed),
      cost_usd: n(r.cost),
      avg_seconds: n(r.secs),
      last: (r.last as string) ?? null,
    })),
    by_model: all(
      `SELECT COALESCE(model,'unknown') model, COUNT(*) jobs, COALESCE(SUM(cost_usd),0) cost
         FROM jobs WHERE created >= ? GROUP BY 1 ORDER BY cost DESC`,
      since,
    ).map((r) => ({ model: String(r.model), jobs: n(r.jobs), cost_usd: n(r.cost) })),
    by_trigger: all('SELECT trigger_type t, COUNT(*) jobs FROM jobs WHERE created >= ? GROUP BY 1 ORDER BY jobs DESC', since).map(
      (r) => ({ trigger: String(r.t), jobs: n(r.jobs) }),
    ),
    by_status: all('SELECT status, COUNT(*) jobs FROM jobs WHERE created >= ? GROUP BY 1 ORDER BY jobs DESC', since).map((r) => ({
      status: String(r.status),
      jobs: n(r.jobs),
    })),
    heatmap: all(
      `SELECT CAST(strftime('%w',created,'localtime') AS INTEGER) dow, CAST(strftime('%H',created,'localtime') AS INTEGER) hour, COUNT(*) jobs
         FROM jobs WHERE created >= ? GROUP BY 1, 2`,
      since,
    ).map((r) => ({ dow: n(r.dow), hour: n(r.hour), jobs: n(r.jobs) })),
    artifact_kinds: all('SELECT kind, COUNT(*) c FROM artifacts WHERE created >= ? GROUP BY 1 ORDER BY c DESC', since).map((r) => ({
      kind: String(r.kind),
      count: n(r.c),
    })),
    failures: all(
      `SELECT id, agent, status, reason, created FROM jobs WHERE created >= ? AND ${FAILED} ORDER BY created DESC LIMIT 5`,
      since,
    ).map((r) => ({
      id: String(r.id),
      agent: String(r.agent),
      status: String(r.status),
      reason: (r.reason as string) ?? null,
      created: String(r.created),
    })),
  };
}
