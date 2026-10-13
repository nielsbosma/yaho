import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { saveSettings } from '../config.ts';
import type { BusEvent, Ctx } from '../context.ts';
import { chat, type ChatMessage } from '../assistant/index.ts';
import type { Message } from '../store.ts';
import * as s from '../store.ts';
import { chunks, messagePayloads, parseAction, toWhatsApp, type Action, type Payload } from './format.ts';

type Row = Record<string, unknown>;

const GRAPH = 'https://graph.facebook.com/v23.0';
/** Free-form messages are allowed for 24 hours after the person last wrote; stop a little early. */
const WINDOW_MS = 23.5 * 3600_000;
/** Graph error codes meaning the 24-hour window is closed. */
const WINDOW_CLOSED = new Set([131047, 131026]);
const CHECKS = ['✅', '✔️', '☑️', '👍'];

export class WhatsAppError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

/** The two Cloud API calls the bridge makes; the real Graph API, or a fake in tests. */
export interface WhatsAppApi {
  phone(): Promise<{ number?: string; name?: string }>;
  /** Send to a WhatsApp number; returns the message id (wamid). */
  send(to: string, payload: Payload): Promise<string>;
}

export interface WhatsAppStatus {
  configured: boolean;
  connected: boolean;
  /** The business number Yaho sends from, and its display name. */
  number?: string;
  name?: string;
  /** Whether the person's number is set, and whether they have written to Yaho yet. */
  owner: boolean;
  linked: boolean;
  /** Whether Yaho may send free-form messages now (the person wrote in the last 24 hours). */
  window_open: boolean;
  last_webhook?: string;
  error?: string;
}

const digits = (n: string | undefined) => (n ?? '').replace(/\D/g, '');

/**
 * Mirrors the human's inbox into WhatsApp over the Cloud API and takes answers back, like the Slack bridge. Buttons,
 * swipe-replies and ✅ reactions become replies, Done and Mark Read through the same store functions the app uses.
 * Only the configured number can act. WhatsApp lets a business write freely only within 24 hours of the person's last
 * message: outside it Yaho holds messages back (with an optional template nudge) and posts them when the person writes.
 */
export class WhatsAppBridge {
  ctx: Ctx;
  api: WhatsAppApi | null = null;
  status: WhatsAppStatus = { configured: false, connected: false, owner: false, linked: false, window_open: false };
  private chats: ChatMessage[] = [];
  private listener = (e: BusEvent) => {
    if (e.type === 'message') void this.onMessage(e.message as Message & { deleted?: boolean }).catch((err) => this.fail(err));
  };
  connect: (token: string, phoneId: string) => WhatsAppApi;

  constructor(ctx: Ctx, connect?: (token: string, phoneId: string) => WhatsAppApi) {
    this.ctx = ctx;
    this.connect = connect ?? realApi;
  }

  get settings() {
    return this.ctx.settings.whatsapp ?? {};
  }

  private save(patch: Partial<NonNullable<Ctx['settings']['whatsapp']>>) {
    this.ctx.settings.whatsapp = { ...this.settings, ...patch };
    saveSettings(this.ctx.settings);
  }

  private setStatus(next: Partial<WhatsAppStatus>) {
    this.status = { ...this.status, ...next, owner: !!digits(this.settings.number), linked: !!this.settings.since, window_open: this.windowOpen() };
    this.ctx.bus.emitEvent({ type: 'changed', entity: 'whatsapp' });
  }

  private fail(err: unknown) {
    console.error(`[whatsapp] ${(err as Error)?.stack ?? String(err)}`);
    this.setStatus({ error: (err as Error).message ?? String(err) });
  }

  windowOpen(): boolean {
    const last = this.settings.last_inbound;
    return !!last && Date.now() - Date.parse(last) < WINDOW_MS;
  }

  /** The token the webhook's verification handshake must present; made once. */
  verifyToken(): string {
    if (!this.settings.verify_token) this.save({ verify_token: randomBytes(16).toString('hex') });
    return this.settings.verify_token!;
  }

  async start(): Promise<void> {
    this.stop();
    this.verifyToken();
    const { access_token, phone_number_id, app_secret } = this.settings;
    if (!access_token || !phone_number_id || !app_secret) return this.setStatus({ configured: false, connected: false, error: undefined, number: undefined });
    this.setStatus({ configured: true, connected: false, error: undefined });
    try {
      const api = this.connect(access_token, phone_number_id);
      const who = await api.phone();
      this.api = api;
      this.ctx.bus.on('event', this.listener);
      this.setStatus({ connected: true, number: who.number, name: who.name });
      await this.catchUp();
    } catch (err) {
      this.fail(err);
    }
  }

