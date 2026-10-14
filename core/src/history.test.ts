import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vite-plus/test';
import { defaultSettings } from './config.ts';
import { Bus, type Ctx } from './context.ts';
import { migrate, openDb } from './db/index.ts';
import { migrations } from './db/migrations.ts';
import { indexJob, indexMissing, searchHistory, showHistory, writeRecap } from './history.ts';
import { addJobEvent, getJob } from './store.ts';

function setup(): Ctx {
  const db = openDb(':memory:');
  const t = new Date().toISOString();
  db.prepare("INSERT INTO agents (name, models, created, updated) VALUES ('a', '[\"big\",\"small\"]', ?, ?), ('b', '[]', ?, ?)").run(
    t,
    t,
    t,
    t,
  );
  return { db, settings: defaultSettings(), bus: new Bus() } as unknown as Ctx;
}

function job(
  ctx: Ctx,
  id: string,
  o: { agent?: string; created?: string; detail?: string; said?: string[]; ended?: boolean; session?: string } = {},
) {
  const created = o.created ?? new Date().toISOString();
  ctx.db
    .prepare('INSERT INTO jobs (id, agent, session_id, trigger_type, trigger_detail, status, created, ended) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, o.agent ?? 'a', o.session ?? null, 'manual', o.detail ?? null, 'finished', created, o.ended === false ? null : created);
  for (const text of o.said ?? []) addJobEvent(ctx, id, 'text', { kind: 'text', text });
}

describe('history', () => {
  it("finds an agent's own jobs by what was said, falling back to any word", () => {
    const ctx = setup();
    job(ctx, 'j1', { said: ['Invoiced Acme for the October retainer'], created: '2026-01-01T00:00:00Z' });
    job(ctx, 'j2', { said: ['Wrote the newsletter about invoicing'] });
    job(ctx, 'j3', { agent: 'b', said: ['Acme invoice for b'] });
    for (const id of ['j1', 'j2', 'j3']) indexJob(ctx, id);

    expect(searchHistory(ctx, 'a', 'acme invoice').map((h) => h.job)).toEqual(['j1']);
    expect(
      searchHistory(ctx, 'a', 'acme newsletter')
        .map((h) => h.job)
        .sort(),
    ).toEqual(['j1', 'j2']);
    expect(searchHistory(ctx, 'a', 'acme', { since: '2026-06-01T00:00:00Z' })).toEqual([]);
    expect(searchHistory(ctx, 'a', 'Acme')[0]!.snippet).toContain('«Acme»');
    expect(searchHistory(ctx, 'a', 'retainer" OR *')).toHaveLength(1);
    expect(() => searchHistory(ctx, 'a', '  ')).toThrow(/search for some words/);
  });

  it("shows only the agent's own jobs, and forgets deleted ones", () => {
    const ctx = setup();
    job(ctx, 'j1', { detail: 'from the human', said: ['first', 'second'] });
    indexJob(ctx, 'j1', 'did it');
    expect(showHistory(ctx, 'a', 'j1')).toMatchObject({ trigger_detail: 'from the human', messages: ['first', 'second'] });
    expect(() => showHistory(ctx, 'b', 'j1')).toThrow(/not yours/);
    expect(searchHistory(ctx, 'a', 'did')).toHaveLength(1);
    indexJob(ctx, 'j1', 'did it again');
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM job_search').get()).toEqual({ n: 1 });
    ctx.db.prepare("DELETE FROM jobs WHERE id = 'j1'").run();
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM job_search').get()).toEqual({ n: 0 });
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM job_search_rows').get()).toEqual({ n: 0 });
  });

  it('keeps the rows indexed before the side table, by rowid', () => {
    const db = new DatabaseSync(':memory:');
    migrations.slice(0, 14).forEach((m) => db.exec(m));
    db.exec(`PRAGMA user_version = 14`);
    const t = new Date().toISOString();
    db.prepare("INSERT INTO agents (name, created, updated) VALUES ('a', ?, ?)").run(t, t);
    db.prepare("INSERT INTO jobs (id, agent, trigger_type, status, created) VALUES ('old', 'a', 'manual', 'finished', ?)").run(t);
    db.prepare("INSERT INTO job_search (job, agent, trigger, messages, summary, recap) VALUES ('old', 'a', '', 'hello', '', '')").run();
    migrate(db);
    expect(db.prepare('SELECT job FROM job_search_rows').all()).toEqual([{ job: 'old' }]);
    db.prepare("DELETE FROM jobs WHERE id = 'old'").run();
    expect(db.prepare('SELECT COUNT(*) n FROM job_search').get()).toEqual({ n: 0 });
  });

  it('indexes ended jobs from before the index, the last of a session with its summary', () => {
    const ctx = setup();
    const t = new Date().toISOString();
    ctx.db.prepare("INSERT INTO sessions (id, agent, summary, created, updated) VALUES ('s1', 'a', 'shipped the widget', ?, ?)").run(t, t);
    job(ctx, 'early', { session: 's1', created: '2026-01-01T00:00:00Z', said: ['started'] });
    job(ctx, 'late', { session: 's1', created: '2026-01-02T00:00:00Z', said: ['done'] });
    job(ctx, 'running', { ended: false, said: ['busy'] });
    expect(indexMissing(ctx)).toBe(2);
    expect(searchHistory(ctx, 'a', 'widget').map((h) => h.job)).toEqual(['late']);
    expect(indexMissing(ctx)).toBe(0);
  });

  it("writes a recap with the agent's last model and makes it searchable", async () => {
    const ctx = setup();
    let asked: { model?: string; messages?: Array<{ content: string }> } = {};
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        asked = JSON.parse(body);
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Sent the Q3 report to Dana.' }, finish_reason: 'stop' }] }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    ctx.settings.providers = [
      { id: 'litellm', kind: 'litellm', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, api_key: 'k' },
    ];
    try {
      job(ctx, 'j1', { said: ['Emailing the quarterly numbers'] });
      indexJob(ctx, 'j1');
      await writeRecap(ctx, 'j1');
      expect(asked.model).toBe('small');
      expect(asked.messages?.[1]?.content).toContain('quarterly numbers');
      expect(getJob(ctx, 'j1').recap).toBe('Sent the Q3 report to Dana.');
      expect(searchHistory(ctx, 'a', 'Dana')[0]).toMatchObject({ job: 'j1', recap: 'Sent the Q3 report to Dana.' });

      ctx.settings.history = { recaps: false };
      job(ctx, 'j2', { said: ['more'] });
      await writeRecap(ctx, 'j2');
      expect(getJob(ctx, 'j2').recap).toBeNull();
    } finally {
      server.close();
    }
  });
});
