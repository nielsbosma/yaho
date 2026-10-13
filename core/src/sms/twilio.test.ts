import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import { contextPrompt } from '../jobs/prompt.ts';
import { getAgent, getMessage, saveAgent, thread } from '../store.ts';
import { phone, signature, SmsBridge, verifyWebhook, type OutgoingSms, type TwilioApi } from './twilio.ts';

describe('parsing', () => {
  it('normalizes phone numbers', () => {
    expect(phone('+46 70-123 45 67')).toBe('+46701234567');
    expect(phone('0046701234567')).toBe('+46701234567');
    expect(phone('0701234567')).toBe('');
    expect(phone('a@b.io')).toBe('');
  });

  it('verifies Twilio signatures', () => {
    // The example from Twilio's webhook security docs.
    const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
    const params = new URLSearchParams({
      CallSid: 'CA1234567890ABCDE',
      Caller: '+12349013030',
      Digits: '1234',
      From: '+12349013030',
      To: '+18005551212',
    });
    expect(signature('12345', url, params)).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
    expect(verifyWebhook('12345', ['http://other', url], params, '0/KCTR6DLpKmkAf8muzZqo1nDgQ=')).toBe(true);
    expect(verifyWebhook('12345', [url], params, 'AAAA')).toBe(false);
  });
});

let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;

function fakeTwilio() {
  const sent: OutgoingSms[] = [];
  const api: TwilioApi = {
    number: async (p) => (p === '+46700000000' ? { phone: p, sms_url: 'https://yaho.example.com/api/twilio/webhook' } : null),
    send: async (m) => {
      sent.push(m);
      return `SM${sent.length}`;
    },
  };
  return { api, sent };
}