  stop(): void {
    this.ctx.bus.off('event', this.listener);
    this.api = null;
    if (this.status.connected) this.setStatus({ connected: false });
  }

  // ---------- out: the inbox into WhatsApp ----------

  private postsFor(id: string): Array<{ wamid: string; actions: number; outcome: string }> {
    return this.ctx.db.prepare('SELECT wamid, actions, outcome FROM whatsapp_posts WHERE message = ? ORDER BY created').all(id) as never;
  }

  private messageAt(wamid: string): string | undefined {
    const r = this.ctx.db.prepare('SELECT message FROM whatsapp_posts WHERE wamid = ?').get(wamid) as Row | undefined;
    return r ? (r.message as string) : undefined;
  }

  private answerOf(id: string): string | undefined {
    const r = this.ctx.db
      .prepare("SELECT body FROM messages WHERE reply_to = ? AND from_addr = 'human' ORDER BY created DESC LIMIT 1")
      .get(id) as Row | undefined;
    return r ? String(r.body) : undefined;
  }

  private wanted(m: Message): boolean {
    if (m.to !== 'human' || m.from === 'human') return false;
    return this.settings.post !== 'expects_response' || m.expects_response;
  }

  /** Send to the person; a closed window is remembered so nothing more is tried until they write. */
  private async send(payload: Payload): Promise<string | null> {
    const to = digits(this.settings.number);
    if (!this.api || !to) return null;
    try {
      return await this.api.send(to, payload);
    } catch (err) {
      if (err instanceof WhatsAppError && err.code !== undefined && WINDOW_CLOSED.has(err.code)) {
        this.save({ last_inbound: undefined });
        this.setStatus({});
        return null;
      }
      throw err;
    }
  }

  private async text(body: string): Promise<void> {
    for (const c of chunks(body)) await this.send({ type: 'text', text: { body: c, preview_url: false } });
  }

  async onMessage(m: Message & { deleted?: boolean }): Promise<void> {
    if (!this.api) return;
    // WhatsApp has no way for a business to delete a message: forget it, so its buttons do nothing.
    if (m.deleted) return void this.ctx.db.prepare('DELETE FROM whatsapp_posts WHERE message = ?').run(m.id);
    if (m.from === 'human' && m.reply_to) return this.refresh(m.reply_to);
    if (!this.wanted(m)) return;
    if (this.postsFor(m.id).length) return this.refresh(m.id);
    await this.post(s.getMessage(this.ctx, m.id));
  }

  async post(m: Message): Promise<void> {
    if (!this.api || !this.settings.since) return;
    if (!this.windowOpen()) return this.nudge();
    for (const { payload, actions } of messagePayloads(m)) {
      const wamid = await this.send(payload);
      if (!wamid) return this.nudge();
      this.ctx.db
        .prepare('INSERT OR REPLACE INTO whatsapp_posts (wamid, message, actions, outcome, created) VALUES (?, ?, ?, ?, ?)')
        .run(wamid, m.id, actions ? 1 : 0, '', new Date().toISOString());
    }
  }

  /** Answered or read shows as a reaction on the message's buttons (a business cannot edit a sent message). */
  async refresh(id: string): Promise<void> {
    const post = this.postsFor(id).filter((p) => p.actions).at(-1);
    if (!post || !this.api || !this.windowOpen()) return;
    let m: Message;
    try {
      m = s.getMessage(this.ctx, id);
    } catch {
      return;
    }
    const outcome = this.answerOf(id) !== undefined ? '✅' : m.read ? '☑️' : '';
    if (outcome === post.outcome) return;
    if (await this.send({ type: 'reaction', reaction: { message_id: post.wamid, emoji: outcome } }))
      this.ctx.db.prepare('UPDATE whatsapp_posts SET outcome = ? WHERE wamid = ?').run(outcome, post.wamid);
  }

