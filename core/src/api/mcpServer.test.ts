import { createHash, randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';

const PASSWORD = 'correct horse battery';
let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;

async function start(server: boolean) {
  if (server) {
    process.env.YAHO_SERVER = '1';
    process.env.YAHO_PASSWORD = PASSWORD;
  }
  dir = mkdtempSync(join(tmpdir(), 'yaho-mcp-server-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, host: '127.0.0.1', embedded: true }));
}
afterEach(async () => {
  await close();
  delete process.env.YAHO_SERVER;
  delete process.env.YAHO_PASSWORD;
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const rpc = (method: string, params: unknown, headers: Record<string, string> = {}) =>
  fetch(`${ctx.apiUrl}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

describe('Yaho MCP server on this computer', () => {
  it('needs no sign-in from a program here, and offers the chat tools', async () => {
    await start(false);
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    expect(init.status).toBe(200);
    expect((await init.json()).result.serverInfo.name).toBe('yaho');
    const list = await (await rpc('tools/list', {})).json();
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_agents', 'save_agent', 'run_agent', 'query_messages', 'get_overview']));
    expect(names).not.toContain('open_page');
    const call = await (await rpc('tools/call', { name: 'save_agent', arguments: { yaml: 'name: scout\nbriefing: look around' } })).json();
    expect(call.result.isError).toBeFalsy();
    const agents = await (await rpc('tools/call', { name: 'list_agents', arguments: {} })).json();
    expect(JSON.parse(agents.result.content[0].text).map((a: { name: string }) => a.name)).toContain('scout');
    const bad = await (await rpc('tools/call', { name: 'get_agent', arguments: { name: 'nobody' } })).json();
    expect(bad.result.isError).toBe(true);
  });

  it('refuses web pages and other names for this computer', async () => {
    await start(false);
    expect((await rpc('tools/list', {}, { Origin: 'https://evil.example' })).status).toBe(403);
    // fetch sets Host itself: a rebound name needs a raw request.
    const rebound = (headers: Record<string, string> = {}) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(ctx.apiUrl);
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const r = request(
          {
            host: u.hostname,
            port: u.port,
            path: '/mcp',
            method: 'POST',
            headers: {
              Host: 'evil.example',
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              ...headers,
            },
          },
          (res) => (res.resume(), resolve(res.statusCode!)),
        );
        r.on('error', reject);
        r.end(body);
      });
    expect(await rebound()).toBe(401);
    expect(await rebound({ Authorization: `Bearer ${ctx.apiToken}` })).toBe(200);
    const pre = await fetch(`${ctx.apiUrl}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('Yaho MCP server on a server', () => {
  it('sends a client to sign in, and lets it in after the person allows it', async () => {
    await start(true);
    const first = await rpc('tools/list', {});
    expect(first.status).toBe(401);
    const meta = /resource_metadata="([^"]+)"/.exec(first.headers.get('www-authenticate') ?? '')![1]!;
    const resource = await (await fetch(meta)).json();
    expect(resource.resource).toBe(`${ctx.apiUrl}/mcp`);
    const as = await (await fetch(`${resource.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
    expect(as.code_challenge_methods_supported).toEqual(['S256']);

    const redirect = 'http://localhost:33418/callback';
    expect(
      (await fetch(as.registration_endpoint, { method: 'POST', body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) }))
        .status,
    ).toBe(400);
    const reg = await fetch(as.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [redirect] }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json();

    const verifier = randomBytes(32).toString('base64url');
    const params = {
      response_type: 'code',
      client_id,
      redirect_uri: 'http://localhost:40001/callback',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'xyz',
    };
    const pageRes = await fetch(`${as.authorization_endpoint}?${new URLSearchParams(params)}`);
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get('x-frame-options')).toBe('DENY');
    expect(await pageRes.text()).toContain('Claude Code');
    const elsewhere = await fetch(
      `${as.authorization_endpoint}?${new URLSearchParams({ ...params, redirect_uri: 'https://evil.example/cb' })}`,
    );
    expect(await elsewhere.text()).toContain('did not register');

    const allow = (cookie?: string) =>
      fetch(as.authorization_endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
        body: new URLSearchParams({ ...params, decision: 'allow' }),
      });
    // Without signing in, no code.
    expect((await allow()).status).toBe(200);
    const signIn = await fetch(`${ctx.apiUrl}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    const cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
    const back = await allow(cookie);
    expect(back.status).toBe(302);
    const to = new URL(back.headers.get('location')!);
    expect(to.origin + to.pathname).toBe('http://localhost:40001/callback');
    expect(to.searchParams.get('state')).toBe('xyz');
    const code = to.searchParams.get('code')!;

    const exchange = (body: Record<string, string>) =>
      fetch(as.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      });
    const grant = { grant_type: 'authorization_code', code, client_id, redirect_uri: params.redirect_uri, code_verifier: verifier };
    expect((await exchange({ ...grant, code_verifier: randomBytes(32).toString('base64url') })).status).toBe(400);
    const tok = await exchange(grant);
    expect(tok.status).toBe(200);
    const t = await tok.json();
    expect((await exchange(grant)).status).toBe(400);

    expect((await rpc('tools/list', {}, { Authorization: `Bearer ${t.access_token}` })).status).toBe(200);
    expect((await rpc('tools/list', {}, { Authorization: `Bearer ${t.refresh_token}` })).status).toBe(401);
    // The token is only for /mcp.
    expect((await fetch(`${ctx.apiUrl}/api/agents`, { headers: { Authorization: `Bearer ${t.access_token}` } })).status).toBe(401);

    const refreshed = await (await exchange({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id })).json();
    expect((await rpc('tools/list', {}, { Authorization: `Bearer ${refreshed.access_token}` })).status).toBe(200);

    // Sign Out Everywhere ends them too.
    await fetch(`${ctx.apiUrl}/api/session/revoke-all`, { method: 'POST', headers: { Authorization: `Bearer ${ctx.apiToken}` } });
    expect((await rpc('tools/list', {}, { Authorization: `Bearer ${refreshed.access_token}` })).status).toBe(401);
  });
});
