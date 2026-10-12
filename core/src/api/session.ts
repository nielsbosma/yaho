import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from '../context.ts';
import { HttpError } from '../store.ts';

/**
 * The server version's sign-in. The password is YAHO_PASSWORD, set in the deploy and left there; signing in gives a
 * session cookie. Sessions are signed with a key derived from the password, the API token (a random file in the data
 * folder) and a counter, so changing the password or "Sign Out Everywhere" ends every session at once. The desktop
 * does not use any of this: it keeps its API token.
 */
export const serverMode = () => process.env.YAHO_SERVER === '1';

const COOKIE = 'yaho_session';
const DAYS = 30;
export const MIN_PASSWORD = 12;

/** Refuse to run a server without a usable password: a new server is found by bots within minutes. */
export function checkServerPassword(): void {
  if (!serverMode()) return;
  const pw = process.env.YAHO_PASSWORD ?? '';
  if (!pw)
    throw new Error('Set YAHO_PASSWORD: without it anyone who finds this server could use it. Add it to the environment and start again.');
  if (pw.length < MIN_PASSWORD) throw new Error(`YAHO_PASSWORD is too short: use at least ${MIN_PASSWORD} characters.`);
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function key(ctx: Ctx): Buffer {
  const epoch = ctx.settings.server.session_epoch ?? 0;
  return createHmac('sha256', ctx.apiToken).update(`${process.env.YAHO_PASSWORD ?? ''}\n${epoch}`).digest();
}

const sign = (ctx: Ctx, payload: string) => createHmac('sha256', key(ctx)).update(payload).digest('base64url');

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Behind Sliplane or Caddy the request arrives as HTTP; the proxy says it was HTTPS. */
const isHttps = (req: IncomingMessage) => req.headers['x-forwarded-proto'] === 'https' || !!(req.socket as { encrypted?: boolean }).encrypted;

function setCookie(req: IncomingMessage, res: ServerResponse, value: string, maxAge: number): void {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** A valid session cookie on this request (and renew it when past half its life). */
export function sessionValid(ctx: Ctx, req: IncomingMessage, res: ServerResponse): boolean {
  if (!serverMode()) return false;
  const c = cookies(req)[COOKIE];
  if (!c) return false;
  const [expires, sig] = c.split('.');
  if (!expires || !sig || !eq(sig, sign(ctx, expires))) return false;
  const left = Number(expires) - Date.now();
  if (!(left > 0)) return false;
  if (left < (DAYS / 2) * 864e5) issue(ctx, req, res);
  return true;
}

function issue(ctx: Ctx, req: IncomingMessage, res: ServerResponse): void {
  const expires = String(Date.now() + DAYS * 864e5);
  setCookie(req, res, `${expires}.${sign(ctx, expires)}`, DAYS * 86400);
}

// ---- brute force: five wrong passwords lock the address out, 15 minutes and doubling ----
const fails = new Map<string, { count: number; until: number; level: number }>();

function clientAddress(req: IncomingMessage): string {
  if (process.env.YAHO_TRUST_PROXY === '1') {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Check a password, with the lockout. Throws 429 while locked out, 401 when wrong. */
function checkPassword(req: IncomingMessage, password: unknown): void {
  const ip = clientAddress(req);
  const f = fails.get(ip) ?? { count: 0, until: 0, level: 0 };
  if (f.until > Date.now()) throw new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minutes.`);
  if (typeof password === 'string' && eq(password, process.env.YAHO_PASSWORD ?? randomBytes(16).toString('hex'))) {
    fails.delete(ip);
    return;
  }
  f.count++;
  console.warn(`[yaho] wrong password from ${ip} (${f.count})`);
  if (f.count >= 5) {
    f.until = Date.now() + 15 * 60_000 * 2 ** f.level;
    f.level++;
    f.count = 0;
  }
  fails.set(ip, f);
  throw new HttpError(401, 'Wrong password.');
}

/** The open session routes: whether this is a server and signed in, sign in, sign out. */
export async function sessionRoute(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: () => Promise<Record<string, unknown>>,
): Promise<unknown | undefined> {
  if (path !== '/api/session') return undefined;
  if (req.method === 'GET') return { server: serverMode(), signed_in: sessionValid(ctx, req, res) };
  if (!serverMode()) throw new HttpError(404, 'sign-in is only used by the server version');
  if (req.method === 'POST') {
    checkPassword(req, (await body()).password);
    issue(ctx, req, res);
    return { signed_in: true };
  }
  if (req.method === 'DELETE') {
    setCookie(req, res, '', 0);
    return { signed_in: false };
  }
  throw new HttpError(405, 'method not allowed');
}

/** Show the API token (for the CLI and scripts) after asking for the password again. */
export function revealToken(ctx: Ctx, req: IncomingMessage, password: unknown): { token: string } {
  checkPassword(req, password);
  return { token: ctx.apiToken };
}
