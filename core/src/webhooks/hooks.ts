import { createHmac, timingSafeEqual } from 'node:crypto';
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Ctx } from '../context.ts';
import { newId, now } from '../db/index.ts';
import { assertUnder, UnsafePathError, writeFileUnder } from '../fsSafe.ts';
import { verifyWebhook as verifySvix } from '../email/resend.ts';
import * as s from '../store.ts';
import { HttpError, type WebhookVerify } from '../store.ts';

type Row = Record<string, unknown>;

export const HOOK_PREFIX = '/api/hooks/';
/** The largest body a webhook accepts. */
export const MAX_BODY = 1024 * 1024;
/** How far a signed timestamp may be from now, against replays. */
const TOLERANCE_S = 5 * 60;
/** How much of the payload the inbox message shows; the whole of it is a file in the agent's workspace. */
const PREVIEW = 4000;
/** Payload files kept per webhook. */
const KEEP_FILES = 100;
/** Headers that may carry the sender's id for a delivery, so a retry of it is dropped (unsigned webhooks only). */
const DELIVERY_HEADERS = ['x-github-delivery', 'svix-id', 'webhook-id', 'idempotency-key', 'x-yaho-delivery'];
/** Rejected deliveries a webhook answers in a minute before it stops looking at more. */
const REJECTS_PER_MINUTE = 20;
const rejections = new Map<string, number[]>();
/** Headers that name what happened; shown in the inbox message. */
const EVENT_HEADERS = ['x-github-event', 'x-gitlab-event', 'x-event-type', 'x-yaho-event'];

