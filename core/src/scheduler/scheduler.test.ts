import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { defaultSettings } from '../config.ts';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import type { Job, Message } from '../store.ts';

const fake = fileURLToPath(new URL('../../test/fake-claude.mjs', import.meta.url));
let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;

async function start() {
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
}

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
const script = (agent: string, steps: unknown[], file = 'steps.json') => {
  mkdirSync(join(dir, 'agents', agent), { recursive: true });
  writeFileSync(join(dir, 'agents', agent, file), JSON.stringify(steps));
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
  api('/api/agents', { body: { name, briefing: name, guardrails: {}, ...extra } });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-sched-'));
  const s = defaultSettings();
  s.harnesses['claude-code'] = { command: process.execPath, args: [fake] };
  s.defaults.models = ['test-model'];
  writeFileSync(join(dir, 'settings.yaml'), YAML.stringify(s));
  process.env.YAHO_TICK_MS = '3600000'; // tests drive the scheduler by hand
  await start();
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  delete process.env.YAHO_TICK_MS;
  rmSync(dir, { recursive: true, force: true });
});

describe('scheduler', () => {
  it('fires a due cron trigger once and reschedules it; disabled agents are skipped', async () => {
    await agent('cronny', { triggers: [{ cron: '*/1 * * * *' }] });
    script('cronny', [{ cmd: 'yaho finish' }]);
    const a = await api<{ upcoming: Array<{ at: string }> }>('/api/agents/cronny');
    expect(new Date(a.upcoming[0]!.at).getTime()).toBeGreaterThan(Date.now());
    ctx.db.prepare("UPDATE triggers SET next_fire = '2000-01-01T00:00:00.000Z' WHERE agent = 'cronny'").run();
    ctx.scheduler!.tick();
    const js = await settle('cronny', 1);
    expect(js).toHaveLength(1);
    expect(js[0]).toMatchObject({ trigger_type: 'cron', status: 'finished' });
    const next = (ctx.db.prepare("SELECT next_fire FROM triggers WHERE agent = 'cronny'").get() as { next_fire: string }).next_fire;
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());

    await api('/api/agents/cronny', { method: 'PATCH', body: { enabled: false } });
    ctx.db.prepare("UPDATE triggers SET next_fire = '2000-01-01T00:00:00.000Z' WHERE agent = 'cronny'").run();
    ctx.scheduler!.tick();
    await new Promise((r) => setTimeout(r, 300));
    expect(await jobs('cronny')).toHaveLength(1);
  });

  it('starts a job when a message arrives for an inbox-triggered agent', async () => {
    await agent('listener', { triggers: [{ inbox: true }] });
    script('listener', [{ cmd: 'yaho inbox list' }, { cmd: 'yaho finish' }]);
    await api('/api/messages', { body: { to: 'agent:listener', body: 'wake up' } });
    const js = await settle('listener', 1);
    expect(js[0]).toMatchObject({ trigger_type: 'inbox', status: 'finished' });
  });

  it('queues a second run over max_parallel and runs them one after the other', async () => {
    await agent('serial', { max_parallel: 1 });
    script('serial', [{ sleep_ms: 800 }, { cmd: 'yaho finish' }]);
    const a = await api<Job>('/api/agents/serial/run', { method: 'POST' });
    const b = await api<Job>('/api/agents/serial/run', { method: 'POST' });
    expect((await api<Job>(`/api/jobs/${b.id}`)).status).toBe('queued');
    await settle('serial', 2);
    const ja = await api<Job>(`/api/jobs/${a.id}`);
    const jb = await api<Job>(`/api/jobs/${b.id}`);
    expect(new Date(jb.started!).getTime()).toBeGreaterThanOrEqual(new Date(ja.ended!).getTime());
  });

  it('sleep ends the job and a delay trigger resumes the same session', async () => {
    await agent('napper');
    script('napper', [{ cmd: 'yaho sleep 1s' }]);
    script('napper', [{ cmd: 'yaho finish --summary woke' }], 'steps-resume.json');
    const first = await api<Job>('/api/agents/napper/run', { method: 'POST' });
    await settle('napper', 1);
    expect((await api<Job>(`/api/jobs/${first.id}`)).status).toBe('sleeping');
    await new Promise((r) => setTimeout(r, 1100));
    ctx.scheduler!.tick();
    const js = await settle('napper', 2);
    const second = js.find((j) => j.id !== first.id)!;
    expect(second).toMatchObject({
      trigger_type: 'delay',
      status: 'finished',
      session_id: (await api<Job>(`/api/jobs/${first.id}`)).session_id,
    });
    const events = await api<Array<{ kind: string; data: { text?: string } }>>(`/api/jobs/${second.id}/events`);
    expect(events.some((e) => e.kind === 'text' && e.data.text?.startsWith('resumed fake-'))).toBe(true);
  });

  it('stops agent ping-pong at the hop limit and tells the human', async () => {
    await agent('ping', { triggers: [{ inbox: true }], guardrails: { hop_limit: 2 } });
    await agent('pong', { triggers: [{ inbox: true }], guardrails: { hop_limit: 2 } });
    script('ping', [{ cmd: 'yaho send --to agent:pong --body ping' }, { cmd: 'yaho finish' }]);
    script('pong', [{ cmd: 'yaho send --to agent:ping --body pong' }, { cmd: 'yaho finish' }]);
    await api('/api/messages', { body: { to: 'agent:ping', body: 'start' } });
    const end = Date.now() + 20_000;
    let note: Message | undefined;
    while (!note && Date.now() < end) {
      note = (await api<Message[]>('/api/messages?to=human')).find((m) => m.from === 'system' && m.title.includes('was not woken'));
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(note?.body).toContain('hop limit');
    await settle('ping', 2);
    await settle('pong', 1);
    expect((await jobs('ping')).length + (await jobs('pong')).length).toBe(3);
  });

  it('a core restart requeues a running job and resumes its session', async () => {
    await agent('survivor');
    script('survivor', [{ sleep_ms: 4000 }, { cmd: 'yaho finish' }]);
    script('survivor', [{ cmd: 'yaho finish --summary survived' }], 'steps-resume.json');
    const job = await api<Job>('/api/agents/survivor/run', { method: 'POST' });
    const end = Date.now() + 5000;
    while ((await api<Job>(`/api/jobs/${job.id}`)).status !== 'running' && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 500)); // let the harness report its session id
    await close();
    await start();
    const js = await settle('survivor', 1);
    expect(js).toHaveLength(1);
    expect(js[0]).toMatchObject({ id: job.id, status: 'finished', trigger_type: 'continue' });
  });
});
