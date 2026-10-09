import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import type { Ctx } from '../context.ts';
import { serve } from '../serve.ts';

let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;
const api = (path: string, init: RequestInit = {}) =>
  fetch(`${ctx.apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${ctx.apiToken}`, 'Content-Type': 'application/json', ...init.headers },
  });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yaho-api-'));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
});
afterAll(async () => {
  await close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('API', () => {
  it('health is open, everything else needs the token', async () => {
    expect((await fetch(`${ctx.apiUrl}/api/health`)).status).toBe(200);
    expect((await fetch(`${ctx.apiUrl}/api/agents`)).status).toBe(401);
    expect((await fetch(`${ctx.apiUrl}/api/agents`, { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
    expect((await api('/api/agents')).status).toBe(200);
    expect((await fetch(`${ctx.apiUrl}/api/agents?token=${ctx.apiToken}`)).status).toBe(200);
  });

  it('speaks YAML when asked', async () => {
    const res = await api('/api/state', { headers: { Accept: 'application/yaml' } });
    expect(res.headers.get('content-type')).toContain('yaml');
    expect(YAML.parse(await res.text())).toHaveProperty('unread', 0);
  });

  it('pushes an SSE event when an entity changes', async () => {
    const ac = new AbortController();
    const res = await fetch(`${ctx.apiUrl}/api/events?token=${ctx.apiToken}`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const seen = (async () => {
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return '';
        buf += new TextDecoder().decode(value);
        if (buf.includes('"entity":"projects"')) return buf;
      }
    })();
    await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'widget-pro', title: 'Widget Pro' }) });
    expect(await seen).toContain('widget-pro');
    ac.abort();
  });

  it('creates the spec example agent from YAML', async () => {
    const yaml = `name: adwords-optimizer
enabled: true
briefing: |
  Run and optimise Google Ads campaigns for the product in project "widget-pro".
harness: claude-code
models: [claude-sonnet, claude-haiku]
budget_usd: 30
max_parallel: 1
triggers:
  - cron: "0 7 * * *"
  - inbox: true
projects: [widget-pro]
resources: []
`;
    const res = await api('/api/agents', { method: 'POST', body: JSON.stringify({ yaml }) });
    expect(res.status).toBe(200);
    const a = await res.json();
    expect(a.triggers).toEqual([{ cron: '0 7 * * *' }, { inbox: true }]);
    expect(a.projects).toEqual(['widget-pro']);
    expect((await api('/api/agents', { method: 'POST', body: JSON.stringify({ yaml }) })).status).toBe(409);
  });

  it('renames an agent and keeps its history', async () => {
    const res = await api('/api/agents/adwords-optimizer', { method: 'PUT', body: JSON.stringify({ name: 'ads-optimiser' }) });
    expect(res.status).toBe(200);
    expect((await api('/api/agents/adwords-optimizer')).status).toBe(404);
    const hist = await (await api('/api/agents/ads-optimiser/briefings')).json();
    expect(hist.length).toBe(1);
  });

  it('lists and installs the example agents with what they need', async () => {
    const list = await (await api('/api/examples')).json();
    const names = list.map((x: { name: string }) => x.name);
    expect(names).toEqual(expect.arrayContaining(['ads-optimiser', 'day-trader', 'social-scout', 'hn-digest', 'banner-designer']));
    const trader = list.find((x: { name: string }) => x.name === 'day-trader');
    expect(trader).toMatchObject({ category: 'Finance', resources: [{ name: 'stock-account', exists: false }] });
    expect(trader.resources[0].keys.map((k: { name: string }) => k.name)).toContain('BROKER_SECRET');
    const res = await api('/api/examples/day-trader/install', { method: 'POST' });
    const out = await res.json();
    expect(out.created).toEqual(['project trading', 'resource stock-account']);
    expect(out.agent).toMatchObject({ name: 'day-trader', enabled: false, resources: ['stock-account'] });
    expect((await api('/api/examples/day-trader/install', { method: 'POST' })).status).toBe(409);
  });
});