export interface WebhookInfo {
  id: string;
  agent: string;
  name: string;
  path: string;
  verify: WebhookVerify;
  secret: string;
  instructions: string;
  limit: number;
  paused: boolean;
  last_delivery: string | null;
  last_rejected: string | null;
  deliveries_24h: number;
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const header = (headers: IncomingMessage['headers'], name: string) => {
  const v = headers[name];
  return String(Array.isArray(v) ? v[0] : (v ?? '')).trim();
};

/** Stripe's scheme, which Yaho's own uses too: "t=<unix>,v1=<hex HMAC-SHA256 of '<t>.<body>'>". */
export function stripeSignature(secret: string, t: number | string, body: Buffer): string {
  return createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
}

const stripeTime = (given: string) =>
  given
    .split(',')
    .map((p) => p.trim().split('='))
    .find(([k]) => k === 't')?.[1] ?? '';

function verifyStripeStyle(secret: string, given: string, body: Buffer, at: number): boolean {
  const parts = given.split(',').map((p) => p.trim().split('=') as [string, string?]);
  const t = stripeTime(given);
  if (!t || !(Math.abs(at / 1000 - Number(t)) <= TOLERANCE_S)) return false;
  const expected = stripeSignature(secret, t, body);
  return parts.some(([k, v]) => k === 'v1' && !!v && eq(v, expected));
}

/**
 * The id that repeats of a delivery share, for dropping them: from what the signature covers when there is one, so a
 * captured delivery sent again with a new id header is still a repeat. Call it after the signature checked out.
 */
export function deliveryId(verify: WebhookVerify, secret: string, headers: IncomingMessage['headers'], body: Buffer): string {
  switch (verify) {
    case 'none':
      return DELIVERY_HEADERS.map((h) => header(headers, h)).find(Boolean) ?? '';
    case 'github':
      // GitHub signs the body alone, with no time: the signature is the delivery.
      return `sha256:${createHmac('sha256', secret).update(body).digest('hex')}`;
    case 'stripe': {
      // Stripe's event id is in the signed body, and stays the same when Stripe retries.
      try {
        const id = (JSON.parse(body.toString('utf8')) as Row | null)?.id;
        if (typeof id === 'string' && id) return `evt:${id}`;
      } catch {
        // Fall back to the signed time.
      }
      const t = stripeTime(header(headers, 'stripe-signature'));
      return `t:${t}:${stripeSignature(secret, t, body)}`;
    }
    case 'yaho': {
      const t = stripeTime(header(headers, 'x-yaho-signature'));
      return `t:${t}:${stripeSignature(secret, t, body)}`;
    }
    case 'svix':
      // The id is part of what Svix signs.
      return header(headers, 'svix-id') || header(headers, 'webhook-id');
  }
}

/** Whether a delivery carries a valid signature for the webhook's scheme. 'none' relies on the URL token alone. */
export function verifySignature(
  verify: WebhookVerify,
  secret: string,
  headers: IncomingMessage['headers'],
  body: Buffer,
  at = Date.now(),
): boolean {
  switch (verify) {
    case 'none':
      return true;
    case 'github':
      return eq(header(headers, 'x-hub-signature-256'), `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
    case 'stripe':
      return verifyStripeStyle(secret, header(headers, 'stripe-signature'), body, at);
    case 'yaho':
      return verifyStripeStyle(secret, header(headers, 'x-yaho-signature'), body, at);
    case 'svix': {
      // Standard Webhooks name the same headers webhook-*; Svix names them svix-*.
      const std = !headers['svix-id'] && !!headers['webhook-id'];
      const h = std
        ? {
            'svix-id': headers['webhook-id'],
            'svix-timestamp': headers['webhook-timestamp'],
            'svix-signature': headers['webhook-signature'],
          }
        : headers;
      return verifySvix(secret, h, body, at);
    }
  }
}

function info(ctx: Ctx, r: Row): WebhookInfo {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  return {
    id: r.id as string,
    agent: r.agent as string,
    name: r.name as string,
    path: HOOK_PREFIX + (r.token as string),
    verify: r.verify as WebhookVerify,
    secret: r.secret as string,
    instructions: r.instructions as string,
    limit: r.hourly_limit as number,
    paused: !!r.paused,
    last_delivery: (r.last_delivery as string | null) ?? null,
    last_rejected: (r.last_rejected as string | null) ?? null,
    deliveries_24h: Number(
      (ctx.db.prepare('SELECT COUNT(*) n FROM webhook_deliveries WHERE webhook = ? AND created > ?').get(r.id as string, since) as Row).n,
    ),
  };
}

/** Every webhook, or one agent's, with its URL path and secret: for the human only. */
export function listWebhooks(ctx: Ctx, agent?: string): WebhookInfo[] {
  const rows = agent
    ? ctx.db.prepare('SELECT * FROM webhooks WHERE agent = ? ORDER BY created, name').all(agent)
    : ctx.db.prepare('SELECT * FROM webhooks ORDER BY agent, created, name').all();
  return (rows as Row[]).map((r) => info(ctx, r));
}

function getWebhook(ctx: Ctx, id: string): Row {
  const r = ctx.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new HttpError(404, `webhook ${id} not found`);
  return r;
}

/** A new URL token, so the old URL stops working. */
export function rotateUrl(ctx: Ctx, id: string): WebhookInfo {
  getWebhook(ctx, id);
  ctx.db.prepare('UPDATE webhooks SET token = ? WHERE id = ?').run(s.webhookToken(), id);
  ctx.bus.emitEvent({ type: 'changed', entity: 'webhooks' });
  return info(ctx, getWebhook(ctx, id));
}

/** Set the signing secret: the one the sender gave (Stripe, Svix), or a fresh one when none is given. */
export function setSecret(ctx: Ctx, id: string, secret?: string): WebhookInfo {
  const w = getWebhook(ctx, id);
  const next = secret?.trim() || s.webhookSecret(w.verify as string);
  if (next.length < 16) throw new HttpError(400, 'a signing secret needs at least 16 characters');
  ctx.db.prepare('UPDATE webhooks SET secret = ? WHERE id = ?').run(next, id);
  ctx.bus.emitEvent({ type: 'changed', entity: 'webhooks' });
  return info(ctx, getWebhook(ctx, id));
}

/** The webhook that started a job, for its prompt. */
export function deliveryForJob(ctx: Ctx, job: string): { name: string; instructions: string; file: string; message: string | null } | null {
  const r = ctx.db
    .prepare(
      'SELECT w.name, w.instructions, d.file, d.message FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook WHERE d.job = ?',
    )
    .get(job) as Row | undefined;
  return r
    ? { name: r.name as string, instructions: r.instructions as string, file: r.file as string, message: (r.message as string) ?? null }
    : null;
}

function extension(type: string): string {
  if (type.includes('json')) return 'json';
  if (type.includes('xml')) return 'xml';
  if (type.includes('x-www-form-urlencoded')) return 'form.txt';
  return 'txt';
}

function preview(body: Buffer, type: string): string {
  let text = body.toString('utf8');
  if (type.includes('json') && body.length <= PREVIEW * 4) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Shown as sent.
    }
  }
  return text.length > PREVIEW ? `${text.slice(0, PREVIEW)}\n… (${body.length} bytes in all)` : text;
}

/** Keep the newest payload files. A symlink is removed itself, never followed. */
function prune(root: string, dir: string): void {
  try {
    assertUnder(root, dir);
  } catch {
    return;
  }
  const files = readdirSync(dir).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_FILES))) {
    const p = join(dir, f);
    if (!lstatSync(p, { throwIfNoEntry: false })?.isDirectory()) rmSync(p, { force: true });
  }
}

/**
 * A webhook delivery, open like /api/health: the token in the URL finds the webhook, and its signature scheme (if any)
 * is checked. An accepted delivery is saved in the agent's workspace, shown in its inbox, and starts a job.
 */
export async function handleWebhook(
  ctx: Ctx,
  raw: IncomingMessage,
  res: ServerResponse,
  token: string,
  read: () => Promise<Buffer>,
): Promise<void> {
  const reply = (status: number, body: Row) =>
    void res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
  if (raw.method !== 'POST') return reply(405, { error: 'POST only' });
  const w = token ? (ctx.db.prepare('SELECT * FROM webhooks WHERE token = ?').get(token) as Row | undefined) : undefined;
  if (!w) return reply(404, { error: 'no such webhook' });
  const id = w.id as string;
  const agent = w.agent as string;
  const name = w.name as string;
  // Past the limit of rejected deliveries, refuse without reading the body or touching the database.
  const recent = (rejections.get(id) ?? []).filter((t) => t > Date.now() - 60_000);
  rejections.set(id, recent);
  if (recent.length >= REJECTS_PER_MINUTE) return reply(429, { error: 'too many rejected deliveries; try again in a minute' });
  const reject = (status: number, why: string) => {
    recent.push(Date.now());
    ctx.db.prepare('UPDATE webhooks SET last_rejected = ? WHERE id = ?').run(`${now()} ${why}`, id);
    ctx.bus.emitEvent({ type: 'changed', entity: 'webhooks' });
    if (process.env.YAHO_DEBUG === '1') console.error(`[webhook] ${agent}/${name} rejected: ${why}`);
    reply(status, { error: why });
  };

  let body: Buffer;
  try {
    body = await read();
  } catch (e) {
    if (e instanceof HttpError && e.status === 413) return reject(413, `body over ${MAX_BODY} bytes`);
    throw e;
  }
  if (w.paused) return reject(403, 'webhook is paused');
  if (!verifySignature(w.verify as WebhookVerify, w.secret as string, raw.headers, body)) return reject(401, 'signature check failed');

  const type = header(raw.headers, 'content-type').toLowerCase();
  const delivery = deliveryId(w.verify as WebhookVerify, w.secret as string, raw.headers, body).slice(0, 200);
  if (delivery && ctx.db.prepare('SELECT 1 FROM webhook_deliveries WHERE webhook = ? AND delivery = ?').get(id, delivery))
    return reply(200, { ok: true, duplicate: true });
  const hour = new Date(Date.now() - 3_600_000).toISOString();
  const count = Number(
    (ctx.db.prepare('SELECT COUNT(*) n FROM webhook_deliveries WHERE webhook = ? AND created > ?').get(id, hour) as Row).n,
  );
  if (count >= (w.hourly_limit as number)) return reject(429, `over the limit of ${w.hourly_limit} deliveries an hour`);
  if (!s.getAgent(ctx, agent).enabled) return reject(202, 'agent is disabled');

  const ts = now();
  const did = newId('dlv');
  const workspace = s.ensureAgentWorkspace(ctx, agent);
  const file = `webhooks/${name}/${ts.replace(/[:.]/g, '-')}-${did}.${extension(type)}`;
  try {
    // Under the agents' folder (the core's), so a workspace swapped for a symlink is refused too.
    writeFileUnder(ctx.paths.agents, join(agent, file), body);
  } catch (e) {
    if (e instanceof UnsafePathError) return reject(500, `webhooks/${name} in the workspace is not a plain folder`);
    throw e;
  }

  const event = EVENT_HEADERS.map((h) => header(raw.headers, h)).find(Boolean);
  const shown = DELIVERY_HEADERS.map((h) => header(raw.headers, h)).find(Boolean)?.slice(0, 200);
  let msg: s.Message | undefined;
  try {
    msg = s.sendMessage(ctx, {
      from: `webhook:${name}`,
      to: `agent:${agent}`,
      type: 'info',
      title: event ? `Webhook ${name}: ${event}` : `Webhook ${name}`,
      body: [
        `Content type: ${type || 'none'}${shown ? `\nDelivery: ${shown}` : ''}`,
        `The whole payload is in your workspace at \`${file}\`.`,
        body.length ? `\`\`\`\n${preview(body, type)}\n\`\`\`` : '(empty body)',
      ].join('\n\n'),
      expects_response: false,
      wake: false,
    });
    ctx.db
      .prepare('INSERT INTO webhook_deliveries (id, webhook, delivery, job, message, file, created) VALUES (?,?,?,?,?,?,?)')
      .run(did, id, delivery || null, null, msg.id, file, ts);
  } catch (e) {
    // Leave nothing behind for a delivery that was not recorded.
    rmSync(join(workspace, file), { force: true });
    if (msg) s.deleteMessage(ctx, msg.id);
    throw e;
  }
  prune(ctx.paths.agents, join(workspace, 'webhooks', name));
  const job = ctx.runner?.enqueue(agent, 'webhook', { detail: name }) as s.Job | null | undefined;
  if (job) ctx.db.prepare('UPDATE webhook_deliveries SET job = ? WHERE id = ?').run(job.id, did);
  ctx.db.prepare('UPDATE webhooks SET last_delivery = ? WHERE id = ?').run(ts, id);
  ctx.bus.emitEvent({ type: 'changed', entity: 'webhooks' });
  reply(202, { ok: true, job: job?.id ?? null, message: msg.id });
}
