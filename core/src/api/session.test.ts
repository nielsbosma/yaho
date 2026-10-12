import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';

const PASSWORD = 'correct horse battery';
let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;
const at = (path: string, init: RequestInit = {}) => fetch(`${ctx.apiUrl}${path}`, init);
const signIn = (password: string) =>
  at('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
const cookieOf = (res: Response) => res.headers.get('set-cookie')!.split(';')[0]!;

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
    expect(await (await at('/api/session')).json()).toEqual({ server: true, signed_in: false });
    expect((await at('/api/agents')).status).toBe(401);
    expect((await at('/api/agents', { headers: { Authorization: `Bearer ${ctx.apiToken}` } })).status).toBe(200);
  });

  it('signs in with the password and keeps the session in a cookie', async () => {
    expect((await signIn('wrong password here')).status).toBe(401);
    const res = await signIn(PASSWORD);
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(res.headers.get('set-cookie')).toMatch(/SameSite=Strict/);
    expect((await at('/api/agents', { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await at('/api/state', { headers: { Cookie: cookie } }).then((r) => r.json())).server).toBe(true);
    // A forged or altered cookie is refused.
    expect((await at('/api/agents', { headers: { Cookie: cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) } })).status).toBe(401);
  });

  it('shows the API token only after the password, and Sign Out Everywhere ends every session', async () => {
    const cookie = cookieOf(await signIn(PASSWORD));
    const headers = { Cookie: cookie, 'Content-Type': 'application/json' };
    expect((await at('/api/session/token', { method: 'POST', headers, body: JSON.stringify({ password: 'nope nope nope' }) })).status).toBe(401);
    const shown = await at('/api/session/token', { method: 'POST', headers, body: JSON.stringify({ password: PASSWORD }) });
    expect((await shown.json()).token).toBe(ctx.apiToken);
    expect((await at('/api/session/revoke-all', { method: 'POST', headers })).status).toBe(200);
    expect((await at('/api/agents', { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('locks an address out after five wrong passwords', async () => {
    for (let i = 0; i < 5; i++) await signIn('still the wrong one');
    const res = await signIn(PASSWORD);
    expect(res.status).toBe(429);
  });
});
