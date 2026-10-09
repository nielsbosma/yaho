import { describe, expect, it } from 'vite-plus/test';
import { openDb } from './db/index.ts';
import { stats } from './stats.ts';

describe('stats', () => {
  it('counts jobs, cost and failures in the range, and fills quiet days', () => {
    const db = openDb(':memory:');
    const now = new Date();
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
    db.prepare("INSERT INTO agents (name, created, updated) VALUES ('a', ?, ?), ('b', ?, ?)").run(ago(1), ago(1), ago(1), ago(1));
    const job = db.prepare(
      'INSERT INTO jobs (id, agent, trigger_type, status, model, cost_usd, created, started, ended) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    job.run('j1', 'a', 'cron', 'finished', 'm1', 0.5, ago(2), ago(2), ago(1.5));
    job.run('j2', 'a', 'manual', 'failed', 'm1', 0.25, ago(3), ago(3), ago(3));
    job.run('j3', 'b', 'inbox', 'finished', 'm2', 1, ago(30), ago(30), ago(29));
    job.run('old', 'b', 'cron', 'finished', 'm2', 9, ago(24 * 10), null, null);

    const s = stats(db, 7, now);
    expect(s.totals).toMatchObject({ jobs: 3, finished: 2, failed: 1, cost_usd: 1.75, agents: 2, active_agents: 2 });
    expect(s.previous.jobs).toBe(1);
    expect(s.daily).toHaveLength(7);
    expect(s.daily.reduce((t, d) => t + d.jobs, 0)).toBe(3);
    expect(s.by_agent.map((a) => a.agent)).toEqual(['b', 'a']);
    expect(s.by_model[0]).toEqual({ model: 'm2', jobs: 1, cost_usd: 1 });
    expect(s.failures.map((f) => f.id)).toEqual(['j2']);
  });
});
