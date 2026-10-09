import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** Steps the fake harness runs in the agent's workspace. */
const script = (agent: string, steps: Array<{ cmd?: string; stdin?: string; sleep_ms?: number }>, file = 'steps.json') => {
  mkdirSync(join(dir, 'agents', agent), { recursive: true });
  writeFileSync(join(dir, 'agents', agent, file), JSON.stringify(steps));
};

export async function waitFor(id: string, done = (j: Job) => !['queued', 'running'].includes(j.status), ms = 20_000): Promise<Job> {
  const end = Date.now() + ms;
  for (;;) {
    const j = await api<Job>(`/api/jobs/${id}`);
    if (done(j)) return j;
    if (Date.now() > end) throw new Error(`job ${id} still ${j.status}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const toolOutputs = async (job: string) =>
  (await api<Array<{ kind: string; data: { output?: string } }>>(`/api/jobs/${job}/events`))
    .filter((e) => e.kind === 'tool_result')
    .map((e) => e.data.output ?? '');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-agent-'));
  const s = defaultSettings();
  s.harnesses['claude-code'] = { command: process.execPath, args: [fake] };
  s.defaults.models = ['test-model'];
  writeFileSync(join(dir, 'settings.yaml'), YAML.stringify(s));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
  await api('/api/projects', { body: { name: 'widget', title: 'Widget' } });
  await api('/api/agents', { body: { name: 'alpha', briefing: 'v1', projects: ['widget'], budget_usd: 5 } });
  await api('/api/agents', { body: { name: 'beta', briefing: 'b' } });
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('yaho CLI inside a job', () => {
  it('puts yaho on PATH as .cmd and sh shims', () => {
    expect(existsSync(join(dir, 'bin', 'yaho.cmd'))).toBe(true);
    expect(readFileSync(join(dir, 'bin', 'yaho'), 'utf8')).toMatch(/^#!\/bin\/sh/);
  });

  it('runs every command and ends the job with finish', async () => {
    writeFileSync(join(dir, 'agents', 'alpha', 'report.txt'), 'made by alpha');
    script('alpha', [
      { cmd: 'yaho inbox list' },
      { cmd: 'yaho send --to human', stdin: 'type: question\ntitle: Ship it?\nbody: Ready.\nchoices: [Yes, No]\n' },
      { cmd: 'yaho send --to agent:beta --type info --title hi --body hello' },
      { cmd: 'yaho query projects' },
      { cmd: 'yaho query agents' },
      { cmd: 'yaho artifact add widget report.txt --kind report' },
      { cmd: 'yaho briefing update', stdin: 'v2: learned something' },
      { cmd: 'yaho budget' },
      { cmd: 'yaho project files widget' },
      { cmd: 'yaho finish --summary "all done"' },
    ]);
    const job = await api<Job>('/api/agents/alpha/run', { method: 'POST' });
    const done = await waitFor(job.id);
    const outs = await toolOutputs(job.id);
    expect(done.status, outs.join('\n---\n')).toBe('finished');
    expect(outs.every((o) => !o.startsWith('yaho:'))).toBe(true);
    expect(YAML.parse(outs[3]!)[0].name).toBe('widget');
    expect(YAML.parse(outs[7]!)).toMatchObject({ budget_usd: 5 });

    const human = await api<Message[]>('/api/messages?to=human');
    expect(human[0]).toMatchObject({ from: 'agent:alpha', type: 'question', title: 'Ship it?', choices: ['Yes', 'No'] });
    const toBeta = await api<Message[]>('/api/messages?to=agent:beta');
    expect(toBeta[0]).toMatchObject({ from: 'agent:alpha', hop: 1 });

    const arts = await api<Array<{ file_path: string; job: string }>>('/api/artifacts?project=widget');
    expect(arts[0]).toMatchObject({ file_path: 'report.txt', job: job.id });
    expect(readFileSync(join(dir, 'projects', 'widget', 'artifacts', 'report.txt'), 'utf8')).toBe('made by alpha');
    // The message the job sent shows what the job made.
    const shown = await api<Array<{ file_path: string }>>(`/api/messages/${human[0]!.id}/artifacts`);
    expect(shown.map((a) => a.file_path)).toEqual(['report.txt']);

    expect((await api<{ briefing: string }>('/api/agents/alpha')).briefing).toBe('v2: learned something');
    expect((await api<unknown[]>('/api/agents/alpha/briefings')).length).toBe(2);
    const session = ctx.db.prepare('SELECT summary FROM sessions WHERE id = ?').get(done.session_id) as { summary: string };
    expect(session.summary).toBe('all done');
  });

  it('scopes what an agent can see', async () => {
    const toHuman = (await api<Message[]>('/api/messages?to=human'))[0]!;
    script('beta', [
      { cmd: `yaho inbox read ${toHuman.id}` },
      { cmd: 'yaho project files widget' },
      { cmd: 'yaho inbox list' },
      { cmd: 'yaho finish' },
    ]);
    const job = await api<Job>('/api/agents/beta/run', { method: 'POST' });
    await waitFor(job.id);
    const outs = await toolOutputs(job.id);
    expect(outs[0]).toContain('not your message');
    expect(outs[1]).toContain('not assigned to you');
    expect(YAML.parse(outs[2]!)[0]).toMatchObject({ from: 'agent:alpha', title: 'hi' });
  });

  it('refuses expired and finished-job tokens, and human-only routes', async () => {
    ctx.db
      .prepare("INSERT INTO job_tokens (token, job, agent, expires) VALUES ('old', (SELECT id FROM jobs LIMIT 1), 'alpha', '2000-01-01')")
      .run();
    const res = await fetch(`${ctx.apiUrl}/api/agent/budget`, { headers: { Authorization: 'Bearer old' } });
    expect(res.status).toBe(401);
    ctx.db.prepare("UPDATE job_tokens SET expires = '2999-01-01' WHERE token = 'old'").run();
    const human = await fetch(`${ctx.apiUrl}/api/settings`, { headers: { Authorization: 'Bearer old' } });
    expect(human.status).toBe(403);
  });

  it('deletes an artifact with its file', async () => {
    const [a] = await api<Array<{ id: string; file_path: string }>>('/api/artifacts?project=widget');
    await api(`/api/artifacts/${a!.id}`, { method: 'DELETE' });
    expect(await api<unknown[]>('/api/artifacts?project=widget')).toEqual([]);
    expect(existsSync(join(dir, 'projects', 'widget', 'artifacts', a!.file_path))).toBe(false);
  });
});