const text = (p: { sid: string; from: string; body: string; media?: number }) => ({ to: '+46700000000', media: 0, ...p });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-sms-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
  saveAgent(ctx, { name: 'scout', sms: true, triggers: [] });
  saveAgent(ctx, { name: 'sales', sms: true, triggers: [] });
  saveAgent(ctx, { name: 'quiet', triggers: [] });
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('SmsBridge', () => {
  let tw: ReturnType<typeof fakeTwilio>;
  let bridge: SmsBridge;
  const inbox = (agent: string) =>
    ctx.db.prepare('SELECT id FROM messages WHERE to_addr = ? ORDER BY created').all(`agent:${agent}`) as Array<{ id: string }>;
  beforeEach(async () => {
    tw = fakeTwilio();
    ctx.settings.twilio = { account_sid: 'AC1', auth_token: 'tok', number: '+46 70 000 00 00' };
    bridge = new SmsBridge(ctx, () => tw.api);
    ctx.sms = bridge;
    await bridge.start();
  });

  it('texts from the shared number and routes the reply to the agent that texted last', async () => {
    expect(bridge.status).toMatchObject({ configured: true, connected: true, number: '+46700000000' });
    expect(getAgent(ctx, 'scout').sms).toBe(true);
    expect(contextPrompt(ctx, getAgent(ctx, 'scout'), { id: 'j', trigger_type: 'manual' } as never, null, false)).toContain('+46700000000');

    const out = await bridge.send('scout', null, { to: '+46 70 111 11 11', body: 'Running late, there at 10?' });
    expect(tw.sent[0]).toEqual({ from: '+46700000000', to: '+46701111111', body: 'Running late, there at 10?' });

    await bridge.receive(text({ sid: 'SMa', from: '+46701111111', body: 'Fine, see you' }));
    await bridge.receive(text({ sid: 'SMa', from: '+46701111111', body: 'Fine, see you' }));
    expect(inbox('scout')).toHaveLength(1);
    const reply = getMessage(ctx, inbox('scout')[0]!.id);
    expect(reply).toMatchObject({ from: 'sms:+46701111111', type: 'reply', reply_to: out.id, body: 'Fine, see you' });

    await bridge.send('scout', null, { reply_to: reply.id, body: 'Great.' });
    expect(tw.sent[1]).toMatchObject({ to: '+46701111111', body: 'Great.' });
    expect(thread(ctx, out.id).map((m) => m.from)).toEqual(['agent:scout', 'sms:+46701111111', 'agent:scout']);

    // Another agent texts the same phone: the next reply is theirs.
    await bridge.send('sales', null, { to: '+46701111111', body: 'Your order shipped.' });
    await bridge.receive(text({ sid: 'SMb', from: '+46701111111', body: 'Thanks!', media: 2 }));
    expect(inbox('scout')).toHaveLength(1);
    expect(getMessage(ctx, inbox('sales')[0]!.id).body).toBe('Thanks!\n\n(2 pictures or files, not downloaded)');
  });

  it('drops new phones, opt-out keywords and agents without SMS unless allowed', async () => {
    const count = () => (ctx.db.prepare("SELECT COUNT(*) n FROM messages WHERE from_addr LIKE 'sms:%'").get() as { n: number }).n;
    const before = count();
    await bridge.receive(text({ sid: 'n1', from: '+46702222222', body: 'Hello?' }));
    expect(bridge.status.last_ignored).toContain('no agent has texted');
    await bridge.receive(text({ sid: 'n2', from: '+46701111111', body: 'STOP' }));
    await bridge.receive({ sid: 'n3', from: '+46701111111', to: '+46709999999', body: 'hi', media: 0 });
    expect(count()).toBe(before);

    ctx.settings.twilio = { ...ctx.settings.twilio, new_agent: 'quiet' };
    await bridge.receive(text({ sid: 'n4', from: '+46702222222', body: 'Hello?' }));
    expect(bridge.status.last_ignored).toContain('quiet does not have SMS on');
    ctx.settings.twilio = { ...ctx.settings.twilio, new_agent: 'sales' };
    await bridge.receive(text({ sid: 'n5', from: '+46702222222', body: 'Do you ship to Norway?' }));
    expect(count()).toBe(before + 1);
    expect(getMessage(ctx, inbox('sales').at(-1)!.id)).toMatchObject({ from: 'sms:+46702222222', type: 'info' });
  });

  it('refuses agents without SMS, bad numbers, other agents texts and long texts', async () => {
    await expect(bridge.send('quiet', null, { to: '+46701111111', body: 'B' })).rejects.toThrow('not turned on');
    await expect(bridge.send('scout', null, { to: '0701111111', body: 'B' })).rejects.toThrow('international form');
    await expect(bridge.send('scout', null, { to: '+46700000000', body: 'B' })).rejects.toThrow("Yaho's own number");
    await expect(bridge.send('scout', null, { to: '+46701111111', body: 'x'.repeat(1601) })).rejects.toThrow('limit is 1600');
    const theirs = inbox('sales').at(-1)!.id;
    await expect(bridge.send('scout', null, { reply_to: theirs, body: 'B' })).rejects.toThrow('not one of your text messages');
  });

  it('checks the webhook signature over HTTP', async () => {
    const params = new URLSearchParams({ MessageSid: 'SMw', From: '+46701111111', To: '+46700000000', Body: 'over http', NumMedia: '0' });
    const url = new URL('/api/twilio/webhook', ctx.apiUrl);
    const post = (sig: string, headers: Record<string, string> = {}) =>
      fetch(url, {
        method: 'POST',
        body: params.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig, ...headers },
      });
    expect((await post('AAAA')).status).toBe(401);
    // Behind a tunnel Twilio signs the public https URL.
    const tunnel = signature('tok', 'https://yaho.example.com/api/twilio/webhook', params);
    const res = await post(tunnel, { 'X-Forwarded-Host': 'yaho.example.com', 'X-Forwarded-Proto': 'https' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<Response>');
    await new Promise((r) => setTimeout(r, 50));
    expect(bridge.status.last_webhook).toBeTruthy();
    expect(ctx.db.prepare("SELECT agent FROM sms WHERE sid = 'SMw'").get()).toEqual({ agent: 'sales' });
  });
});
