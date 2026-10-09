import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { defaultSettings } from '../config.ts';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';
import type { Job } from '../store.ts';

const KEY = 'ck_test_secret_123';
const fake = fileURLToPath(new URL('../../test/fake-claude.mjs', import.meta.url));

/** Just enough of Composio's v3.1 API. */
function mockComposio() {
  const executed: Array<{ tool: string; body: Record<string, unknown> }> = [];
  const authConfigs: Array<{ id: string; toolkit: string }> = [];
  const accounts = [{ id: 'ca_gmail', status: 'ACTIVE', toolkit: { slug: 'gmail' }, user_id: 'yaho', created_at: '2026-10-01T00:00:00Z' }];
  const server: Server = createServer(async (req, res) => {
    if (req.headers['x-api-key'] !== KEY) {
      res.writeHead(401).end('{"error":{"message":"bad key"}}');
      return;
    }
    let body = '';
    for await (const c of req) body += c;
    const u = new URL(req.url!, 'http://x');
    const p = u.pathname;
    const json = (d: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(d));
    if (req.method === 'GET' && p === '/toolkits')
      return json({
        items: [
          {
            slug: 'gmail',
            name: 'Gmail',
            no_auth: false,
            composio_managed_auth_schemes: ['OAUTH2'],
            meta: { logo: 'https://l/gmail.png', description: 'Email', categories: [{ name: 'Communication' }], tools_count: 2 },
          },
          {
            slug: 'google_analytics',
            name: 'Google Analytics',
            no_auth: false,
            composio_managed_auth_schemes: ['OAUTH2'],
            meta: { logo: '', description: 'Analytics', categories: [], tools_count: 5 },
          },
        ].filter((t) => !u.searchParams.get('search') || t.slug.includes(u.searchParams.get('search')!)),
        next_cursor: null,
      });
    if (req.method === 'GET' && p.startsWith('/toolkits/'))
      return json({ slug: 'gmail', name: 'Gmail', meta: { logo: 'https://l/gmail.png', description: 'Email' } });
    if (req.method === 'GET' && p === '/connected_accounts') return json({ items: accounts, next_cursor: null });
    if (req.method === 'GET' && p.startsWith('/connected_accounts/'))
      return json(
        accounts.find((a) => a.id === p.split('/').pop()) ?? { id: 'x', status: 'INITIATED', toolkit: { slug: 'google_analytics' } },
      );
    if (req.method === 'GET' && p === '/auth_configs')
      return json({
        items: authConfigs.filter((a) => a.toolkit === u.searchParams.get('toolkit_slug')).map((a) => ({ id: a.id, status: 'ENABLED' })),
      });
    if (req.method === 'POST' && p === '/auth_configs') {
      const b = JSON.parse(body);
      const id = `ac_${b.toolkit.slug}`;
      authConfigs.push({ id, toolkit: b.toolkit.slug });
      return json({ toolkit: { slug: b.toolkit.slug }, auth_config: { id } });
    }
    if (req.method === 'POST' && p === '/connected_accounts/link') {
      const b = JSON.parse(body);
      return json({
        redirect_url: `https://connect.composio.dev/${b.auth_config_id}?user=${b.user_id}`,
        connected_account_id: 'ca_new',
        link_token: 't',
        expires_at: 'x',
      });
    }
    if (req.method === 'GET' && p === '/tools')
      return json({
        items: [
          {
            slug: 'GMAIL_SEND_EMAIL',
            name: 'Send email',
            description: 'Send an email',
            input_parameters: { type: 'object', properties: { to: { type: 'string' } } },
          },
        ],
      });
    if (req.method === 'POST' && p.startsWith('/tools/execute/')) {
      executed.push({ tool: p.split('/').pop()!, body: JSON.parse(body) });
      return json({ successful: true, data: { id: 'sent-1' }, error: null });
    }
    res.writeHead(404).end('{}');
  });
  return { server, executed, url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

const mock = mockComposio();
let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;
const api = async <T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
  const res = await fetch(`${ctx.apiUrl}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${ctx.apiToken}`, 'Content-Type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data as T;
};

beforeAll(async () => {
  await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', r));
  dir = mkdtempSync(join(tmpdir(), 'yaho-composio-'));
  const s = defaultSettings();
  s.harnesses['claude-code'] = { command: process.execPath, args: [fake] };
  s.defaults.models = ['test-model'];
  s.composio = { api_key: KEY, url: mock.url() };
  writeFileSync(join(dir, 'settings.yaml'), YAML.stringify(s));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
});
afterAll(async () => {
  await close();
  mock.server.close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('Composio resources', () => {
  it('explores apps and connections', async () => {
    expect(await api('/api/composio/status')).toEqual({ configured: true, user_id: 'yaho' });
    const tk = await api<{ items: Array<{ slug: string; categories: string[]; managed_auth: boolean }> }>(
      '/api/composio/toolkits?search=gmail',
    );
    expect(tk.items).toEqual([expect.objectContaining({ slug: 'gmail', categories: ['Communication'], managed_auth: true })]);
    const conns = await api<Array<{ id: string; toolkit: string; resources: string[] }>>('/api/composio/connections');
    expect(conns).toEqual([expect.objectContaining({ id: 'ca_gmail', toolkit: 'gmail', resources: [] })]);
  });

  it('starts a connection with a Composio-managed auth config', async () => {
    const r = await api<{ id: string; redirect_url: string }>('/api/composio/connect', { body: { toolkit: 'google_analytics' } });
    expect(r).toEqual({ id: 'ca_new', redirect_url: 'https://connect.composio.dev/ac_google_analytics?user=yaho' });
  });

  it('adds a connection as a resource that agents use through yaho tool', async () => {
    const res = await api<{ name: string; kind: string; config: Record<string, string> }>('/api/resources/composio', {
      body: { connected_account_id: 'ca_gmail' },
    });
    expect(res).toMatchObject({ name: 'gmail', kind: 'composio', config: { toolkit: 'gmail', connected_account_id: 'ca_gmail' } });
    await expect(api('/api/resources/composio', { body: { connected_account_id: 'ca_gmail' } })).rejects.toThrow(/already exists/);

    await api('/api/agents', { body: { name: 'mailer', briefing: 'x', resources: ['gmail'] } });
    mkdirSync(join(dir, 'agents', 'mailer'), { recursive: true });
    writeFileSync(
      join(dir, 'agents', 'mailer', 'steps.json'),
      JSON.stringify([
        { cmd: 'yaho tools gmail' },
        { cmd: 'yaho tool gmail GMAIL_SEND_EMAIL', stdin: 'to: niels@example.com\n' },
        { cmd: 'yaho finish' },
      ]),
    );
    const job = await api<Job>('/api/agents/mailer/run', { method: 'POST' });
    const end = Date.now() + 20_000;
    while (['queued', 'running'].includes((await api<Job>(`/api/jobs/${job.id}`)).status) && Date.now() < end)
      await new Promise((r) => setTimeout(r, 150));
    const events = await api<Array<{ kind: string; data: Record<string, unknown> }>>(`/api/jobs/${job.id}/events`);
    const outs = events.filter((e) => e.kind === 'tool_result').map((e) => String(e.data.output));
    expect(outs[0]).toContain('GMAIL_SEND_EMAIL');
    expect(outs[1]).toContain('successful: true');
    expect(mock.executed).toEqual([
      { tool: 'GMAIL_SEND_EMAIL', body: { connected_account_id: 'ca_gmail', user_id: 'yaho', arguments: { to: 'niels@example.com' } } },
    ]);
    // The Composio key stays in the core: not in the prompt, not in the job's output.
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it('refuses tool calls on resources the agent was not granted', async () => {
    await api('/api/agents', { body: { name: 'outsider', briefing: 'x' } });
    mkdirSync(join(dir, 'agents', 'outsider'), { recursive: true });
    writeFileSync(
      join(dir, 'agents', 'outsider', 'steps.json'),
      JSON.stringify([{ cmd: 'yaho tool gmail GMAIL_SEND_EMAIL' }, { cmd: 'yaho finish' }]),
    );
    const job = await api<Job>('/api/agents/outsider/run', { method: 'POST' });
    const end = Date.now() + 20_000;
    while (['queued', 'running'].includes((await api<Job>(`/api/jobs/${job.id}`)).status) && Date.now() < end)
      await new Promise((r) => setTimeout(r, 150));
    const events = await api<Array<{ kind: string; data: Record<string, unknown> }>>(`/api/jobs/${job.id}/events`);
    expect(String(events.find((e) => e.kind === 'tool_result')?.data.output)).toContain('not granted');
    expect(mock.executed).toHaveLength(1);
  });
});
