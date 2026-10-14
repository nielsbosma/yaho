import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from '../context.ts';
import { HttpError } from '../store.ts';

/**
 * The server version's sign-in: the password (YAHO_PASSWORD, set in the deploy and left there) and, with YAHO_TOTP=1,
 * a code from an authenticator app (TOTP). The authenticator's secret is made on the server and kept in the data
 * folder; until it is set up, the password gives a session that can only set it up. YAHO_TOTP_RESET=1 forgets it, for
 * a lost phone.
 * Sessions are signed with a key derived from the password, the authenticator's secret, the API token and a counter,
 * so changing either, or "Sign Out Everywhere", ends every session at once. The desktop does not use any of this: it
 * keeps its API token.
 */
export const serverMode = () => process.env.YAHO_SERVER === '1';

const COOKIE = 'yaho_session';
const DAYS = 30;
export const MIN_PASSWORD = 12;
/** The largest sign-in request: a password and a code. */
export const SESSION_BODY = 4096;

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

/** Whether the deploy asks for an authenticator code (YAHO_TOTP=1); forget its secret when it says so, and read it. */
export function loadTotp(ctx: Ctx): void {
  secret = null;
  pending = null;
  lastStep = -1;
  enabled = serverMode() && process.env.YAHO_TOTP === '1';
  if (!serverMode()) return;
  const reset = process.env.YAHO_TOTP_RESET === '1';
  delete process.env.YAHO_TOTP_RESET;
  if (reset && existsSync(ctx.paths.totp)) {
    rmSync(ctx.paths.totp);
    console.warn('[yaho] YAHO_TOTP_RESET=1: the authenticator was removed. Sign in with the password to set it up again, then remove YAHO_TOTP_RESET.');
  }
  if (enabled && existsSync(ctx.paths.totp)) secret = Buffer.from(readFileSync(ctx.paths.totp, 'utf8').trim(), 'hex');
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function key(ctx: Ctx): Buffer {
  const epoch = ctx.settings.server.session_epoch ?? 0;
  return createHmac('sha256', ctx.apiToken).update(`${password}\n${epoch}\n${secret?.toString('hex') ?? ''}`).digest();
}

const sign = (ctx: Ctx, payload: string) => createHmac('sha256', key(ctx)).update(payload).digest('base64url');

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // Some other site's cookie with a bad % escape: not ours, skip it.
    }
  }
  return out;
}

/** Behind Sliplane or Caddy (YAHO_TRUST_PROXY=1) the request arrives as HTTP; the proxy says it was HTTPS. */
const isHttps = (req: IncomingMessage) =>
  !!(req.socket as { encrypted?: boolean }).encrypted ||
  (process.env.YAHO_TRUST_PROXY === '1' && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim() === 'https');

