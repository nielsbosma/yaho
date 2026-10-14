import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import { getMessage, sendMessage } from '../store.ts';
import { WhatsAppBridge, WhatsAppError, type WhatsAppApi } from './bridge.ts';
import { messagePayloads, toWhatsApp } from './format.ts';

describe('toWhatsApp', () => {
  it('converts the Markdown agents write', () => {
    expect(toWhatsApp('# Report\n**Signups** up, *slightly*. See [the board](https://x.io/b).\n- one\n- two')).toBe(
      '*Report*\n*Signups* up, _slightly_. See the board (https://x.io/b).\n• one\n• two',
    );
    expect(toWhatsApp('```copy Note for Anna\nHej Anna!\n```')).toBe('*Note for Anna*\n```Hej Anna!```');
  });
});

describe('messagePayloads', () => {
  const base = { id: 'm', from: 'agent:a', to: 'human', title: 'T', body: 'B', reply_to: null, hop: 0, job: null, created: '' };
  const ids = (m: Parameters<typeof messagePayloads>[0]) => {
    const i = messagePayloads(m).find((p) => p.actions)?.payload.interactive as Record<string, any> | undefined;
    if (!i) return [];
    return i.type === 'button' ? i.action.buttons.map((b: any) => b.reply.id) : i.action.sections[0].rows.map((r: any) => r.id);
  };

  it('uses buttons for a few short actions and a list for more', () => {
    expect(ids({ ...base, type: 'question', read: false, expects_response: true, choices: ['Yes', 'No'] })).toEqual([
      'choice:m:0',
      'choice:m:1',
      'read:m',
    ]);
    expect(ids({ ...base, type: 'instruction', read: false, expects_response: true })).toEqual(['done:m', 'read:m']);
    expect(ids({ ...base, type: 'info', read: true, expects_response: false })).toEqual([]);
    const list = messagePayloads({ ...base, type: 'question', read: false, expects_response: true, choices: ['A', 'B', 'C', 'D'] });
    expect((list[0]!.payload.interactive as { type: string }).type).toBe('list');
  });

  it('sends a long body as text first, then the buttons', () => {
    const p = messagePayloads({ ...base, body: 'x'.repeat(3000), type: 'instruction', read: false, expects_response: true });
    expect(p.map((x) => x.payload.type)).toEqual(['text', 'interactive']);
  });
});

let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;

/** A fake Cloud API: records what is sent; window closes the 24-hour window. */
function fakeWhatsApp() {
  const sent: Array<{ to: string; payload: Record<string, any>; id: string }> = [];
  let n = 0;
  const state = { window: true };
  const api: WhatsAppApi = {
    phone: async () => ({ number: '+1 555 0100', name: 'Yaho' }),
    send: async (to, payload) => {
      if (!state.window && payload.type !== 'template') throw new WhatsAppError('Re-engagement message', 131047);
      const id = `wamid.${++n}`;
      sent.push({ to, payload, id });
      return id;
    },
  };
  return { api, sent, state };
}

const tick = () => new Promise((r) => setTimeout(r, 50));
const OWNER = '46701234567';

