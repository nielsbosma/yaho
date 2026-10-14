import { createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from '../context.ts';
import { now } from '../db/index.ts';
import { emailAllowed, eq, errorText, RateLimit, serial } from '../mirror/util.ts';
import * as s from '../store.ts';
import { HttpError } from '../store.ts';

type Row = Record<string, unknown>;

const API = 'https://api.resend.com';
/** Emails one agent may send in 24 hours, so a looping agent cannot flood anyone. */
export const DAILY_LIMIT = 50;
/** How far a webhook's timestamp may be from now, against replays. */
const TOLERANCE_S = 300;
/** Inbound emails taken per sender and per agent in an hour; more are dropped, so a stranger cannot start job after job. */
export const INBOUND_PER_SENDER = 20;
export const INBOUND_PER_AGENT = 100;
const HOUR = 3600_000;
/** HTML read for the text of an email without a text part; the rest is left out. */
const HTML_MAX = 200_000;
const MESSAGE_ID = /^<[^<>\s]+>$/;

/**
 * settings.resend, with allow (the only addresses or domains that may write in; empty: any) and participants_only
 * (a reply to a thread must come from an address already in it).
 */
type ResendSettings = NonNullable<Ctx['settings']['resend']>;

/** A Message-ID as stored: <id@host>, or null when it is not one. */
function messageId(v: unknown): string | null {
  const t = String(v ?? '').trim();
  const id = /^[^<>\s]+@[^<>\s]+$/.test(t) ? `<${t}>` : t;
  return MESSAGE_ID.test(id) ? id : null;
}

export interface OutgoingEmail {
  from: string;
  to: string[];
  cc?: string[];
  reply_to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

export interface ReceivedEmail {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
  message_id?: string;
  attachments: Array<{ filename?: string }>;
}

/** The Resend calls Yaho makes; the real API, or a fake in tests. */
export interface ResendApi {
  domains(): Promise<Array<{ name: string; status: string }>>;
  /** Returns Resend's id for the email. */
  send(email: OutgoingEmail): Promise<string>;
  received(id: string): Promise<ReceivedEmail>;
}

export interface EmailStatus {
  configured: boolean;
  connected: boolean;
  domain?: string;
  /** Resend's state for the domain: verified, pending, not_started, failed… */
  domain_status?: string;
  last_webhook?: string;
  /** The last inbound email that was dropped, and why. */
  last_ignored?: string;
  error?: string;
}

/** The bare address in "Name <a@b.com>", lower-cased; '' when there is none. */
export function address(v: unknown): string {
  const raw = typeof v === 'object' && v ? String((v as Row).email ?? (v as Row).address ?? '') : String(v ?? '');
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(raw) ?? /([^\s<>",;]+@[^\s<>",;]+)/.exec(raw);
  return m ? m[1]!.toLowerCase() : '';
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map(address).filter(Boolean);

/** Plain text from an HTML email, for senders that send no text part. */
export function htmlToText(html: string): string {
  return html
    .slice(0, HTML_MAX)
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The new part of a reply: the quoted history below it is cut (the agent has the thread already). */
export function stripQuoted(text: string): string {
  const t = text.replace(/\r\n/g, '\n');
  const cuts = [
    /^On\b[^\n]*(\n[^\n]*)?wrote:\s*$/m,
    /^Den\b[^\n]*(\n[^\n]*)?skrev[^\n]*:\s*$/m,
    /^-{2,}\s*(Original Message|Ursprungligt meddelande)\s*-{2,}/im,
    /^_{10,}\s*$/m,
    /\n(>[^\n]*(\n|$))+\s*$/,
  ]
    .map((re) => re.exec(t)?.index)
    .filter((i): i is number => i !== undefined && i > 0);
  const kept = (cuts.length ? t.slice(0, Math.min(...cuts)) : t).trim();
  return kept || t.trim();
}

/** Resend signs webhooks the Svix way: HMAC-SHA256 of "<id>.<timestamp>.<body>" with the base64 secret after whsec_. */
export function verifyWebhook(secret: string, headers: IncomingMessage['headers'], body: Buffer, at = Date.now()): boolean {
  const id = String(headers['svix-id'] ?? '');
  const ts = String(headers['svix-timestamp'] ?? '');
  const sig = String(headers['svix-signature'] ?? '');
  if (!id || !ts || !sig || !(Math.abs(at / 1000 - Number(ts)) <= TOLERANCE_S)) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.`).update(body).digest('base64');
  return sig.split(' ').some((part) => {
    const [version, value] = part.split(',');
    return version === 'v1' && !!value && eq(value, expected);
  });
}

/**
 * Email for agents through Resend. An agent with email on sends from <agent>@<domain> with a Reply-To of
 * <agent>+<thread>@<domain>; Resend's inbound webhook brings replies back, and each lands in the agent's inbox as a
 * message from email:<sender>, threaded under what it answers, which starts a job like any inbox message.
 */
export class EmailBridge {
  ctx: Ctx;
  api: ResendApi | null = null;
  status: EmailStatus = { configured: false, connected: false };
  connect: (key: string) => ResendApi;
  private bySender = new RateLimit(INBOUND_PER_SENDER, HOUR);
  private byAgent = new RateLimit(INBOUND_PER_AGENT, HOUR);

  constructor(ctx: Ctx, connect?: (key: string) => ResendApi) {
    this.ctx = ctx;
    this.connect = connect ?? realApi;
  }

  get settings(): ResendSettings {
    return this.ctx.settings.resend ?? {};
  }

  get domain(): string {
    return (this.settings.domain ?? '').trim().toLowerCase().replace(/^@/, '');
  }

  addressOf(agent: string): string {
    return `${agent}@${this.domain}`;
  }

  private setStatus(next: Partial<EmailStatus>) {
    this.status = { ...this.status, ...next };
    this.ctx.bus.emitEvent({ type: 'changed', entity: 'resend' });
  }

  fail(err: unknown) {
    console.error(`[resend] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    this.setStatus({ error: errorText(err) });
  }

  private ignore(why: string) {
    if (process.env.YAHO_DEBUG === '1') console.error(`[resend] ignored: ${why}`);
    this.setStatus({ last_ignored: `${new Date().toISOString()} ${why}` });
  }

  async start(): Promise<void> {
    this.api = null;
    const { api_key } = this.settings;
    if (!api_key || !this.domain)
      return this.setStatus({ configured: false, connected: false, error: undefined, domain: undefined, domain_status: undefined });
    this.setStatus({ configured: true, connected: false, error: undefined, domain: this.domain });
    const api = this.connect(api_key);
    this.api = api;
    try {
      const d = (await api.domains()).find((x) => x.name.toLowerCase() === this.domain);
      this.setStatus({
        connected: true,
        domain_status: d?.status ?? 'not added',
        error: d ? undefined : `${this.domain} is not a domain in this Resend account`,
      });
    } catch (err) {
      this.setStatus({ connected: false, error: errorText(err) });
    }
  }

  stop(): void {
    this.api = null;
  }

  enabledFor(agent: string): boolean {
    return !!this.api && !!this.domain && s.agentExists(this.ctx, agent) && !!s.getAgent(this.ctx, agent).email;
  }

  // ---------- out ----------

  private rowOf(message: string): Row | undefined {
    return this.ctx.db
      .prepare('SELECT e.*, t.agent, t.subject FROM emails e JOIN email_threads t ON t.token = e.thread WHERE e.message = ?')
      .get(message) as Row | undefined;
  }

  /** Send a new email, or with reply_to (a message of an email thread) the next one in that thread. */
  async send(
    agent: string,
    job: string | null,
    input: { to?: string | string[]; cc?: string | string[]; subject?: string; body?: string; reply_to?: string },
  ): Promise<{ id: string; to: string[]; subject: string; from: string }> {
    if (!this.api || !this.domain) throw new HttpError(400, 'email is not set up in Yaho (Settings → Integrations → Email)');
    if (!s.getAgent(this.ctx, agent).email)
      throw new HttpError(403, 'email is not turned on for you; the human turns it on in your settings');
    const text = String(input.body ?? '').trim();
    if (!text) throw new HttpError(400, 'the email needs a body');
    // One send per agent at a time, so concurrent sends cannot all pass the daily check.
    const api = this.api;
    return serial(`email:${agent}`, () => this.sendNow(api, agent, job, input, text));
  }

  private async sendNow(
    api: ResendApi,
    agent: string,
    job: string | null,
    input: { to?: string | string[]; cc?: string | string[]; subject?: string; reply_to?: string },
    text: string,
  ): Promise<{ id: string; to: string[]; subject: string; from: string }> {
    const sent = Number(
      (
        this.ctx.db
          .prepare(
            "SELECT COUNT(*) n FROM emails e JOIN email_threads t ON t.token = e.thread WHERE t.agent = ? AND e.direction = 'out' AND e.created > ?",
          )
          .get(agent, new Date(Date.now() - 86_400_000).toISOString()) as Row
      ).n,
    );
    if (sent >= DAILY_LIMIT) throw new HttpError(429, `you have sent ${sent} emails in the last 24 hours, the limit is ${DAILY_LIMIT}`);

    let token: string;
    let subject: string;
    let to = list(input.to);
    const cc = list(input.cc);
    const headers: Record<string, string> = {};
    if (input.reply_to) {
      const prev = this.rowOf(input.reply_to);
      if (!prev || prev.agent !== agent) throw new HttpError(400, `${input.reply_to} is not one of your email messages`);
      token = prev.thread as string;
      subject = /^re:/i.test(prev.subject as string) ? (prev.subject as string) : `Re: ${prev.subject as string}`;
      if (!to.length) to = list(String(prev.addresses));
      if (prev.message_id) headers['In-Reply-To'] = prev.message_id as string;
      const refs = (
        this.ctx.db
          .prepare('SELECT message_id FROM emails WHERE thread = ? AND message_id IS NOT NULL ORDER BY created')
          .all(token) as Row[]
      ).map((r) => r.message_id as string);
      if (refs.length) headers.References = refs.join(' ');
    } else {
      subject = String(input.subject ?? '').trim();
      if (!subject) throw new HttpError(400, 'a new email needs a subject');
      token = randomBytes(5).toString('hex');
    }
    if (!to.length) throw new HttpError(400, 'to is required: one or more email addresses');
    const own = [...to, ...cc].find((a) => a.endsWith(`@${this.domain}`));
    if (own) throw new HttpError(400, `${own} is a Yaho address; use yaho send to reach other agents`);

    const from = this.addressOf(agent);
    // Our own Message-ID, kept, so a reply sent to the plain address still finds its thread by In-Reply-To.
    const ownId = `<${randomBytes(12).toString('hex')}@${this.domain}>`;
    headers['Message-ID'] = ownId;
    const resendId = await api.send({
      from: `${agent} <${from}>`,
      to,
      ...(cc.length ? { cc } : {}),
      reply_to: `${agent}+${token}@${this.domain}`,
      subject,
      text,
      headers,
    });
    if (!input.reply_to)
      this.ctx.db.prepare('INSERT INTO email_threads (token, agent, subject, created) VALUES (?,?,?,?)').run(token, agent, subject, now());
    const msg = s.sendMessage(this.ctx, {
      from: `agent:${agent}`,
      to: `email:${to.join(', ')}`,
      type: input.reply_to ? 'reply' : 'info',
      title: subject,
      body: text,
      reply_to: input.reply_to ?? null,
      job,
      expects_response: false,
      wake: false,
    });
    this.ctx.db
      .prepare('INSERT INTO emails (message, thread, direction, addresses, resend_id, message_id, created) VALUES (?,?,?,?,?,?,?)')
      .run(msg.id, token, 'out', [...to, ...cc].join(', '), resendId, ownId, now());
    return { id: msg.id, to, subject, from };
  }

  // ---------- in ----------

  /** A verified webhook delivery. Only email.received matters. */
  async webhook(body: Row): Promise<void> {
    this.setStatus({ last_webhook: new Date().toISOString() });
    if (body.type !== 'email.received') return;
    const id = String((body.data as Row | undefined)?.email_id ?? '');
    if (!id || !this.api) return;
    await this.receive(id, await this.api.received(id));
  }

  async receive(resendId: string, email: ReceivedEmail): Promise<void> {
    const sender = address(email.from);
    if (!sender) return this.ignore('no sender');
    if (sender.endsWith(`@${this.domain}`)) return this.ignore(`from ${sender}, a Yaho address`);
    const h = Object.fromEntries(Object.entries(email.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    if (
      (h['auto-submitted'] && h['auto-submitted'] !== 'no') ||
      /^(bulk|junk|list|auto_reply)$/i.test(h.precedence ?? '') ||
      h['x-autoreply'] ||
      h['x-autorespond']
    )
      return this.ignore(`automatic email from ${sender}`);
    if (!emailAllowed(this.settings.allow, sender)) return this.ignore(`from ${sender}: not on the allowed senders`);
    if (!this.bySender.take(sender)) return this.ignore(`from ${sender}: more than ${INBOUND_PER_SENDER} emails in an hour`);

    const refs = [h['in-reply-to'], h.references].join(' ').match(/<[^<>\s]+>/g) ?? [];
    const seen = new Set<string>();
    for (const rcpt of [...list(email.to), ...list(email.cc)]) {
      if (!rcpt.endsWith(`@${this.domain}`)) continue;
      const [agent = '', tag] = rcpt.slice(0, -this.domain.length - 1).split('+');
      if (seen.has(agent)) continue;
      seen.add(agent);
      if (!this.enabledFor(agent)) {
        this.ignore(`to ${rcpt}: no agent with email on`);
        continue;
      }
      const dup = this.ctx.db
        .prepare('SELECT 1 FROM emails e JOIN email_threads t ON t.token = e.thread WHERE e.resend_id = ? AND t.agent = ?')
        .get(resendId, agent);
      if (dup) continue;

      let token = tag
        ? ((this.ctx.db.prepare('SELECT token FROM email_threads WHERE token = ? AND agent = ?').get(tag, agent) as Row | undefined)
            ?.token as string | undefined)
        : undefined;
      if (!token && refs.length)
        token = (
          this.ctx.db
            .prepare(
              `SELECT e.thread FROM emails e JOIN email_threads t ON t.token = e.thread
               WHERE t.agent = ? AND e.message_id IN (${refs.map(() => '?').join(',')}) ORDER BY e.created DESC LIMIT 1`,
            )
            .get(agent, ...refs) as Row | undefined
        )?.thread as string | undefined;
      if (token && this.settings.participants_only && !this.participant(token, sender)) {
        this.ignore(`from ${sender} to ${rcpt}: not part of that email thread`);
        continue;
      }
      if (!token && !this.settings.accept_new) {
        this.ignore(`from ${sender} to ${rcpt}: not a reply to an email the agent sent`);
        continue;
      }
      if (!this.byAgent.take(agent)) {
        this.ignore(`from ${sender}: ${agent} got more than ${INBOUND_PER_AGENT} emails in an hour`);
        continue;
      }
      if (!token) {
        token = randomBytes(5).toString('hex');
        this.ctx.db
          .prepare('INSERT INTO email_threads (token, agent, subject, created) VALUES (?,?,?,?)')
          .run(token, agent, email.subject || '(no subject)', now());
      }
      const last = this.ctx.db
        .prepare('SELECT e.message FROM emails e JOIN messages m ON m.id = e.message WHERE e.thread = ? ORDER BY e.created DESC LIMIT 1')
        .get(token) as Row | undefined;
      const text = stripQuoted(email.text?.trim() ? email.text : htmlToText(email.html ?? ''));
      const files = email.attachments?.map((a) => a.filename).filter(Boolean) ?? [];
      const body = `${text || '(empty email)'}${files.length ? `\n\n(Attachments, not downloaded: ${files.join(', ')})` : ''}`;
      const msg = s.sendMessage(this.ctx, {
        from: `email:${sender}`,
        to: `agent:${agent}`,
        type: last ? 'reply' : 'info',
        title: email.subject ?? '',
        body,
        reply_to: (last?.message as string | undefined) ?? null,
        expects_response: false,
      });
      this.ctx.db
        .prepare('INSERT INTO emails (message, thread, direction, addresses, resend_id, message_id, created) VALUES (?,?,?,?,?,?,?)')
        .run(msg.id, token, 'in', sender, resendId, messageId(email.message_id ?? h['message-id']), now());
    }
  }

  /** Whether an address already wrote in, or was written to, in a thread. */
  private participant(token: string, sender: string): boolean {
    const rows = this.ctx.db.prepare('SELECT addresses FROM emails WHERE thread = ?').all(token) as Row[];
    return rows.some((r) => list(String(r.addresses)).includes(sender));
  }
}

/** Resend's webhook, open like /api/health and checked by its signing secret. Acknowledged at once, handled after. */
export async function handleResendWebhook(ctx: Ctx, raw: IncomingMessage, res: ServerResponse, read: () => Promise<Buffer>): Promise<void> {
  const plain = (status: number) =>
    void res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end();
  const bridge = ctx.email;
  if (!bridge) return plain(404);
  if (raw.method !== 'POST') return plain(405);
  const secret = bridge.settings.webhook_secret;
  const bytes = await read();
  if (!secret || !verifyWebhook(secret, raw.headers, bytes)) return plain(401);
  plain(200);
  let body: Row;
  try {
    body = JSON.parse(bytes.toString('utf8')) as Row;
  } catch {
    return;
  }
  await bridge.webhook(body).catch((err) => bridge.fail(err));
}

/** The real Resend API over fetch. */
function realApi(key: string): ResendApi {
  const call = async (path: string, init?: RequestInit) => {
    const r = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'yaho' },
    });
    const body = (await r.json().catch(() => ({}))) as Row;
    if (!r.ok) throw new Error(String(body.message ?? `Resend: HTTP ${r.status}`));
    return body;
  };
  return {
    domains: async () =>
      (((await call('/domains')).data as Row[] | undefined) ?? []).map((d) => ({ name: String(d.name), status: String(d.status ?? '') })),
    send: async (email) => String((await call('/emails', { method: 'POST', body: JSON.stringify(email) })).id ?? ''),
    received: async (id) => {
      const r = await call(`/emails/receiving/${encodeURIComponent(id)}`);
      return {
        from: String(r.from ?? ''),
        to: list(r.to),
        cc: list(r.cc),
        subject: String(r.subject ?? ''),
        text: (r.text as string | null) ?? null,
        html: (r.html as string | null) ?? null,
        headers: (r.headers as Record<string, string> | undefined) ?? {},
        message_id: r.message_id as string | undefined,
        attachments: (r.attachments as Array<{ filename?: string }> | undefined) ?? [],
      };
    },
  };
}
