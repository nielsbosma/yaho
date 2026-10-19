import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { defaultSettings } from '../config.ts';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import type { Job } from '../store.ts';

const fake = fileURLToPath(new URL('../../test/fake-claude.mjs', import.meta.url));
let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;

const api = async <T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
  const res = await fetch(`${ctx.apiUrl}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${ctx.apiToken}`, 'Content-Type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data as T;
};
const until = async (id: string, pred: (j: Job) => boolean) => {
  const end = Date.now() + 20_000;
  for (;;) {
    const j = await api<Job>(`/api/jobs/${id}`);
    if (pred(j)) return j;
    if (Date.now() > end) throw new Error(`job ${id}: ${j.status} ${j.reason}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const ended = (j: Job) => !['queued', 'running'].includes(j.status);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-budget-'));
  const s = defaultSettings();
  s.harnesses['claude-code'] = { command: process.execPath, args: [fake] };
  s.defaults.models = ['test-model'];
  s.global_spend_cap_usd = 0.0025;
  writeFileSync(join(dir, 'settings.yaml'), YAML.stringify(s));
  process.env.FAKE_COST = '0.001';
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  delete process.env.FAKE_COST;
  rmSync(dir, { recursive: true, force: true });
});

describe('budgets', () => {
  it('passes the remaining agent budget to the harness and records a budget stop', async () => {
    await api('/api/agents', { body: { name: 'thrifty', budget_usd: 0.5 } });
    mkdirSync(join(dir, 'agents', 'thrifty'), { recursive: true });
    // The fake prints its arguments; the budget flag must carry what is left.
    writeFileSync(join(dir, 'agents', 'thrifty', 'steps.json'), JSON.stringify([{ cmd: 'yaho budget' }]));
    const job = await api<Job>('/api/agents/thrifty/run', { method: 'POST' });
    const done = await until(job.id, ended);
    expect(done.status).toBe('finished');
    expect(done.cost_usd).toBeCloseTo(0.001);
    const prompt = (await api<Array<{ kind: string; data: Record<string, unknown> }>>(`/api/jobs/${job.id}/events`)).find(
      (e) => e.kind === 'prompt',
    );
    expect(prompt).toBeTruthy();
  });

  it('a raised budget lets a budget-stopped job continue in place', async () => {
    ctx.db.prepare("UPDATE jobs SET status = 'budget_exhausted', reason = 'test' WHERE agent = 'thrifty'").run();
    await api('/api/agents/thrifty', { method: 'PATCH', body: { budget_usd: 0.0005 } });
    const [j] = await api<Job[]>('/api/jobs?agent=thrifty');
    await expect(api(`/api/jobs/${j!.id}/continue`, { method: 'POST' })).rejects.toThrow(/raise thrifty's budget/);
    await api('/api/agents/thrifty', { method: 'PATCH', body: { budget_usd: 1 } });
    await api(`/api/jobs/${j!.id}/continue`, { method: 'POST' });
    const again = await until(j!.id, ended);
    expect(again).toMatchObject({ status: 'finished', trigger_type: 'continue' });
    expect(again.cost_usd).toBeCloseTo(0.002);
  });

  it('holds new jobs once the global spend cap is reached', async () => {
    await api('/api/agents', { body: { name: 'late', budget_usd: 5 } });
    const first = await api<Job>('/api/agents/late/run', { method: 'POST' });
    await until(first.id, ended); // total is now 0.003 >= 0.0025
    const second = await api<Job>('/api/agents/late/run', { method: 'POST' });
    const held = await until(second.id, (j) => j.reason === 'global spend cap reached');
    expect(held.status).toBe('queued');
    ctx.settings.global_spend_cap_usd = 10;
    ctx.runner!.pump();
    expect((await until(second.id, ended)).status).toBe('finished');
  });

  it('gives parallel jobs a share of the budget, not all of it each', async () => {
    await api('/api/agents', { body: { name: 'pair', budget_usd: 1, max_parallel: 2 } });
    mkdirSync(join(dir, 'agents', 'pair'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'pair', 'steps.json'), JSON.stringify([{ sleep_ms: 1500 }]));
    const first = await api<Job>('/api/agents/pair/run', { method: 'POST' });
    await until(first.id, (j) => j.status === 'running');
    const second = await api<Job>('/api/agents/pair/run', { method: 'POST' });
    await new Promise((r) => setTimeout(r, 500));
    // The first job holds the whole budget until it ends.
    expect((await api<Job>(`/api/jobs/${second.id}`)).status).toBe('queued');
    expect((await until(first.id, ended)).status).toBe('finished');
    expect((await until(second.id, ended)).status).toBe('finished');
  });

  it('counts only the current period for a budget that resets', async () => {
    await api('/api/agents', { body: { name: 'daily', budget_usd: 0.0015, budget_reset: 'daily' } });
    const first = await api<Job>('/api/agents/daily/run', { method: 'POST' });
    expect((await until(first.id, ended)).status).toBe('finished');
    // The second job gets only what is left, and is stopped once it spends that.
    const blocked = await api<Job>('/api/agents/daily/run', { method: 'POST' });
    expect((await until(blocked.id, ended)).status).toBe('budget_exhausted');
    const agents = await api<Array<{ name: string; spent_usd: number; budget_reset?: string }>>('/api/agents');
    expect(agents.find((a) => a.name === 'daily')).toMatchObject({ spent_usd: 0.002, budget_reset: 'daily' });

    // Yesterday's spend no longer counts.
    const yesterday = new Date(Date.now() - 36 * 3600_000).toISOString();
    ctx.db.prepare("UPDATE jobs SET created = ?, ended = ? WHERE agent = 'daily'").run(yesterday, yesterday);
    ctx.db.prepare("UPDATE job_events SET created = ? WHERE job IN (SELECT id FROM jobs WHERE agent = 'daily')").run(yesterday);
    expect((await api<Array<{ name: string; spent_usd: number }>>('/api/agents')).find((a) => a.name === 'daily')!.spent_usd).toBe(0);
    await new Promise((r) => setTimeout(r, 2100));
    const next = await api<Job>('/api/agents/daily/run', { method: 'POST' });
    expect((await until(next.id, ended)).status).toBe('finished');

    // A job that ran across midnight counts what it cost since then.
    ctx.db.prepare('UPDATE jobs SET ended = ? WHERE id = ?').run(new Date().toISOString(), first.id);
    ctx.db
      .prepare("INSERT INTO job_events (job, kind, data, created) VALUES (?, 'cost', ?, ?)")
      .run(first.id, JSON.stringify({ total_usd: 0.0004 }), yesterday);
    ctx.db
      .prepare("UPDATE job_events SET created = ? WHERE job = ? AND kind = 'cost' AND data NOT LIKE '%0.0004%'")
      .run(new Date().toISOString(), first.id);
    const spent = (await api<Array<{ name: string; spent_usd: number }>>('/api/agents')).find((a) => a.name === 'daily')!.spent_usd;
    expect(spent).toBeCloseTo(0.001 + 0.0006);

    await api('/api/agents/daily', { method: 'PATCH', body: { budget_reset: 'never' } });
    expect((await api<Array<{ name: string; spent_usd: number }>>('/api/agents')).find((a) => a.name === 'daily')!.spent_usd).toBeCloseTo(
      0.002,
    );
    await expect(api('/api/agents/daily', { method: 'PATCH', body: { budget_reset: 'weekly' } })).rejects.toThrow(/budget_reset/);
  });

  it('survives deleting an agent while its job runs', async () => {
    await api('/api/agents', { body: { name: 'doomed', budget_usd: 1 } });
    mkdirSync(join(dir, 'agents', 'doomed'), { recursive: true });
    writeFileSync(
      join(dir, 'agents', 'doomed', 'steps.json'),
      JSON.stringify([{ sleep_ms: 800 }, { cmd: 'echo late' }, { sleep_ms: 5000 }]),
    );
    const job = await api<Job>('/api/agents/doomed/run', { method: 'POST' });
    await until(job.id, (j) => j.status === 'running');
    await new Promise((r) => setTimeout(r, 300));
    await api('/api/agents/doomed', { method: 'DELETE' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(ctx.db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(job.id)).toBeUndefined();
    // The core is still up.
    expect(Array.isArray(await api('/api/agents'))).toBe(true);
  });
});
