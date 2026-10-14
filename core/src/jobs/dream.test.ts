import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { defaultSettings } from '../config.ts';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import type { Job } from '../store.ts';
import { backupFile } from './dream.ts';

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
const steps = (agent: string, list: unknown[]) => {
  mkdirSync(join(dir, 'agents', agent), { recursive: true });
  writeFileSync(join(dir, 'agents', agent, 'steps.json'), JSON.stringify(list));
};
const jobs = (agent: string) => api<Job[]>(`/api/jobs?agent=${agent}`);
const settle = async (agent: string, n: number, ms = 20_000): Promise<Job[]> => {
  const end = Date.now() + ms;
  for (;;) {
    const js = await jobs(agent);
    if (js.length >= n && js.every((j) => !['queued', 'running'].includes(j.status))) return js;
    if (Date.now() > end) throw new Error(`${agent}: ${JSON.stringify(js.map((j) => [j.trigger_type, j.status]))}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};
const agent = (name: string, extra: Record<string, unknown> = {}) =>
  api('/api/agents', { body: { name, briefing: `${name} briefing`, guardrails: {}, ...extra } });
const longAgo = (name: string) => ctx.db.prepare("UPDATE agents SET last_dream = '2000-01-01T00:00:00.000Z' WHERE name = ?").run(name);
const ws = (agent: string, path: string) => join(dir, 'agents', agent, path);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-dream-'));
  const s = defaultSettings();
  s.harnesses['claude-code'] = { command: process.execPath, args: [fake] };
  s.defaults.models = ['test-model'];
  writeFileSync(join(dir, 'settings.yaml'), YAML.stringify(s));
  process.env.YAHO_TICK_MS = '3600000';
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  delete process.env.YAHO_TICK_MS;
  rmSync(dir, { recursive: true, force: true });
});

describe('dreaming', () => {
  it('dreams after a day with work: its own prompt, a database backup, no briefing rewrites, and undo', async () => {
    await agent('dreamer');
    steps('dreamer', [
      { cmd: 'mkdir -p memory && echo "Acme pays late" > memory/acme.md && echo "Acme pays late (again)" > memory/acme2.md' },
      {
        cmd: `node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('agent.db');d.exec('CREATE TABLE leads (n TEXT); INSERT INTO leads VALUES (1),(1),(2)')"`,
      },
      { cmd: 'yaho finish --summary "worked"' },
    ]);
    await api('/api/agents/dreamer/run', { method: 'POST' });
    await settle('dreamer', 1);

    steps('dreamer', [
      { cmd: 'cat memory/acme.md memory/acme2.md > memory/acme-all.md && rm memory/acme2.md memory/acme.md' },
      {
        cmd: `node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('agent.db');d.exec('DELETE FROM leads WHERE rowid = 2')"`,
      },
      { cmd: 'echo "new" | yaho briefing update', stdin: '' },
      { cmd: 'yaho send --to agent:dreamer --body hi' },
      { cmd: 'yaho send --to human --type info --title "Dream suggestion: x" --body "y"' },
      { cmd: 'yaho finish --summary "merged acme notes, removed a duplicate lead"' },
    ]);
    longAgo('dreamer');
    ctx.scheduler!.tick();
    const js = await settle('dreamer', 2);
    const dream = js.find((j) => j.trigger_type === 'dream')!;
    expect(dream).toMatchObject({ status: 'finished', summary: 'merged acme notes, removed a duplicate lead' });

    const events = await api<Array<{ kind: string; data: Record<string, unknown> }>>(`/api/jobs/${dream.id}/events`);
    const prompt = events.find((e) => e.kind === 'prompt')!.data as { system: string; user: string };
    expect(prompt.system).toContain('You are dreaming');
    expect(prompt.system).toContain('dreamer briefing');
    expect(prompt.user).toContain('worked');
    expect(prompt.user).toContain('`leads`: 3 rows');
    expect(JSON.stringify(events)).toMatch(/a dream cannot rewrite the briefing/);
    expect(JSON.stringify(events)).toMatch(/a dream can only message the human/);
    expect(events.find((e) => e.kind === 'dream')!.data).toEqual({ tables: [{ name: 'leads', rows: 2 }] });
    expect((await api<{ briefing: string }>('/api/agents/dreamer')).briefing).toBe('dreamer briefing');
    expect(existsSync(backupFile(ctx, 'dreamer', dream.id))).toBe(true);

    const done = await api<Job>(`/api/jobs/${dream.id}`);
    await ctx.versions!.settle('dreamer');
    const after = await api<Job>(`/api/jobs/${dream.id}`);
    expect(after.commit_sha ?? done.commit_sha).toMatch(/^[0-9a-f]{40}$/);
    const detail = await api<{ changes: Array<{ path: string; status: string }> }>(`/api/agents/dreamer/versions/${after.commit_sha}`);
    expect(
      detail.changes
        .filter((c) => c.path.startsWith('memory/'))
        .map((c) => `${c.status} ${c.path}`)
        .sort(),
    ).toEqual(['added memory/acme-all.md', 'deleted memory/acme.md', 'deleted memory/acme2.md']);

    await api(`/api/jobs/${dream.id}/undo`, { method: 'POST' });
    expect(readFileSync(ws('dreamer', 'memory/acme.md'), 'utf8')).toBe('Acme pays late\n');
    expect(existsSync(ws('dreamer', 'memory/acme-all.md'))).toBe(false);
    const db = new DatabaseSync(ws('dreamer', 'agent.db'), { readOnly: true });
    expect((db.prepare('SELECT COUNT(*) n FROM leads').get() as { n: number }).n).toBe(3);
    db.close();
  });

  it('skips a night with no new work, and agents that opted out', async () => {
    await agent('idle');
    longAgo('idle');
    await agent('optout', { dreaming: false });
    steps('optout', [{ cmd: 'yaho finish' }]);
    await api('/api/agents/optout/run', { method: 'POST' });
    await settle('optout', 1);
    longAgo('optout');
    ctx.scheduler!.dreams();
    await new Promise((r) => setTimeout(r, 300));
    expect(await jobs('idle')).toHaveLength(0);
    expect(await jobs('optout')).toHaveLength(1);
    const last = ctx.db.prepare("SELECT last_dream FROM agents WHERE name = 'idle'").get() as { last_dream: string };
    expect(new Date(last.last_dream).getTime()).toBeGreaterThan(Date.now() - 5000);
    expect((await api<{ dreaming?: boolean }>('/api/agents/optout')).dreaming).toBe(false);
  });

  it("holds the agent's other jobs until its dream ends", async () => {
    await agent('busy', { max_parallel: 3 });
    steps('busy', [{ cmd: 'yaho finish' }]);
    await api('/api/agents/busy/run', { method: 'POST' });
    await settle('busy', 1);
    steps('busy', [{ sleep_ms: 800 }, { cmd: 'yaho finish' }]);
    longAgo('busy');
    ctx.scheduler!.dreams();
    await new Promise((r) => setTimeout(r, 200));
    const run = await api<Job>('/api/agents/busy/run', { method: 'POST' });
    expect((await api<Job>(`/api/jobs/${run.id}`)).status).toBe('queued');
    const js = await settle('busy', 3);
    const dream = js.find((j) => j.trigger_type === 'dream')!;
    const later = js.find((j) => j.id === run.id)!;
    expect(new Date(later.started!).getTime()).toBeGreaterThanOrEqual(new Date(dream.ended!).getTime());
  });
});
