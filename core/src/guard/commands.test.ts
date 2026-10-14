import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { defaultSettings } from '../config.ts';
import type { Ctx } from '../context.ts';
import { claudeSettings } from '../harness/claudeCode.ts';
import { serve } from '../serve.ts';
import type { Agent, Job, Message } from '../store.ts';

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

const steps = (file: string, list: Array<{ cmd?: string; sleep_ms?: number }>) => {
  mkdirSync(join(dir, 'agents', 'gamma'), { recursive: true });
  writeFileSync(join(dir, 'agents', 'gamma', file), JSON.stringify(list));
};

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const jobs = () => api<Job[]>('/api/jobs?agent=gamma');
const ended = (j: Job) => !['queued', 'running'].includes(j.status);
const outputs = async (job: string) =>
  (await api<Array<{ kind: string; data: { output?: string; text?: string } }>>(`/api/jobs/${job}/events`)).filter((e) =>
    ['tool_result', 'guard'].includes(e.kind),
  );
const question = () =>
  until(
    () => api<Message[]>('/api/messages?to=human&unread=1'),
    (m) => m.some((x) => x.from === 'agent:gamma'),
  ).then((m) => m.find((x) => x.from === 'agent:gamma')!);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-rules-'));
  const s = defaultSettings();
  s.harnesses['claude-code'] = { command: process.execPath, args: [fake] };
  s.defaults.models = ['test-model'];
  writeFileSync(join(dir, 'settings.yaml'), YAML.stringify(s));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
  await api('/api/agents', { body: { name: 'gamma', briefing: 'g' } });
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('Command Rules', () => {
  it('adds no hook while off', async () => {
    expect(claudeSettings({})).toBeNull();
    expect(claudeSettings({ commandGuard: 'g' })).toEqual({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'g' }] }] },
    });
    steps('steps.json', [{ cmd: 'mkdir -p build && rm -rf build && echo gone' }, { cmd: 'yaho finish' }]);
    const job = await api<Job>('/api/agents/gamma/run', { method: 'POST' });
    await until(() => api<Job>(`/api/jobs/${job.id}`), ended);
    expect((await outputs(job.id))[0]!.data.output).toContain('gone');
  });

  it('blocks, asks in the inbox, pauses, and resumes with the answer', async () => {
    ctx.settings.command_rules = { enabled: true };
    steps('steps.json', [
      { cmd: 'echo fine' },
      { cmd: 'rm -rf /' },
      { cmd: 'mkdir -p build && rm -rf build' },
      { cmd: 'echo after' },
      { sleep_ms: 10_000 },
    ]);
    const first = await api<Job>('/api/agents/gamma/run', { method: 'POST' });
    const paused = await until(() => api<Job>(`/api/jobs/${first.id}`), ended);
    expect(paused.status).toBe('sleeping');
    expect(paused.reason).toContain('waiting for your approval');
    const outs = await outputs(first.id);
    expect(outs.find((o) => o.kind === 'tool_result')!.data.output).toContain('fine');
    expect(outs.some((o) => o.data.output?.includes('Command Rules blocked'))).toBe(true);
    expect(outs.some((o) => o.data.output?.includes('needs the human'))).toBe(true);
    // Nothing else runs once a command waits for approval.
    expect(outs.some((o) => o.data.output?.includes('A command is waiting'))).toBe(true);
    expect(outs.some((o) => o.data.output === 'after\n')).toBe(false);

    const q = await question();
    expect(q).toMatchObject({ type: 'question', choices: ['Allow once', 'Always allow', 'Deny'], job: first.id });
    expect(q.body).toContain('rm -rf build');

    // Allow once: the same command runs once in the resumed session, and asks again after that.
    steps('steps-resume.json', [{ cmd: 'mkdir -p build && rm -rf build && echo removed' }, { sleep_ms: 10_000 }]);
    // Not the command that was approved (echo removed was added): asks again.
    await api('/api/messages', { body: { to: 'agent:gamma', reply_to: q.id, body: 'Allow once' } });
    const resumed = await until(jobs, (js) => js.some((j) => j.trigger_type === 'approval' && ended(j)));
    const r1 = resumed.find((j) => j.trigger_type === 'approval')!;
    expect(r1.session_id).toBe(paused.session_id);
    expect(r1.status).toBe('sleeping');
    const q2 = await question();
    expect(q2.id).not.toBe(q.id);

    steps('steps-resume.json', [
      { cmd: 'mkdir -p build && rm -rf build && echo removed' },
      { cmd: 'mkdir -p build && rm -rf build && echo removed' },
      { sleep_ms: 10_000 },
    ]);
    await api('/api/messages', { body: { to: 'agent:gamma', reply_to: q2.id, body: 'Allow once' } });
    const r2 = await until(jobs, (js) => js.filter((j) => j.trigger_type === 'approval' && ended(j)).length === 2).then(
      (js) => js.filter((j) => j.trigger_type === 'approval')[0]!,
    );
    const o2 = await outputs(r2.id);
    expect(o2.find((o) => o.kind === 'tool_result')!.data.output).toContain('removed');
    expect(o2.some((o) => o.data.text?.startsWith('Approved by the human'))).toBe(true);
    expect(r2.status).toBe('sleeping');

    // Always allow: an Allow rule for exactly that command on the agent.
    const q3 = await question();
    steps('steps-resume.json', [
      { cmd: 'mkdir -p build && rm -rf build && echo removed' },
      { cmd: 'mkdir -p build && rm -rf build && echo removed' },
      { cmd: 'yaho finish' },
    ]);
    await api('/api/messages', { body: { to: 'agent:gamma', reply_to: q3.id, body: 'Always allow' } });
    const r3 = await until(jobs, (js) => js.filter((j) => j.trigger_type === 'approval' && ended(j)).length === 3).then(
      (js) => js.filter((j) => j.trigger_type === 'approval')[0]!,
    );
    expect(r3.status).toBe('finished');
    expect((await outputs(r3.id)).filter((o) => o.data.output?.includes('removed'))).toHaveLength(2);
    const agent = await api<Agent>('/api/agents/gamma');
    expect(agent.guardrails.command_rules).toEqual([expect.objectContaining({ action: 'allow' })]);
    // The answer was for the approval, not a message the agent has to read.
    expect(await api<Message[]>('/api/messages?to=agent:gamma&unread=1')).toEqual([]);
  });

  it('tells the resumed agent when the human denies', async () => {
    steps('steps.json', [{ cmd: 'git reset --hard' }, { sleep_ms: 10_000 }]);
    const job = await api<Job>('/api/agents/gamma/run', { method: 'POST' });
    await until(() => api<Job>(`/api/jobs/${job.id}`), ended);
    const q = await question();
    steps('steps-resume.json', [{ cmd: 'git reset --hard' }, { cmd: 'yaho finish' }]);
    await api('/api/messages', { body: { to: 'agent:gamma', reply_to: q.id, body: 'Deny' } });
    const r = await until(jobs, (js) => js.some((j) => j.trigger_type === 'approval' && j.trigger_detail?.includes('denied') && ended(j)));
    const denied = r.find((j) => j.trigger_detail?.includes('denied'))!;
    expect((await outputs(denied.id))[0]!.data.output).toContain('denied');
    const prompt = (await api<Array<{ kind: string; data: { user?: string } }>>(`/api/jobs/${denied.id}/events`)).find(
      (e) => e.kind === 'prompt',
    )!;
    expect(prompt.data.user).toContain('the human denied `git reset --hard`');
  });

  it('takes only the exact choices as approval', async () => {
    steps('steps.json', [{ cmd: 'git reset --hard HEAD' }, { sleep_ms: 10_000 }]);
    const job = await api<Job>('/api/agents/gamma/run', { method: 'POST' });
    await until(() => api<Job>(`/api/jobs/${job.id}`), ended);
    const q = await question();
    steps('steps-resume.json', [{ cmd: 'yaho finish' }]);
    await api('/api/messages', { body: { to: 'agent:gamma', reply_to: q.id, body: 'yes... actually no' } });
    const r = await until(jobs, (js) => js.some((j) => j.trigger_detail?.includes('They answered: yes... actually no') && ended(j)));
    expect(r.find((j) => j.trigger_detail?.includes('They answered'))!.trigger_detail).toContain(
      'the human denied `git reset --hard HEAD`',
    );
    expect(ctx.db.prepare('SELECT status FROM command_approvals WHERE message = ?').get(q.id)).toEqual({ status: 'denied' });
  });

  it('refuses bad rules when saving', async () => {
    await expect(
      api('/api/agents/gamma', {
        method: 'PUT',
        body: { name: 'gamma', guardrails: { command_rules: [{ pattern: '/(/', action: 'block' }] } },
      }),
    ).rejects.toThrow(/rule 1/);
  });
});
