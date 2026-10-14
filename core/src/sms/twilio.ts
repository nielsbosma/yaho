import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from '../context.ts';
import { now } from '../db/index.ts';
import { errorText, phoneAllowed, RateLimit, serial } from '../mirror/util.ts';
import * as s from '../store.ts';
import { HttpError } from '../store.ts';

type Row = Record<string, unknown>;

const API = 'https://api.twilio.com/2010-04-01';
export const WEBHOOK_PATH = '/api/twilio/webhook';
/** Texts one agent may send in 24 hours, so a looping agent cannot flood anyone or run up the bill. */
export const DAILY_LIMIT = 50;
/** Twilio's limit for one message body (it splits it into segments). */
export const MAX_LENGTH = 1600;
/** Carrier keywords Twilio answers itself (opt-out and opt-in); they never reach an agent. */
const KEYWORDS = /^(stop|stopall|unsubscribe|cancel|end|quit|start|unstop)$/i;
/** Inbound texts taken per phone and per agent in an hour; more are dropped, so a stranger cannot start job after job. */
export const INBOUND_PER_SENDER = 20;
export const INBOUND_PER_AGENT = 100;
const HOUR = 3600_000;

/**
 * settings.twilio, with allow (the only phones that may text in; empty: any) and public_url (the address Twilio calls,
 * such as https://yaho.example.com, which webhook signatures are checked against; unset: the request's own host).
 */
type TwilioSettings = NonNullable<Ctx['settings']['twilio']> & { allow?: string | string[]; public_url?: string };

export interface OutgoingSms {
  from: string;
  to: string;
  body: string;
}

export interface ReceivedSms {
  sid: string;
  from: string;
  to: string;
  body: string;
  media: number;
}

/** The Twilio calls Yaho makes; the real API, or a fake in tests. */
export interface TwilioApi {
  /** The account's own record of the number, or null when the account does not have it. */
  number(phone: string): Promise<{ phone: string; sms_url: string } | null>;
  /** Returns Twilio's sid for the message. */
  send(sms: OutgoingSms): Promise<string>;
}

export interface SmsStatus {
  configured: boolean;
  connected: boolean;
  number?: string;
  /** Where the number's "A message comes in" webhook points in Twilio. */
  sms_url?: string;
  last_webhook?: string;
  /** The last inbound text that was dropped, and why. */
  last_ignored?: string;
  error?: string;
}

/** A phone number in E.164 (+46701234567), or '' when it is not one. */
export function phone(v: unknown): string {
  const p = String(v ?? '')
    .replace(/[\s\-().]/g, '')
    .replace(/^00/, '+');
  return /^\+[1-9]\d{6,14}$/.test(p) ? p : '';
}

/**
 * Twilio signs webhooks with HMAC-SHA1 of the full URL it called followed by every POST parameter, sorted by name, as
 * name+value, keyed by the account's auth token.
 */
export function signature(token: string, url: string, params: URLSearchParams): string {
  const data = [...params.keys()]
    .filter((k, i, all) => all.indexOf(k) === i)
    .sort()
    .map((k) =>
      params
        .getAll(k)
        .sort()
        .map((v) => k + v)
        .join(''),
    )
    .join('');
  return createHmac('sha1', token)
    .update(url + data)
    .digest('base64');
}

export function verifyWebhook(token: string, urls: string[], params: URLSearchParams, given: string): boolean {
  const g = Buffer.from(given);
  return urls.some((url) => {
    const e = Buffer.from(signature(token, url, params));
    return e.length === g.length && timingSafeEqual(e, g);
  });
}

/**
 * The URLs Twilio may have called: the configured public URL, or else (behind a tunnel or proxy the request reaches
 * Yaho as plain http on another host) what the request's headers say.
 */
function calledUrls(raw: IncomingMessage, base?: string): string[] {
  if (base?.trim()) return [`${base.trim().replace(/\/+$/, '')}${raw.url ?? WEBHOOK_PATH}`];
  const first = (h: string | string[] | undefined) =>
    String(Array.isArray(h) ? h[0] : (h ?? ''))
      .split(',')[0]!
      .trim();
  const hosts = [first(raw.headers['x-forwarded-host']), first(raw.headers.host)].filter(Boolean);
  const protos = [first(raw.headers['x-forwarded-proto']), 'https', 'http'].filter(Boolean);
  const path = raw.url ?? WEBHOOK_PATH;
  return [...new Set(hosts.flatMap((h) => protos.map((p) => `${p}://${h}${path}`)))];
}

/**
 * Text messages for agents through Twilio. Agents with SMS on share one Twilio number: they text from it with
 * yaho sms send, and a text to the number goes to the agent that last texted that phone (or, for a phone no agent has
 * texted, to the agent set for new texts). Each lands in the agent's inbox as a message from sms:<phone>, threaded under
 * the conversation, and starts a job like any inbox message.
 */