  /**
   * Outside the 24-hour window only an approved template may be sent: with one configured, say once (until the person
   * writes again) that messages are waiting. Writing back opens the window and catchUp posts them.
   */
  async nudge(): Promise<void> {
    const { template, nudged, last_inbound } = this.settings;
    if (!template || !this.api || (nudged && (!last_inbound || nudged > last_inbound))) return;
    const waiting = this.pending();
    if (!waiting.length) return;
    const first = waiting[0]!;
    const summary = `${first.from.replace(/^agent:/, '')}: ${first.title || first.body.slice(0, 80)}${waiting.length > 1 ? ` (+${waiting.length - 1} more)` : ''}`;
    await this.api.send(digits(this.settings.number), {
      type: 'template',
      template: {
        name: template,
        language: { code: this.settings.template_language || 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: summary.replace(/\s+/g, ' ').slice(0, 900) }] }],
      },
    });
    this.save({ nudged: new Date().toISOString() });
  }

  /** Messages since WhatsApp was linked that are not in WhatsApp yet. */
  private pending(): Message[] {
    if (!this.settings.since) return [];
    const rows = this.ctx.db
      .prepare(
        `SELECT id FROM messages WHERE to_addr = 'human' AND from_addr != 'human' AND created >= ?
         AND id NOT IN (SELECT message FROM whatsapp_posts) ORDER BY created`,
      )
      .all(this.settings.since) as Row[];
    return rows.map((r) => s.getMessage(this.ctx, r.id as string)).filter((m) => this.wanted(m));
  }

  async catchUp(): Promise<void> {
    if (!this.windowOpen()) return;
    for (const m of this.pending()) await this.post(m);
  }

  async postBacklog(): Promise<number> {
    const rows = this.ctx.db
      .prepare(
        `SELECT id FROM messages WHERE to_addr = 'human' AND from_addr != 'human' AND read = 0
         AND id NOT IN (SELECT message FROM whatsapp_posts) ORDER BY created`,
      )
      .all() as Row[];
    let n = 0;
    for (const r of rows) {
      const m = s.getMessage(this.ctx, r.id as string);
      if (!this.wanted(m)) continue;
      await this.post(m);
      n++;
    }
    return n;
  }

  // ---------- in: WhatsApp into Yaho ----------

  /** A verified webhook delivery: messages and statuses for our number. */
  async webhook(body: Row): Promise<void> {
    this.setStatus({ last_webhook: new Date().toISOString() });
    for (const entry of (body.entry as Row[]) ?? [])
      for (const change of (entry.changes as Row[]) ?? []) {
        const value = (change.value ?? {}) as Row;
        if (change.field !== 'messages' || (value.metadata as Row | undefined)?.phone_number_id !== this.settings.phone_number_id) continue;
        for (const msg of (value.messages as Row[]) ?? []) await this.incoming(msg).catch((err) => this.fail(err));
      }
  }

  private async incoming(msg: Row): Promise<void> {
    if (process.env.YAHO_DEBUG === '1') console.error(`[whatsapp] ${String(msg.type)}`);
    const owner = digits(this.settings.number);
    if (!owner || digits(msg.from as string) !== owner || !this.api) return;
    const wasOpen = this.windowOpen();
    this.save({ last_inbound: new Date().toISOString() });
    this.setStatus({});
    if (!this.settings.since) await this.link();
    else if (!wasOpen) await this.catchUp();

    if (msg.type === 'reaction') {
      const r = msg.reaction as Row;
      const id = this.messageAt(r.message_id as string);
      if (id && CHECKS.includes(String(r.emoji))) s.markRead(this.ctx, id, true);
      return;
    }
    if (msg.type === 'interactive') {
      const i = msg.interactive as Row;
      const reply = (i.button_reply ?? i.list_reply) as Row | undefined;
      const action = reply && parseAction(String(reply.id));
      if (action) await this.act(action);
      return;
    }
    // A tap on a template's quick-reply button only opens the window.
    if (msg.type === 'button') return;
    if (msg.type !== 'text') return this.text('Yaho reads text messages only.');
    const text = String((msg.text as Row).body ?? '').trim();
    if (!text) return;
    const quoted = (msg.context as Row | undefined)?.id as string | undefined;
    const id = quoted ? this.messageAt(quoted) : undefined;
    if (id) return this.reply(id, text);
    if (text.startsWith('/')) return this.text(await this.command(text.slice(1)));
    return this.ask(text);
  }

  /** The first message from the person's number links WhatsApp: from then on their inbox is posted here. */
  private async link(): Promise<void> {
    this.save({ since: new Date().toISOString() });
    this.setStatus({});
    const unread = s.unreadCount(this.ctx);
    const body = '*Yaho is connected.* New messages from your agents arrive here. Answer with the buttons, or swipe to reply. Send /help for commands.';
    if (!unread) return this.text(body);
    await this.send({
      type: 'interactive',
      interactive: { type: 'button', body: { text: body }, action: { buttons: [{ type: 'reply', reply: { id: 'backlog:', title: `Post ${Math.min(unread, 999)} Unread` } }] } },
    });
  }

  private reply(id: string, body: string): void {
    const m = s.getMessage(this.ctx, id);
    s.sendMessage(this.ctx, { from: 'human', to: m.from, type: 'reply', body, reply_to: id });
    s.markRead(this.ctx, id, true);
  }

  private async act(a: Action): Promise<void> {
    if (a.kind === 'backlog') return void (await this.postBacklog());
    let m: Message;
    try {
      m = s.getMessage(this.ctx, a.message);
    } catch {
      return this.text('That message is no longer in Yaho.');
    }
    if (a.kind === 'read') return s.markRead(this.ctx, m.id, true);
    const answered = this.answerOf(m.id);
    if (answered !== undefined) return this.text(`Already answered: ${answered.slice(0, 200)}`);
    if (a.kind !== 'choice') return this.reply(m.id, 'Done');
    const choice = m.choices?.[a.index];
    if (choice !== undefined) this.reply(m.id, choice);
  }

  /** /run <agent>, /send <agent> <text>, /inbox, /help. */
  async command(line: string): Promise<string> {
    const [verb = 'help', ...rest] = line.trim().split(/\s+/);
    try {
      if (verb === 'run' && rest[0]) {
        if (!s.agentExists(this.ctx, rest[0])) return `No agent named ${rest[0]}.`;
        this.ctx.runner?.enqueue(rest[0], 'manual', { detail: 'from WhatsApp', force: true });
        return `Started ${rest[0]}.`;
      }
      if (verb === 'send' && rest[0] && rest.length > 1) {
        s.sendMessage(this.ctx, { from: 'human', to: `agent:${rest[0]}`, type: 'info', body: rest.slice(1).join(' ') });
        return `Sent to ${rest[0]}.`;
      }
      if (verb === 'inbox') {
        const unread = s.listMessages(this.ctx, { to: 'human', unread: true, limit: 20 });
        return unread.length
          ? unread.map((m) => `• *${m.from.replace(/^agent:/, '')}*: ${m.title || m.body.slice(0, 80)}`).join('\n')
          : 'Your inbox is all read.';
      }
    } catch (err) {
      return `That did not work: ${(err as Error).message}`;
    }
    return '/run <agent> · /send <agent> <message> · /inbox\nAnything else you write goes to Yaho’s chat. Swipe to reply to an agent’s message to answer it.';
  }

  /** Text that is not a reply goes to Chat with Yaho; the conversation is kept briefly. */
  async ask(text: string): Promise<void> {
    const history = [...this.chats, { role: 'user' as const, content: text }];
    try {
      const r = await chat(this.ctx, history);
      this.chats = r.messages.slice(-20);
      const answer = ([...r.messages].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content)?.content as string | undefined) ?? 'Done.';
      await this.text(toWhatsApp(answer));
    } catch (err) {
      await this.text(`That did not work: ${(err as Error).message}`);
    }
  }
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * The webhook Meta calls, open like /api/health: GET is the subscription handshake (the verify token), POST a delivery
 * signed with the app secret (X-Hub-Signature-256). Deliveries are acknowledged at once and handled after.
 */
