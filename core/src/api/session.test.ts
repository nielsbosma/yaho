import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import { loadTotp, totpCode } from './session.ts';

const PASSWORD = 'correct horse battery';
let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;
const at = (path: string, init: RequestInit = {}) => fetch(`${ctx.apiUrl}${path}`, init);
const json = (body: unknown, cookie?: string) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});
const signIn = (password: string, code?: string) => at('/api/session', json({ password, code }));
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;

let key: Buffer;
const fromBase32 = (s: string) => {
  const bits = [...s].map((c) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0')).join('');
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
};
const step = () => Math.floor(Date.now() / 30_000);
/** A fresh code: codes work once, so start each use with nothing used yet. */
const code = (ahead = 0) => {
  loadTotp(ctx);
  return totpCode(key, step() + ahead);
};

beforeAll(async () => {
  process.env.YAHO_SERVER = '1';
  process.env.YAHO_PASSWORD = PASSWORD;
  dir = mkdtempSync(join(tmpdir(), 'yaho-session-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, host: '127.0.0.1', embedded: true }));
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_SERVER;
  delete process.env.YAHO_PASSWORD;
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('server sign-in', () => {
  it('needs a session or the token for everything but health and sign-in', async () => {
    expect((await at('/api/health')).status).toBe(200);
    expect(await (await at('/api/session')).json()).toEqual({ server: true, signed_in: false, totp: false, totp_setup: false });
    expect((await at('/api/agents')).status).toBe(401);
    expect((await at('/api/agents', { headers: { Authorization: `Bearer ${ctx.apiToken}` } })).status).toBe(200);
  });

  it('sets up the authenticator after the first password sign-in', async () => {
    expect((await signIn('wrong password here')).status).toBe(401);
    const res = await signIn(PASSWORD);
    expect(await res.json()).toEqual({ signed_in: false, totp_setup: true });
    const setup = cookieOf(res);
    // A setup session can only set up the authenticator.
    expect((await at('/api/agents', { headers: { Cookie: setup } })).status).toBe(401);
    expect(await (await at('/api/session', { headers: { Cookie: setup } })).json()).toMatchObject({ signed_in: false, totp: false, totp_setup: true });
    expect((await at('/api/session/totp')).status).toBe(401);
    const shown = await (await at('/api/session/totp', { headers: { Cookie: setup } })).json();
    expect(shown.uri).toMatch(/^otpauth:\/\/totp\/Yaho%3A.*secret=[A-Z2-7]{32}&issuer=Yaho/);
    key = fromBase32(shown.secret);
    expect((await at('/api/session/totp', json({ code: '000000' }, setup))).status).toBe(401);
    const done = await at('/api/session/totp', json({ code: totpCode(key, step()) }, setup));
    expect(done.status).toBe(200);
    const full = cookieOf(done);
    expect((await at('/api/agents', { headers: { Cookie: full } })).status).toBe(200);
    // The setup session ends with it, and the password alone no longer signs in.
    expect((await at('/api/session/totp', { headers: { Cookie: setup } })).status).toBe(401);
    expect((await signIn(PASSWORD)).status).toBe(401);
  });

  it('signs in with the password and a code, each code once, and keeps the session in a cookie', async () => {
    expect((await signIn('wrong password here', code())).status).toBe(401);
    const once = code(1);
    const res = await signIn(PASSWORD, once);
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(res.headers.get('set-cookie')).toMatch(/SameSite=Strict/);
    expect((await at('/api/agents', { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await at('/api/state', { headers: { Cookie: cookie } }).then((r) => r.json())).server).toBe(true);
    // A forged or altered cookie is refused.
    expect((await at('/api/agents', { headers: { Cookie: cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) } })).status).toBe(401);
    // The same code again is refused.
    expect((await signIn(PASSWORD, once)).status).toBe(401);
  });

  it('shows the API token only after the password and a code, and Sign Out Everywhere ends every session', async () => {
    const cookie = cookieOf(await signIn(PASSWORD, code()));
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    expect((await at('/api/session/token', json({ password: 'nope nope nope', code: code() }, cookie))).status).toBe(401);
    expect((await at('/api/session/token', json({ password: PASSWORD }, cookie))).status).toBe(401);
    const shown = await at('/api/session/token', json({ password: PASSWORD, code: code() }, cookie));
    expect((await shown.json()).token).toBe(ctx.apiToken);
    expect((await at('/api/session/revoke-all', { method: 'POST', headers })).status).toBe(200);
    expect((await at('/api/agents', { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('YAHO_TOTP_RESET=1 forgets the authenticator and ends every session', async () => {
    const cookie = cookieOf(await signIn(PASSWORD, code()));
    process.env.YAHO_TOTP_RESET = '1';
    loadTotp(ctx);
    expect(process.env.YAHO_TOTP_RESET).toBeUndefined();
    expect((await at('/api/agents', { headers: { Cookie: cookie } })).status).toBe(401);
    expect(await (await signIn(PASSWORD)).json()).toEqual({ signed_in: false, totp_setup: true });
  });

  it('locks an address out after five wrong passwords', async () => {
    for (let i = 0; i < 5; i++) await signIn('still the wrong one');
    const res = await signIn(PASSWORD);
    expect(res.status).toBe(429);
  });
});
