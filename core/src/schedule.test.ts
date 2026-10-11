import { describe, expect, it } from 'vite-plus/test';
import { openDb } from './db/index.ts';
import { schedule } from './schedule.ts';

describe('schedule', () => {
  it('expands cron triggers over the window, includes delays, and marks disabled agents', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-10-10T10:00:00Z');
    const iso = (h: number) => new Date(now.getTime() + h * 3_600_000).toISOString();
    db.prepare("INSERT INTO agents (name, enabled, created, updated) VALUES ('a', 1, ?, ?), ('b', 0, ?, ?)").run(iso(0), iso(0), iso(0), iso(0));
    const trig = db.prepare('INSERT INTO triggers (id, agent, type, cron, next_fire, created) VALUES (?, ?, ?, ?, ?, ?)');
    trig.run('t1', 'a', 'cron', '0 */6 * * *', iso(-1), iso(0)); // overdue: fires now, then every 6 hours
    trig.run('t2', 'b', 'cron', '0 12 * * *', iso(2), iso(0));
    trig.run('t3', 'a', 'delay', null, iso(30), iso(0)); // beyond the window
    db.prepare(
      "INSERT INTO jobs (id, agent, trigger_type, status, created, started, ended) VALUES ('j', 'a', 'cron', 'finished', ?, ?, ?)",
    ).run(iso(-5), iso(-5), iso(-4.5));

    const s = schedule(db, 24, now);
    const a = s.runs.filter((r) => r.agent === 'a');
    expect(a[0]!.at).toBe(now.toISOString());
    expect(a.length).toBe(5); // the overdue fire now, then the 6-hourly slots up to 24 hours on
    expect(a.every((r) => r.type === 'cron')).toBe(true);
    const b = s.runs.filter((r) => r.agent === 'b');
    expect(b.length).toBeGreaterThan(0);
    expect(b.every((r) => !r.enabled)).toBe(true);
    expect(s.agents).toEqual(['a', 'b']);
    expect(Math.round(s.duration_seconds.a!)).toBe(1800);
  });

  it('covers the whole window for an every-minute schedule', () => {
    const db = openDb(':memory:');
    const now = new Date('2026-10-10T10:00:00Z');
    db.prepare("INSERT INTO agents (name, created, updated) VALUES ('m', ?, ?)").run(now.toISOString(), now.toISOString());
    db.prepare("INSERT INTO triggers (id, agent, type, cron, next_fire, created) VALUES ('t', 'm', 'cron', '* * * * *', ?, ?)").run(now.toISOString(), now.toISOString());
    const runs = schedule(db, 24, now).runs;
    expect(runs.length).toBe(24 * 60 + 1);
    expect(runs.at(-1)!.at).toBe(new Date(now.getTime() + 24 * 3_600_000).toISOString());
  });
});