export async function handleWhatsAppWebhook(ctx: Ctx, raw: IncomingMessage, res: ServerResponse, query: URLSearchParams, read: () => Promise<Buffer>): Promise<void> {
  const bridge = ctx.whatsapp;
  const plain = (status: number, body = '') => void res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);
  if (!bridge) return plain(404);
  if (raw.method === 'GET') {
    const token = query.get('hub.verify_token') ?? '';
    if (query.get('hub.mode') === 'subscribe' && bridge.settings.verify_token && eq(token, bridge.settings.verify_token)) return plain(200, query.get('hub.challenge') ?? '');
    return plain(403);
  }
  if (raw.method !== 'POST') return plain(405);
  const secret = bridge.settings.app_secret;
  const bytes = await read();
  const sig = String(raw.headers['x-hub-signature-256'] ?? '');
  if (!secret || !eq(sig, `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`)) return plain(401);
  plain(200);
  let body: Row;
  try {
    body = JSON.parse(bytes.toString('utf8')) as Row;
  } catch {
    return;
  }
  await bridge.webhook(body).catch((err) => console.error(`[whatsapp] ${(err as Error).stack ?? err}`));
}

/** The real Cloud API over fetch. */
function realApi(token: string, phoneId: string): WhatsAppApi {
  const call = async (path: string, init?: RequestInit) => {
    const r = await fetch(`${GRAPH}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const body = (await r.json().catch(() => ({}))) as Row;
    if (!r.ok) {
      const e = (body.error ?? {}) as Row;
      throw new WhatsAppError(String(e.error_user_msg ?? e.message ?? `HTTP ${r.status}`), e.code as number | undefined);
    }
    return body;
  };
  return {
    phone: async () => {
      const r = await call(`${encodeURIComponent(phoneId)}?fields=display_phone_number,verified_name`);
      return { number: r.display_phone_number as string | undefined, name: r.verified_name as string | undefined };
    },
    send: async (to, payload) => {
      const r = await call(`${encodeURIComponent(phoneId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }),
      });
      return String(((r.messages as Row[] | undefined)?.[0] as Row | undefined)?.id ?? '');
    },
  };
}
