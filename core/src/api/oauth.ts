import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Ctx } from '../context.ts';
import { HttpError } from '../store.ts';
import { readBytes } from './http.ts';
import { isHttps, sessionValid, signedBy, signFor } from './session.ts';

/**
 * Sign-in for MCP clients on the server version (OAuth 2.1, as the MCP spec asks): the client registers itself, opens
 * /oauth/authorize in the person's browser, they sign in with the password (and code) as on the website and press
 * Allow, and the client gets a token. Nothing is stored: clients, codes and tokens are signed with the sessions' key,
 * so Sign Out Everywhere or a new password ends them all.
 */

export const MCP_PATH = '/mcp';
const ACCESS_S = 60 * 60;
const REFRESH_S = 30 * 86400;
const CODE_S = 120;

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const unb64 = (s: string): unknown => {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

/** `<prefix>.<payload>.<signature>`, signed for its kind. */
const seal = (ctx: Ctx, kind: string, v: unknown) => {
  const p = b64(v);
  return `${kind}.${p}.${signFor(ctx, `oauth:${kind}`, p)}`;
};
function unseal<T>(ctx: Ctx, kind: string, token: unknown): T | null {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const [k, p, sig, extra] = token.split('.');
  if (k !== kind || !p || !sig || extra !== undefined || !signedBy(ctx, `oauth:${kind}`, p, sig)) return null;
  const v = unb64(p) as (T & { e?: number }) | null;
  if (!v || typeof v !== 'object') return null;
  if (typeof v.e === 'number' && v.e < Date.now() / 1000) return null;
  return v;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();

/** This server's address as the client reached it. */
export function baseUrl(req: IncomingMessage): string {
  const host = (process.env.YAHO_TRUST_PROXY === '1' ? first(req.headers['x-forwarded-host']) : undefined) ?? first(req.headers.host);
  return `${isHttps(req) ? 'https' : 'http'}://${host ?? '127.0.0.1'}`;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Where a client may send the person back: https, http on this computer, or an app's own scheme. */
function redirectAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') return LOOPBACK.has(u.hostname);
  return !['javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ws:', 'wss:', 'ftp:'].includes(u.protocol);
}

/** RFC 8252: a client on this computer picks its port when it signs in, so the port of a loopback address may differ. */
function sameRedirect(registered: string, given: string): boolean {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    if (a.protocol !== 'http:' || !LOOPBACK.has(a.hostname)) return false;
    a.port = '';
    b.port = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

interface Client {
  n: string;
  r: string[];
}

const clientOf = (ctx: Ctx, id: unknown) => {
  const c = unseal<Client>(ctx, 'yc', id);
  return c && typeof c.n === 'string' && Array.isArray(c.r) ? c : null;
};

/** An access token for /mcp, or null. */
export function accessValid(ctx: Ctx, token: string): boolean {
  return !!unseal(ctx, 'yat', token);
}

/** The 401 that sends an MCP client to sign in. */
export function challenge(req: IncomingMessage, res: ServerResponse, invalid: boolean): void {
  const meta = `${baseUrl(req)}/.well-known/oauth-protected-resource${MCP_PATH}`;
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'WWW-Authenticate': `Bearer resource_metadata="${meta}"${invalid ? ', error="invalid_token"' : ''}`,
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ error: invalid ? 'invalid_token' : 'sign in to use Yaho' }));
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function form(req: IncomingMessage): Promise<Record<string, string>> {
  const text = (await readBytes(req, 64 * 1024)).toString('utf8');
  if (String(req.headers['content-type'] ?? '').includes('json')) {
    try {
      const v = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(v ?? {}).map(([k, x]) => [k, typeof x === 'string' ? x : JSON.stringify(x)]));
    } catch {
      throw new HttpError(400, 'bad JSON');
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** The OAuth routes, on the server version only. True when it answered the request. */
export async function handleOAuth(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const base = baseUrl(req);
  if (path === '/.well-known/oauth-protected-resource' || path === `/.well-known/oauth-protected-resource${MCP_PATH}`) {
    json(res, 200, {
      resource: `${base}${MCP_PATH}`,
      authorization_servers: [base],
      bearer_methods_supported: ['header'],
      resource_name: 'Yaho',
    });
    return true;
  }
  if (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration') {
    json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['yaho'],
    });
    return true;
  }
  if (path === '/oauth/register' && req.method === 'POST') {
    let b: unknown = null;
    try {
      b = JSON.parse((await readBytes(req, 64 * 1024)).toString('utf8'));
    } catch {
      // Answered below as a bad request.
    }
    register(ctx, res, b);
    return true;
  }
  if (path === '/oauth/authorize' && req.method === 'GET') {
    authorizePage(ctx, res, url.searchParams);
    return true;
  }
  if (path === '/oauth/authorize' && req.method === 'POST') {
    await authorize(ctx, req, res);
    return true;
  }
  if (path === '/oauth/token' && req.method === 'POST') {
    token(ctx, res, await form(req));
    return true;
  }
  return false;
}

/** RFC 7591: any client may register; the person decides on the Allow page, which names it and where it goes. */
function register(ctx: Ctx, res: ServerResponse, body: unknown): void {
  const b = (body && typeof body === 'object' ? body : {}) as { client_name?: unknown; redirect_uris?: unknown };
  const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  if (!uris.length || uris.length > 5 || !uris.every((u) => typeof u === 'string' && u.length <= 500 && redirectAllowed(u)))
    return json(res, 400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris: one to five https or loopback addresses' });
  const name =
    (typeof b.client_name === 'string' ? b.client_name : '')
      .replace(/[\u0000-\u001f]/g, '')
      .trim()
      .slice(0, 80) || 'An MCP client';
  const client: Client = { n: name, r: uris as string[] };
  json(res, 201, {
    client_id: seal(ctx, 'yc', client),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: client.r,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
}

interface AuthParams {
  client: Client;
  clientId: string;
  redirect: string;
  state: string | null;
  challenge: string;
}

/** Check an authorize request. An unknown client or address is shown as an error, never redirected to. */
function authParams(ctx: Ctx, q: URLSearchParams): AuthParams | { page: string } | { back: string } {
  const clientId = q.get('client_id') ?? '';
  const client = clientOf(ctx, clientId);
  if (!client) return { page: 'This sign-in link is not valid. Start again from the app that sent you here.' };
  const redirect = q.get('redirect_uri') ?? (client.r.length === 1 ? client.r[0]! : '');
  if (!client.r.some((r) => sameRedirect(r, redirect)))
    return { page: 'This sign-in link sends you to an address the app did not register.' };
  const state = q.get('state');
  const back = (error: string) => {
    const u = new URL(redirect);
    u.searchParams.set('error', error);
    if (state !== null) u.searchParams.set('state', state);
    return { back: u.href };
  };
  if (q.get('response_type') !== 'code') return back('unsupported_response_type');
  const challenge = q.get('code_challenge') ?? '';
  if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return back('invalid_request');
  return { client, clientId, redirect, state, challenge };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(res: ServerResponse, body: string, script = ''): void {
  const nonce = randomBytes(16).toString('base64');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign In to Yaho</title><style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--text:#1f1f1e;--muted:#6b6b68;--line:#e3e3df;--accent:#1f1f1e;--on:#fff;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a19;--card:#242423;--text:#ececea;--muted:#a3a3a0;--line:#3a3a38;--accent:#ececea;--on:#1a1a19;--err:#f2b8b5}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif}
main{width:min(380px,calc(100vw - 32px));background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 6px}p{margin:0 0 16px;color:var(--muted)}label{display:block;font-size:13px;margin:12px 0 4px}
input{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--text);font:inherit}
.row{display:flex;gap:8px;margin-top:20px}button{flex:1;padding:9px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:var(--on);font:inherit;cursor:pointer}
button.ghost{background:transparent;color:var(--text);border-color:var(--line)}.err{color:var(--err);font-size:13px;margin-top:12px;min-height:1em}[hidden]{display:none}
strong{color:var(--text)}</style></head><body><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`);
}

function authorizePage(ctx: Ctx, res: ServerResponse, q: URLSearchParams): void {
  const p = authParams(ctx, q);
  if ('page' in p) return page(res, `<h1>Sign In to Yaho</h1><p>${esc(p.page)}</p>`);
  if ('back' in p) {
    res.writeHead(302, { Location: p.back }).end();
    return;
  }
  const to = new URL(p.redirect);
  const where =
    to.protocol === 'http:' ? 'an app on your computer' : esc(to.protocol === 'https:' ? to.host : to.protocol.replace(':', ''));
  const hidden = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'code_challenge_method', 'response_type', 'scope', 'resource']
    .map((k) => [k, k === 'redirect_uri' ? p.redirect : q.get(k)] as const)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v!)}">`)
    .join('');
  page(
    res,
    `<form id="signin" hidden><h1>Sign In to Yaho</h1><p><strong>${esc(p.client.n)}</strong> wants to use Yaho. Sign in to continue.</p>
<label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" required>
<div id="totp" hidden><label for="code">Authenticator Code</label><input id="code" inputmode="numeric" autocomplete="one-time-code"></div>
<div class="row"><button type="submit">Sign In</button></div><div class="err" id="err"></div></form>
<div id="setup" hidden><h1>Sign In to Yaho</h1><p>Open Yaho in this browser and set up the authenticator first, then come back to this page.</p></div>
<form id="allow" method="post" action="/oauth/authorize" hidden>${hidden}<h1>Allow Access</h1>
<p><strong>${esc(p.client.n)}</strong> wants to use your Yaho: it can do what Yaho's chat can, such as reading the inbox, running agents and changing them.</p>
<p>You go back to ${where} after this.</p>
<div class="row"><button class="ghost" name="decision" value="deny">Cancel</button><button name="decision" value="allow">Allow</button></div></form>`,
    `const $=(id)=>document.getElementById(id);
async function show(){const s=await (await fetch('/api/session')).json();
$('signin').hidden=s.signed_in||s.totp_setup;$('setup').hidden=!s.totp_setup;$('allow').hidden=!s.signed_in;$('totp').hidden=!s.totp;}
$('signin').addEventListener('submit',async(e)=>{e.preventDefault();$('err').textContent='';
const r=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('pw').value,code:$('code').value})});
if(!r.ok){$('err').textContent=(await r.json().catch(()=>({}))).error||'Could not sign in.';return;}show();});
show();`,
  );
}

/** Allow or Cancel on the page: a same-site form post, so the session cookie (SameSite=Strict) comes with it. */
async function authorize(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const f = await form(req);
  const p = authParams(ctx, new URLSearchParams(f));
  if ('page' in p) return page(res, `<h1>Sign In to Yaho</h1><p>${esc(p.page)}</p>`);
  if ('back' in p) {
    res.writeHead(302, { Location: p.back }).end();
    return;
  }
  if (!sessionValid(ctx, req, res)) return page(res, '<h1>Sign In to Yaho</h1><p>You are not signed in. Go back and try again.</p>');
  const u = new URL(p.redirect);
  if (f.decision === 'allow') {
    const code = seal(ctx, 'ycode', {
      c: createHash('sha256').update(p.clientId).digest('base64url'),
      r: p.redirect,
      ch: p.challenge,
      j: randomBytes(9).toString('base64url'),
      e: Math.floor(Date.now() / 1000) + CODE_S,
    });
    u.searchParams.set('code', code);
  } else u.searchParams.set('error', 'access_denied');
  if (p.state !== null) u.searchParams.set('state', p.state);
  u.searchParams.set('iss', baseUrl(req));
  res.writeHead(302, { Location: u.href }).end();
}

/** Codes already exchanged, until they would have expired anyway: a code works once. */
const used = new Map<string, number>();

function tokens(ctx: Ctx, client: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token: seal(ctx, 'yat', { c: client, e: now + ACCESS_S }),
    token_type: 'Bearer',
    expires_in: ACCESS_S,
    refresh_token: seal(ctx, 'yrt', { c: client, e: now + REFRESH_S }),
    scope: 'yaho',
  };
}

function token(ctx: Ctx, res: ServerResponse, f: Record<string, string>): void {
  const bad = (error: string, error_description: string) => json(res, 400, { error, error_description });
  const clientHash = f.client_id ? createHash('sha256').update(f.client_id).digest('base64url') : '';
  if (f.grant_type === 'authorization_code') {
    const c = unseal<{ c: string; r: string; ch: string; j: string; e: number }>(ctx, 'ycode', f.code);
    if (!c) return bad('invalid_grant', 'the code is not valid or has expired');
    if (c.c !== clientHash) return bad('invalid_grant', 'the code was made for another client');
    if (f.redirect_uri !== undefined && f.redirect_uri !== c.r) return bad('invalid_grant', 'redirect_uri does not match');
    const verifier = f.code_verifier ?? '';
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash('sha256').update(verifier).digest('base64url') !== c.ch)
      return bad('invalid_grant', 'code_verifier does not match');
    const now = Date.now() / 1000;
    for (const [k, e] of used) if (e < now) used.delete(k);
    if (used.has(c.j)) return bad('invalid_grant', 'the code was already used');
    used.set(c.j, c.e);
    return json(res, 200, tokens(ctx, c.c));
  }
  if (f.grant_type === 'refresh_token') {
    const r = unseal<{ c: string }>(ctx, 'yrt', f.refresh_token);
    if (!r || (clientHash && r.c !== clientHash)) return bad('invalid_grant', 'the refresh token is not valid; sign in again');
    return json(res, 200, tokens(ctx, r.c));
  }
  bad('unsupported_grant_type', 'authorization_code or refresh_token');
}