function delivery(messages: unknown[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'P1' }, messages } }] }],
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-whatsapp-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
  const now = new Date().toISOString();
  ctx.db.prepare("INSERT INTO agents (name, created, updated) VALUES ('scout', ?, ?)").run(now, now);
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('WhatsAppBridge', () => {
  let wa: ReturnType<typeof fakeWhatsApp>;
  let bridge: WhatsAppBridge;
  beforeEach(async () => {
    bridge?.stop();
    wa = fakeWhatsApp();
    ctx.settings.whatsapp = { access_token: 't', app_secret: 'shh', phone_number_id: 'P1', number: '+46 70 123 45 67' };
    bridge = new WhatsAppBridge(ctx, () => wa.api);
    ctx.whatsapp = bridge;
    await bridge.start();
  });

  it('links on the first message, posts the inbox, and takes answers back', async () => {
    expect(bridge.status).toMatchObject({ configured: true, connected: true, number: '+1 555 0100', owner: true, linked: false });

    // Someone else writing does nothing; the owner's first message links it.
    await bridge.webhook(delivery([{ from: '15550000', id: 'in.0', type: 'text', text: { body: 'hi' } }]));
    expect(ctx.settings.whatsapp?.since).toBeUndefined();
    await bridge.webhook(delivery([{ from: OWNER, id: 'in.1', type: 'text', text: { body: '/help' } }]));
    expect(ctx.settings.whatsapp?.since).toBeTruthy();
    expect(wa.sent[0]!.to).toBe(OWNER);
    expect(JSON.stringify(wa.sent[0]!.payload)).toContain('Yaho is connected.');

    // A question is posted with its choices as buttons; tapping one answers it and reacts ✅.
    const q = sendMessage(ctx, {
      from: 'agent:scout',
      to: 'human',
      type: 'question',
      title: 'Spend $5?',
      body: 'For **ads**',
      choices: ['Yes', 'No'],
    });
    await tick();
    const posted = wa.sent.at(-1)!;
    expect(posted.payload.interactive.body.text).toContain('*scout* via Yaho');
    expect(posted.payload.interactive.body.text).toContain('For *ads*');
    await bridge.webhook(
      delivery([
        {
          from: OWNER,
          id: 'in.2',
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: `choice:${q.id}:0`, title: 'Yes' } },
        },
      ]),
    );
    await tick();
    const answer = ctx.db.prepare("SELECT body FROM messages WHERE reply_to = ? AND from_addr = 'human'").get(q.id) as { body: string };
    expect(answer.body).toBe('Yes');
    expect(getMessage(ctx, q.id).read).toBe(true);
    expect(wa.sent.at(-1)!.payload).toEqual({ type: 'reaction', reaction: { message_id: posted.id, emoji: '✅' } });

    // A swipe-reply to an instruction answers it in the person's own words.
    const ins = sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'instruction', title: 'Add the DNS record' });
    await tick();
    const insPost = wa.sent.at(-1)!.id;
    await bridge.webhook(
      delivery([{ from: OWNER, id: 'in.3', type: 'text', text: { body: 'Done, took a minute' }, context: { id: insPost } }]),
    );
    const insAnswer = ctx.db.prepare("SELECT body FROM messages WHERE reply_to = ? AND from_addr = 'human'").get(ins.id) as {
      body: string;
    };
    expect(insAnswer.body).toBe('Done, took a minute');

    // A ✅ reaction on an info message marks it read.
    const info = sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'info', title: 'Weekly report' });
    await tick();
    await bridge.webhook(
      delivery([{ from: OWNER, id: 'in.4', type: 'reaction', reaction: { message_id: wa.sent.at(-1)!.id, emoji: '✅' } }]),
    );
    expect(getMessage(ctx, info.id).read).toBe(true);
  });

  it('holds messages while the window is closed, nudges once with the template, and posts them when the person writes', async () => {
    ctx.settings.whatsapp = { ...ctx.settings.whatsapp!, since: new Date(Date.now() - 1000).toISOString(), template: 'yaho_waiting' };
    wa.state.window = false;
    const before = wa.sent.length;
    const q = sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'question', title: 'Go?' });
    await tick();
    sendMessage(ctx, { from: 'agent:scout', to: 'human', type: 'info', title: 'FYI' });
    await tick();
    const nudges = wa.sent.slice(before);
    expect(nudges.map((x) => x.payload.type)).toEqual(['template']);
    expect(nudges[0]!.payload.template.components[0].parameters[0].text).toBe('scout: Go?');

    wa.state.window = true;
    await bridge.webhook(delivery([{ from: OWNER, id: 'in.5', type: 'button', button: { text: 'Show me' } }]));
    const posted = wa.sent.slice(before + 1).map((x) => JSON.stringify(x.payload));
    expect(posted.some((p) => p.includes('Go?'))).toBe(true);
    expect(posted.some((p) => p.includes('FYI'))).toBe(true);
    expect(ctx.db.prepare('SELECT COUNT(*) n FROM whatsapp_posts WHERE message = ?').get(q.id)).toEqual({ n: 1 });
  });

  it('checks the webhook handshake and signatures', async () => {
    const token = bridge.verifyToken();
    const ok = await fetch(`${ctx.apiUrl}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`);
    expect(await ok.text()).toBe('42');
    expect((await fetch(`${ctx.apiUrl}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`)).status).toBe(403);

    const body = JSON.stringify(delivery([]));
    const bad = await fetch(`${ctx.apiUrl}/api/whatsapp/webhook`, {
      method: 'POST',
      body,
      headers: { 'X-Hub-Signature-256': 'sha256=00' },
    });
    expect(bad.status).toBe(401);
    const sig = `sha256=${createHmac('sha256', 'shh').update(body).digest('hex')}`;
    const good = await fetch(`${ctx.apiUrl}/api/whatsapp/webhook`, { method: 'POST', body, headers: { 'X-Hub-Signature-256': sig } });
    expect(good.status).toBe(200);
    expect(bridge.status.last_webhook).toBeTruthy();
  });
});
