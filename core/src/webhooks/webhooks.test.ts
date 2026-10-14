import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import { contextPrompt } from '../jobs/prompt.ts';
import { getAgent, getMessage, saveAgent } from '../store.ts';
import { listWebhooks, rotateUrl, setSecret, stripeSignature, verifySignature, type WebhookInfo } from './hooks.ts';

const body = Buffer.from('{"action":"opened","issue":{"number":7}}');

describe('signatures', () => {
  const at = 1_700_000_000_000;
  const t = at / 1000;

  it('checks GitHub, Stripe and Yaho signatures', () => {
    const gh = `sha256=${createHmac('sha256', 'sekret').update(body).digest('hex')}`;
    expect(verifySignature('github', 'sekret', { 'x-hub-signature-256': gh }, body)).toBe(true);
    expect(verifySignature('github', 'other', { 'x-hub-signature-256': gh }, body)).toBe(false);

    const sig = `t=${t},v1=${stripeSignature('whsec_abc', t, body)}`;
    expect(verifySignature('stripe', 'whsec_abc', { 'stripe-signature': sig }, body, at)).toBe(true);
    expect(verifySignature('stripe', 'whsec_abc', { 'stripe-signature': sig }, body, at + 10 * 60_000)).toBe(false);
    expect(verifySignature('yaho', 'whsec_abc', { 'x-yaho-signature': sig }, body, at)).toBe(true);
    expect(verifySignature('yaho', 'whsec_abc', { 'x-yaho-signature': sig }, Buffer.from('{}'), at)).toBe(false);
    expect(verifySignature('none', '', {}, body)).toBe(true);
  });

  it('checks Svix and Standard Webhooks signatures', () => {
    const secret = `whsec_${Buffer.from('0123456789abcdef0123').toString('base64')}`;
    const key = Buffer.from(secret.slice(6), 'base64');
    const sig = `v1,${createHmac('sha256', key).update(`msg_1.${t}.`).update(body).digest('base64')}`;
    expect(verifySignature('svix', secret, { 'svix-id': 'msg_1', 'svix-timestamp': String(t), 'svix-signature': sig }, body, at)).toBe(
      true,
    );
    expect(
      verifySignature('svix', secret, { 'webhook-id': 'msg_1', 'webhook-timestamp': String(t), 'webhook-signature': sig }, body, at),
    ).toBe(true);
    expect(
      verifySignature('svix', secret, { 'webhook-id': 'msg_2', 'webhook-timestamp': String(t), 'webhook-signature': sig }, body, at),
    ).toBe(false);
  });
});

let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;
let started: Array<{ agent: string; trigger: string; detail?: string }>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-webhooks-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
  saveAgent(ctx, {
    name: 'triage',
    triggers: [
      { webhook: 'github', verify: 'github', instructions: 'Label the new issue.' },
      { webhook: 'zap', limit: 2 },
    ],
  });
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  started = [];
  ctx.runner = {
    ...ctx.runner!,
    enqueue: (agent, trigger, opts) => {
      started.push({ agent, trigger, detail: opts?.detail });
      return { id: `job_${started.length}` };
    },
  };
});

const hook = (name: string) => listWebhooks(ctx, 'triage').find((w) => w.name === name)!;
const post = (w: WebhookInfo, data: Buffer | string, headers: Record<string, string> = {}) =>
  fetch(`${ctx.apiUrl}${w.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof data === 'string' ? data : new Uint8Array(data),
  });

describe('webhook triggers', () => {
  it('keep their URL and secret across saves, and only the definition is in the agent', () => {
    const before = hook('github');
    expect(before.path).toMatch(/^\/api\/hooks\/[\w-]{32}$/);
    expect(getAgent(ctx, 'triage').triggers).toEqual([
      { webhook: 'github', verify: 'github', instructions: 'Label the new issue.' },
      { webhook: 'zap', limit: 2 },
    ]);
    saveAgent(ctx, { name: 'triage', briefing: 'v2' });
    expect(hook('github')).toMatchObject({ path: before.path, secret: before.secret });
    expect(() => saveAgent(ctx, { name: 'triage', triggers: [{ webhook: 'a' }, { webhook: 'a' }] })).toThrow(/two webhooks/);
    expect(() => saveAgent(ctx, { name: 'triage', triggers: [{ webhook: 'Bad Name' }] })).toThrow(/webhook name/);
  });

  it('start a job with a signed delivery and drop repeats', async () => {
    const w = hook('github');
    const sig = `sha256=${createHmac('sha256', w.secret).update(body).digest('hex')}`;
    expect((await post(w, body, { 'x-hub-signature-256': 'sha256=00' })).status).toBe(401);
    expect(hook('github').last_rejected).toContain('signature');
    expect(started).toHaveLength(0);

    const headers = { 'x-hub-signature-256': sig, 'x-github-delivery': 'd-1', 'x-github-event': 'issues' };
    const res = await post(w, body, headers);
    expect(res.status).toBe(202);
    const out = (await res.json()) as { job: string; message: string };
    expect(started).toEqual([{ agent: 'triage', trigger: 'webhook', detail: 'github' }]);
    const msg = getMessage(ctx, out.message);
    expect(msg).toMatchObject({ from: 'webhook:github', to: 'agent:triage', title: 'Webhook github: issues' });
    expect(msg.body).toContain('"number": 7');
    const file = /`(webhooks\/github\/[^`]+\.json)`/.exec(msg.body)![1]!;
    expect(readFileSync(join(ctx.paths.agent('triage'), file), 'utf8')).toBe(body.toString());

    const prompt = contextPrompt(
      ctx,
      getAgent(ctx, 'triage'),
      { id: out.job, trigger_type: 'webhook', trigger_detail: 'github' } as never,
      null,
      false,
    );
    expect(prompt).toContain(file);
    expect(prompt).toContain('Label the new issue.');

    expect(await (await post(w, body, headers)).json()).toMatchObject({ duplicate: true });
    expect(started).toHaveLength(1);
  });

  it('refuse deliveries over the hourly limit, when paused, or after the URL changes', async () => {
    const w = hook('zap');
    expect((await post(w, 'a')).status).toBe(202);
    expect((await post(w, 'b')).status).toBe(202);
    expect((await post(w, 'c')).status).toBe(429);
    expect(started).toHaveLength(2);

    const moved = rotateUrl(ctx, w.id);
    expect((await post(w, 'd')).status).toBe(404);
    expect(moved.path).not.toBe(w.path);

    saveAgent(ctx, { name: 'triage', triggers: [{ webhook: 'zap', paused: true }] });
    expect((await post(hook('zap'), 'e')).status).toBe(403);
    expect(listWebhooks(ctx, 'triage').map((x) => x.name)).toEqual(['zap']);
  });

  it('take a pasted signing secret', () => {
    const w = hook('zap');
    expect(setSecret(ctx, w.id, 'whsec_from_the_sender_123').secret).toBe('whsec_from_the_sender_123');
    expect(setSecret(ctx, w.id).secret).toMatch(/^[0-9a-f]{64}$/);
    expect(() => setSecret(ctx, w.id, 'short')).toThrow(/16 characters/);
  });
});
