import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import { contextPrompt } from '../jobs/prompt.ts';
import { getAgent, getMessage, saveAgent, thread } from '../store.ts';
import {
  address,
  EmailBridge,
  htmlToText,
  stripQuoted,
  verifyWebhook,
  type OutgoingEmail,
  type ReceivedEmail,
  type ResendApi,
} from './resend.ts';

describe('parsing', () => {
  it('finds addresses, text and the new part of a reply', () => {
    expect(address('Anna Svensson <Anna@Example.com>')).toBe('anna@example.com');
    expect(address('bob@x.io')).toBe('bob@x.io');
    expect(htmlToText('<p>Hi&nbsp;there</p><p>Bring the <b>deck</b></p>')).toBe('Hi there\nBring the deck');
    expect(stripQuoted('Yes, bring the deck.\n\nOn Mon, 12 Oct 2026 at 09:00, scout <scout@a.io> wrote:\n> Anything to prepare?')).toBe(
      'Yes, bring the deck.',
    );
    expect(stripQuoted('Sure\r\n> quoted')).toBe('Sure');
  });

  it('verifies Svix signatures', () => {
    const secret = `whsec_${Buffer.from('k3y').toString('base64')}`;
    const body = Buffer.from('{"type":"email.received"}');
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', 'k3y').update(`msg_1.${ts}.${body}`).digest('base64');
    expect(verifyWebhook(secret, { 'svix-id': 'msg_1', 'svix-timestamp': ts, 'svix-signature': `v1,bad v1,${sig}` }, body)).toBe(true);
    expect(verifyWebhook(secret, { 'svix-id': 'msg_2', 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` }, body)).toBe(false);
    expect(
      verifyWebhook(secret, { 'svix-id': 'msg_1', 'svix-timestamp': String(Number(ts) - 3600), 'svix-signature': `v1,${sig}` }, body),
    ).toBe(false);
  });
});

let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;

function fakeResend() {
  const sent: OutgoingEmail[] = [];
  const inbox = new Map<string, ReceivedEmail>();
  const api: ResendApi = {
    domains: async () => [{ name: 'agents.test', status: 'verified' }],
    send: async (e) => {
      sent.push(e);
      return `re_${sent.length}`;
    },
    received: async (id) => inbox.get(id)!,
  };
  return { api, sent, inbox };
}

const mail = (p: Partial<ReceivedEmail>): ReceivedEmail => ({
  from: '',
  to: [],
  cc: [],
  subject: '',
  text: null,
  html: null,
  headers: {},
  attachments: [],
  ...p,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-email-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
  saveAgent(ctx, { name: 'scout', email: true, triggers: [] });
  saveAgent(ctx, { name: 'quiet', triggers: [] });
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('EmailBridge', () => {
  let rs: ReturnType<typeof fakeResend>;
  let bridge: EmailBridge;
  beforeEach(async () => {
    rs = fakeResend();
    ctx.settings.resend = { api_key: 're_x', webhook_secret: `whsec_${Buffer.from('s').toString('base64')}`, domain: 'agents.test' };
    bridge = new EmailBridge(ctx, () => rs.api);
    ctx.email = bridge;
    await bridge.start();
  });

  it('sends from the agent, threads the reply into its inbox, and replies in the same thread', async () => {
    expect(bridge.status).toMatchObject({ configured: true, connected: true, domain_status: 'verified' });
    expect(getAgent(ctx, 'scout').email).toBe(true);
    expect(contextPrompt(ctx, getAgent(ctx, 'scout'), { id: 'j', trigger_type: 'manual' } as never, null, false)).toContain(
      'scout@agents.test',
    );

    const out = await bridge.send('scout', null, {
      to: 'anna@example.com',
      subject: 'Our meeting Thursday',
      body: 'Anything I should prepare?',
    });
    const first = rs.sent[0]!;
    expect(first).toMatchObject({ from: 'scout <scout@agents.test>', to: ['anna@example.com'], subject: 'Our meeting Thursday' });
    expect(first.reply_to).toMatch(/^scout\+[0-9a-f]{10}@agents\.test$/);

    await bridge.receive(
      'in_1',
      mail({
        from: 'Anna <anna@example.com>',
        to: [first.reply_to],
        subject: 'Re: Our meeting Thursday',
        text: 'Read the Q3 report first.\n\nOn Tue, scout wrote:\n> Anything I should prepare?',
        headers: { 'Message-ID': '<abc@mail.example.com>' },
      }),
    );
    await bridge.receive('in_1', mail({ from: 'anna@example.com', to: [first.reply_to], text: 'duplicate delivery' }));
    const inbox = ctx.db.prepare("SELECT id FROM messages WHERE to_addr = 'agent:scout'").all() as Array<{ id: string }>;
    expect(inbox).toHaveLength(1);
    const reply = getMessage(ctx, inbox[0]!.id);
    expect(reply).toMatchObject({ from: 'email:anna@example.com', type: 'reply', reply_to: out.id, body: 'Read the Q3 report first.' });

    await bridge.send('scout', null, { reply_to: reply.id, body: 'Thanks, will do.' });
    expect(rs.sent[1]).toMatchObject({ to: ['anna@example.com'], subject: 'Re: Our meeting Thursday', reply_to: first.reply_to });
    expect(rs.sent[1]!.headers).toEqual({ 'In-Reply-To': '<abc@mail.example.com>', References: '<abc@mail.example.com>' });
    expect(thread(ctx, out.id).map((m) => m.from)).toEqual(['agent:scout', 'email:anna@example.com', 'agent:scout']);

    // A reply that lost the Reply-To still finds its thread through In-Reply-To.
    await bridge.receive(
      'in_2',
      mail({
        from: 'anna@example.com',
        to: ['scout@agents.test'],
        text: 'One more thing',
        headers: { 'In-Reply-To': '<abc@mail.example.com>' },
      }),
    );
    expect(thread(ctx, out.id)).toHaveLength(4);
  });

  it('drops new emails, automatic replies and agents without email unless allowed', async () => {
    const count = () => (ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE from_addr LIKE 'email:%'").get() as { n: number }).n;
    const before = count();
    await bridge.receive('n_1', mail({ from: 'spam@x.io', to: ['scout@agents.test'], text: 'Hello' }));
    await bridge.receive(
      'n_2',
      mail({ from: 'bot@x.io', to: ['scout+0000000000@agents.test'], text: 'Away', headers: { 'Auto-Submitted': 'auto-replied' } }),
    );
    await bridge.receive('n_3', mail({ from: 'x@x.io', to: ['quiet@agents.test'], text: 'Hi' }));
    expect(count()).toBe(before);
    expect(bridge.status.last_ignored).toContain('quiet@agents.test');

    ctx.settings.resend = { ...ctx.settings.resend, accept_new: true };
    await bridge.receive(
      'n_4',
      mail({ from: 'lead@x.io', to: ['scout@agents.test'], subject: 'Question', html: '<p>Do you ship to Norway?</p>' }),
    );
    expect(count()).toBe(before + 1);
    const m = ctx.db.prepare("SELECT id FROM messages WHERE from_addr = 'email:lead@x.io'").get() as { id: string };
    await bridge.send('scout', null, { reply_to: m.id, body: 'Yes.' });
    expect(rs.sent.at(-1)).toMatchObject({ to: ['lead@x.io'], subject: 'Re: Question' });
  });

  it('refuses agents without email, other agents threads and Yaho addresses', async () => {
    await expect(bridge.send('quiet', null, { to: 'a@b.io', subject: 'S', body: 'B' })).rejects.toThrow('not turned on');
    await expect(bridge.send('scout', null, { to: 'quiet@agents.test', subject: 'S', body: 'B' })).rejects.toThrow('Yaho address');
    const human = ctx.db
      .prepare("INSERT INTO messages (id, from_addr, to_addr, type, created) VALUES ('m_h', 'human', 'agent:scout', 'info', '')")
      .run();
    expect(human.changes).toBe(1);
    await expect(bridge.send('scout', null, { reply_to: 'm_h', body: 'B' })).rejects.toThrow('not one of your email messages');
  });

  it('checks the webhook signature over HTTP', async () => {
    const body = JSON.stringify({ type: 'email.received', data: { email_id: 'w_1' } });
    rs.inbox.set('w_1', mail({ from: 'nobody@x.io', to: ['scout@agents.test'], text: 'hi' }));
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', 's').update(`id1.${ts}.${body}`).digest('base64');
    const post = (signature: string) =>
      fetch(`${ctx.apiUrl}/api/resend/webhook`, {
        method: 'POST',
        body,
        headers: { 'svix-id': 'id1', 'svix-timestamp': ts, 'svix-signature': signature },
      });
    expect((await post('v1,AAAA')).status).toBe(401);
    expect((await post(`v1,${sig}`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.status.last_webhook).toBeTruthy();
  });
});