export class SmsBridge {
  ctx: Ctx;
  api: TwilioApi | null = null;
  status: SmsStatus = { configured: false, connected: false };
  connect: (sid: string, token: string) => TwilioApi;
  private bySender = new RateLimit(INBOUND_PER_SENDER, HOUR);
  private byAgent = new RateLimit(INBOUND_PER_AGENT, HOUR);

  constructor(ctx: Ctx, connect?: (sid: string, token: string) => TwilioApi) {
    this.ctx = ctx;
    this.connect = connect ?? realApi;
  }

  get settings(): TwilioSettings {
    return this.ctx.settings.twilio ?? {};
  }

  get number(): string {
    return phone(this.settings.number);
  }

  private setStatus(next: Partial<SmsStatus>) {
    this.status = { ...this.status, ...next };
    this.ctx.bus.emitEvent({ type: 'changed', entity: 'twilio' });
  }

  fail(err: unknown) {
    console.error(`[twilio] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    this.setStatus({ error: errorText(err) });
  }

  private ignore(why: string) {
    if (process.env.YAHO_DEBUG === '1') console.error(`[twilio] ignored: ${why}`);
    this.setStatus({ last_ignored: `${new Date().toISOString()} ${why}` });
  }

  async start(): Promise<void> {
    this.api = null;
    const { account_sid, auth_token } = this.settings;
    if (!account_sid || !auth_token || !this.number)
      return this.setStatus({ configured: false, connected: false, error: undefined, number: undefined, sms_url: undefined });
    this.setStatus({ configured: true, connected: false, error: undefined, number: this.number });
    const api = this.connect(account_sid, auth_token);
    this.api = api;
    try {
      const n = await api.number(this.number);
      this.setStatus({
        connected: true,
        sms_url: n?.sms_url ?? undefined,
        error: n ? undefined : `${this.number} is not a phone number in this Twilio account`,
      });
    } catch (err) {
      this.setStatus({ connected: false, error: errorText(err) });
    }
  }

  stop(): void {
    this.api = null;
  }

  enabledFor(agent: string): boolean {
    return !!this.api && !!this.number && s.agentExists(this.ctx, agent) && !!s.getAgent(this.ctx, agent).sms;
  }

  /** The latest message of an agent's conversation with a phone. */
  private lastOf(agent: string, to: string): string | null {
    const r = this.ctx.db
      .prepare('SELECT message FROM sms WHERE agent = ? AND phone = ? ORDER BY created DESC, rowid DESC LIMIT 1')
      .get(agent, to) as Row | undefined;
    return (r?.message as string | undefined) ?? null;
  }

  // ---------- out ----------

  /** Text a phone, or with reply_to (a text in the agent's inbox) the phone that sent it. */
  async send(
    agent: string,
    job: string | null,
    input: { to?: string; body?: string; reply_to?: string },
  ): Promise<{ id: string; to: string; from: string }> {
    if (!this.api || !this.number) throw new HttpError(400, 'SMS is not set up in Yaho (Settings → Integrations → SMS)');
    if (!s.getAgent(this.ctx, agent).sms) throw new HttpError(403, 'SMS is not turned on for you; the human turns it on in your settings');
    const body = String(input.body ?? '').trim();
    if (!body) throw new HttpError(400, 'the text needs a body');
    if (body.length > MAX_LENGTH) throw new HttpError(400, `the text is ${body.length} characters, the limit is ${MAX_LENGTH}`);
    let to = phone(input.to);
    if (input.reply_to) {
      const prev = this.ctx.db.prepare('SELECT agent, phone FROM sms WHERE message = ?').get(input.reply_to) as Row | undefined;
      if (!prev || prev.agent !== agent) throw new HttpError(400, `${input.reply_to} is not one of your text messages`);
      to ||= prev.phone as string;
    }
    if (!to)
      throw new HttpError(
        400,
        input.to ? `${input.to} is not a phone number; use the international form, +46701234567` : 'to is required: a phone number',
      );
    if (to === this.number) throw new HttpError(400, `${to} is Yaho's own number; use yaho send to reach other agents`);
    const api = this.api;
    const from = this.number;
    // One send per agent at a time, so concurrent sends cannot all pass the daily check.
    return serial(`sms:${agent}`, () => this.sendNow(api, from, agent, job, to, body, input.reply_to));
  }

  private async sendNow(
    api: TwilioApi,
    from: string,
    agent: string,
    job: string | null,
    to: string,
    body: string,
    replyTo: string | undefined,
  ): Promise<{ id: string; to: string; from: string }> {
    const sent = Number(
      (
        this.ctx.db
          .prepare("SELECT COUNT(*) n FROM sms WHERE agent = ? AND direction = 'out' AND created > ?")
          .get(agent, new Date(Date.now() - 86_400_000).toISOString()) as Row
      ).n,
    );
    if (sent >= DAILY_LIMIT) throw new HttpError(429, `you have sent ${sent} texts in the last 24 hours, the limit is ${DAILY_LIMIT}`);

    const sid = await api.send({ from, to, body });
    const last = replyTo ?? this.lastOf(agent, to);
    const msg = s.sendMessage(this.ctx, {
      from: `agent:${agent}`,
      to: `sms:${to}`,
      type: last ? 'reply' : 'info',
      title: '',
      body,
      reply_to: last,
      job,
      expects_response: false,
      wake: false,
    });
    this.ctx.db
      .prepare('INSERT INTO sms (message, agent, phone, direction, sid, created) VALUES (?,?,?,?,?,?)')
      .run(msg.id, agent, to, 'out', sid, now());
    return { id: msg.id, to, from };
  }

  // ---------- in ----------

  async receive(sms: ReceivedSms): Promise<void> {
    this.setStatus({ last_webhook: new Date().toISOString() });
    const from = phone(sms.from);
    if (!from) return this.ignore(`from ${sms.from || 'no number'}: not a phone number`);
    if (phone(sms.to) !== this.number) return this.ignore(`to ${sms.to}, not ${this.number}`);
    if (sms.sid && this.ctx.db.prepare('SELECT 1 FROM sms WHERE sid = ?').get(sms.sid)) return;
    if (KEYWORDS.test(sms.body.trim())) return this.ignore(`${sms.body.trim().toUpperCase()} from ${from}, which Twilio handles`);
    if (!phoneAllowed(this.settings.allow, from)) return this.ignore(`from ${from}: not on the allowed numbers`);

    const latest = this.ctx.db.prepare('SELECT agent FROM sms WHERE phone = ? ORDER BY created DESC, rowid DESC LIMIT 1').get(from) as
      | Row
      | undefined;
    const agent = (latest?.agent as string | undefined) ?? this.settings.new_agent;
    if (!agent) return this.ignore(`from ${from}: no agent has texted this number`);
    if (!this.enabledFor(agent)) return this.ignore(`from ${from}: ${agent} does not have SMS on`);
    if (!this.bySender.take(from)) return this.ignore(`from ${from}: more than ${INBOUND_PER_SENDER} texts in an hour`);
    if (!this.byAgent.take(agent)) return this.ignore(`from ${from}: ${agent} got more than ${INBOUND_PER_AGENT} texts in an hour`);

    const last = this.lastOf(agent, from);
    const text = sms.body.trim() || '(empty text)';
    const msg = s.sendMessage(this.ctx, {
      from: `sms:${from}`,
      to: `agent:${agent}`,
      type: last ? 'reply' : 'info',
      title: '',
      body: sms.media
        ? `${text}\n\n(${sms.media} picture${sms.media > 1 ? 's' : ''} or file${sms.media > 1 ? 's' : ''}, not downloaded)`
        : text,
      reply_to: last,
      expects_response: false,
    });
    this.ctx.db
      .prepare('INSERT INTO sms (message, agent, phone, direction, sid, created) VALUES (?,?,?,?,?,?)')
      .run(msg.id, agent, from, 'in', sms.sid || null, now());
  }
}

/** Twilio's webhook for incoming texts, open like /api/health and checked by its signature. */
export async function handleTwilioWebhook(ctx: Ctx, raw: IncomingMessage, res: ServerResponse, read: () => Promise<Buffer>): Promise<void> {
  const plain = (status: number) =>
    void res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end();
  const bridge = ctx.sms;
  if (!bridge) return plain(404);
  if (raw.method !== 'POST') return plain(405);
  const token = bridge.settings.auth_token;
  const params = new URLSearchParams((await read()).toString('utf8'));
  if (!token || !verifyWebhook(token, calledUrls(raw, bridge.settings.public_url), params, String(raw.headers['x-twilio-signature'] ?? '')))
    return plain(401);
  // Empty TwiML: Yaho answers later, if the agent decides to, with its own text.
  res
    .writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' })
    .end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  await bridge
    .receive({
      sid: params.get('MessageSid') ?? params.get('SmsSid') ?? '',
      from: params.get('From') ?? '',
      to: params.get('To') ?? '',
      body: params.get('Body') ?? '',
      media: Number(params.get('NumMedia') ?? 0) || 0,
    })
    .catch((err) => bridge.fail(err));
}

/** The real Twilio REST API over fetch. */
function realApi(sid: string, token: string): TwilioApi {
  const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
  const account = `${API}/Accounts/${encodeURIComponent(sid)}`;
  const call = async (path: string, form?: Record<string, string>) => {
    const r = await fetch(`${account}${path}`, {
      method: form ? 'POST' : 'GET',
      headers: { Authorization: auth, 'User-Agent': 'yaho', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    const body = (await r.json().catch(() => ({}))) as Row;
    if (!r.ok) throw new Error(String(body.message ?? `Twilio: HTTP ${r.status}`));
    return body;
  };
  return {
    number: async (p) => {
      const n = (
        (await call(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(p)}`)).incoming_phone_numbers as Row[] | undefined
      )?.[0];
      return n ? { phone: String(n.phone_number), sms_url: String(n.sms_url ?? '') } : null;
    },
    send: async (m) => String((await call('/Messages.json', { From: m.from, To: m.to, Body: m.body })).sid ?? ''),
  };
}
