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

/**
 * The password, read once at start and then removed from the environment, so that nothing the core starts (agents'
 * jobs, harnesses) inherits it and /proc/<pid>/environ of a child cannot show it.
 */
let password = '';

/** Refuse to run a server without a usable password: a new server is found by bots within minutes. */
export function checkServerPassword(): void {
  if (!serverMode()) return;
  const pw = process.env.YAHO_PASSWORD ?? password;
  password = pw;
  delete process.env.YAHO_PASSWORD;
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
  return createHmac('sha256', ctx.apiToken).update(`${password}\n${epoch}`).digest();
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

/** Never empty: an unset password must not match an empty guess. */
const configured = () => password || randomBytes(16).toString('hex');

// ---- brute force: five wrong passwords lock the address out, 15 minutes and doubling; and a cap for everyone ----
const fails = new Map<string, { count: number; until: number; level: number }>();
/** Wrong passwords in the last minute from anywhere: rotating addresses must not give unlimited guesses. */
let recent: number[] = [];
const GLOBAL_PER_MINUTE = 30;
const MAX_TRACKED = 10_000;

/**
 * Who is guessing. Behind a proxy (YAHO_TRUST_PROXY=1, as on Sliplane) the client's address is the last entry of
 * X-Forwarded-For, the one the proxy itself appended; the entries before it come from the client and can be anything.
 */
function clientAddress(req: IncomingMessage): string {
  if (process.env.YAHO_TRUST_PROXY === '1') {
    const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean).at(-1);
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Check a password, with the lockout. Throws 429 while locked out, 401 when wrong. */
function checkPassword(req: IncomingMessage, given: unknown): void {
  const ip = clientAddress(req);
  const f = fails.get(ip) ?? { count: 0, until: 0, level: 0 };
  if (f.until > Date.now()) throw new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minutes.`);
  recent = recent.filter((t) => t > Date.now() - 60_000);
  if (recent.length >= GLOBAL_PER_MINUTE) throw new HttpError(429, 'Too many wrong passwords on this server just now. Try again in a minute.');
  if (typeof given === 'string' && eq(given, configured())) {
    fails.delete(ip);
    return;
  }
  f.count++;
  recent.push(Date.now());
  console.warn(`[yaho] wrong password from ${ip} (${f.count})`);
  if (fails.size >= MAX_TRACKED && !fails.has(ip)) fails.delete(fails.keys().next().value!);
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