function setCookie(req: IncomingMessage, res: ServerResponse, value: string, maxAge: number): void {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** A full session uses the app; a setup session (password only, no authenticator yet) can only set one up. */
type Level = 'full' | 'setup';

/** The session on this request, if any (and renew it when past half its life). */
function sessionLevel(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Level | null {
  if (!serverMode()) return null;
  const c = cookies(req)[COOKIE];
  if (!c) return null;
  const [payload, sig] = c.split('.');
  if (!payload || !sig || !eq(sig, sign(ctx, payload))) return null;
  const [expires, level] = payload.split(':');
  if (level !== 'full' && !(level === 'setup' && needsSetup())) return null;
  const left = Number(expires) - Date.now();
  if (!(left > 0)) return null;
  if (left < (DAYS / 2) * 864e5) issue(ctx, req, res, level);
  return level;
}

/** A valid full session cookie on this request. */
export const sessionValid = (ctx: Ctx, req: IncomingMessage, res: ServerResponse) => sessionLevel(ctx, req, res) === 'full';

function issue(ctx: Ctx, req: IncomingMessage, res: ServerResponse, level: Level): void {
  const payload = `${Date.now() + DAYS * 864e5}:${level}`;
  setCookie(req, res, `${payload}.${sign(ctx, payload)}`, DAYS * 86400);
}

// ---- the authenticator: RFC 6238, the defaults every app uses (SHA-1, 6 digits, 30 seconds) ----
let enabled = false;
let secret: Buffer | null = null;
const needsSetup = () => enabled && !secret;
/** The secret being set up, shown as a QR code until a code from it confirms it. */
let pending: Buffer | null = null;
/** The last time step a code was used for: a code works once. */
let lastStep = -1;

const STEP = 30_000;

export function totpCode(key: Buffer, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', key).update(msg).digest();
  return String((h.readUInt32BE(h[19]! & 15) & 0x7fffffff) % 1e6).padStart(6, '0');
}

/** The time step a code is for, allowing one step either side for a clock that is a little off. */
function codeStep(key: Buffer, given: unknown, after: number): number | null {
  if (typeof given !== 'string') return null;
  const code = given.replace(/\s/g, '');
  const now = Math.floor(Date.now() / STEP);
  for (const s of [now - 1, now, now + 1]) if (s > after && eq(code, totpCode(key, s))) return s;
  return null;
}

function base32(buf: Buffer): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += abc[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
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

/**
 * Check the password, and the authenticator's code once it is set up, with the lockout. Throws 429 while locked out,
 * 401 when wrong; which of the two was wrong is not said.
 */
function checkPassword(req: IncomingMessage, given: unknown, code?: unknown): void {
  attempt(req, () => {
    if (!(typeof given === 'string' && eq(given, configured()))) return false;
    if (!secret) return true;
    const s = codeStep(secret, code, lastStep);
    if (s === null) return false;
    lastStep = s;
    return true;
  }, secret ? 'Wrong password or code.' : 'Wrong password.');
}

/** Throw 429 while this address is locked out: checked before the request's body is even read. */
function checkLockout(req: IncomingMessage): void {
  const f = fails.get(clientAddress(req));
  if (f && f.until > Date.now()) throw new HttpError(429, `Too many wrong passwords. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minutes.`);
}

/**
 * One guess against the lockout: five wrong lock the address out, and a cap for everyone. The right answer still
 * signs in while the cap is reached, so guesses from elsewhere cannot keep the owner out.
 */
function attempt(req: IncomingMessage, ok: () => boolean, wrong: string): void {
  checkLockout(req);
  const ip = clientAddress(req);
  const f = fails.get(ip) ?? { count: 0, until: 0, level: 0 };
  recent = recent.filter((t) => t > Date.now() - 60_000);
  if (ok()) {
    fails.delete(ip);
    return;
  }
  f.count++;
  const capped = recent.length >= GLOBAL_PER_MINUTE;
  if (!capped) recent.push(Date.now());
  console.warn(`[yaho] wrong sign-in from ${ip} (${f.count})`);
  if (fails.size >= MAX_TRACKED && !fails.has(ip)) fails.delete(fails.keys().next().value!);
  if (f.count >= 5) {
    f.until = Date.now() + 15 * 60_000 * 2 ** f.level;
    f.level++;
    f.count = 0;
  }
  fails.set(ip, f);
  if (capped) throw new HttpError(429, 'Too many wrong passwords on this server just now. Try again in a minute.');
  throw new HttpError(401, wrong);
}

/** The open session routes: whether this is a server and signed in, sign in, sign out, and setting up the authenticator. */
export async function sessionRoute(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: () => Promise<Record<string, unknown>>,
): Promise<unknown | undefined> {
  if (path === '/api/session/totp') return totpSetup(ctx, req, res, body);
  if (path !== '/api/session') return undefined;
  if (req.method === 'GET') {
    const level = sessionLevel(ctx, req, res);
    return { server: serverMode(), signed_in: level === 'full', totp: !!secret, totp_setup: level === 'setup' };
  }
  if (!serverMode()) throw new HttpError(404, 'sign-in is only used by the server version');
  if (req.method === 'POST') {
    checkLockout(req);
    const b = await body();
    checkPassword(req, b.password, b.code);
    const setup = needsSetup();
    issue(ctx, req, res, setup ? 'setup' : 'full');
    return { signed_in: !setup, totp_setup: setup };
  }
  if (req.method === 'DELETE') {
    setCookie(req, res, '', 0);
    return { signed_in: false };
  }
  throw new HttpError(405, 'method not allowed');
}

/**
 * Set up the authenticator, with a setup session: GET shows the secret to scan, POST with a code from it saves it and
 * makes the session a full one.
 */
async function totpSetup(ctx: Ctx, req: IncomingMessage, res: ServerResponse, body: () => Promise<Record<string, unknown>>): Promise<unknown> {
  if (sessionLevel(ctx, req, res) !== 'setup') throw new HttpError(401, 'sign in with the password first');
  pending ??= randomBytes(20);
  const key = pending;
  if (req.method === 'GET') {
    const label = encodeURIComponent(`Yaho:${req.headers.host ?? 'server'}`);
    const b32 = base32(key);
    return { secret: b32, uri: `otpauth://totp/${label}?secret=${b32}&issuer=Yaho&algorithm=SHA1&digits=6&period=30` };
  }
  if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
  checkLockout(req);
  const code = (await body()).code;
  let step: number | null = null;
  attempt(req, () => (step = codeStep(key, code, -1)) !== null, 'That code does not match. Check the time on your phone and try the next one.');
  writeFileSync(ctx.paths.totp, key.toString('hex'), { mode: 0o600 });
  secret = key;
  pending = null;
  lastStep = step!;
  issue(ctx, req, res, 'full');
  return { signed_in: true };
}

/** Show the API token (for the CLI and scripts) after asking for the password and code again. */
export function revealToken(ctx: Ctx, req: IncomingMessage, password: unknown, code: unknown): { token: string } {
  checkPassword(req, password, code);
  return { token: ctx.apiToken };
}
