import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { defaultSettings } from '../config.ts';
import type { Ctx } from '../context.ts';
import { normalizeMcp, parseImport, referencedKeys, resolveConfig } from '../mcp/config.ts';
import { serve } from '../serve.ts';
import type { Job } from '../store.ts';

const fake = fileURLToPath(new URL('../../test/fake-claude.mjs', import.meta.url));
const fakeMcp = fileURLToPath(new URL('../../test/fake-mcp.mjs', import.meta.url));
const probe = fileURLToPath(new URL('../../test/mcp-probe.mjs', import.meta.url));

let dir: string;
let ctx: Ctx;
let close: () => Promise<void>;
let http: ChildProcess;
let httpPort: number;

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

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

async function runJob(agent: string, steps: unknown[]) {
  mkdirSync(join(dir, 'agents', agent), { recursive: true });
  writeFileSync(join(dir, 'agents', agent, 'steps.json'), JSON.stringify(steps));
  const job = await api<Job>(`/api/agents/${agent}/run`, { method: 'POST' });
  const end = Date.now() + 30_000;
  while (['queued', 'running'].includes((await api<Job>(`/api/jobs/${job.id}`)).status) && Date.now() < end)
    await new Promise((r) => setTimeout(r, 150));
  return api<Array<{ kind: string; data: Record<string, unknown> }>>(`/api/jobs/${job.id}/events`);
}

beforeAll(async () => {
  httpPort = await freePort();
  http = spawn(process.execPath, [fakeMcp, '--http', String(httpPort)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((r) => http.stdout!.once('data', () => r()));
  dir = mkdtempSync(join(tmpdir(), 'yaho-mcp-'));
  const s = defaultSettings();
  s.harnesses['claude-code'] = { command: process.execPath, args: [fake] };
  s.defaults.models = ['test-model'];
  writeFileSync(join(dir, 'settings.yaml'), YAML.stringify(s));
  ({ ctx, close } = await serve({ dataDir: dir, port: 0, embedded: true }));
});
afterAll(async () => {
  await close();
  http.kill();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP config', () => {
  it('checks configs and fills in keys', () => {
    expect(() => normalizeMcp({ transport: 'stdio' })).toThrow(/needs a command/);
    expect(() => normalizeMcp({ url: 'ftp://x' })).toThrow(/http/);
    const c = normalizeMcp({
      type: 'streamable-http',
      url: 'https://x.dev/mcp?k=${API_KEY}',
      headers: { Authorization: 'Bearer ${TOKEN}' },
    });
    expect(c.transport).toBe('http');
    expect(referencedKeys(c).sort()).toEqual(['API_KEY', 'TOKEN']);
    expect(resolveConfig(c, { API_KEY: 'a', TOKEN: 't' })).toMatchObject({
      url: 'https://x.dev/mcp?k=a',
      headers: { Authorization: 'Bearer t' },
    });
    expect(() => resolveConfig(c, { API_KEY: 'a' })).toThrow(/TOKEN has no value/);
  });

  it('imports mcpServers JSON, turning literal secrets into keys', () => {
    const drafts = parseImport(
      JSON.stringify({
        mcpServers: {
          'Brave Search': { command: 'npx', args: ['-y', 'brave'], env: { BRAVE_API_KEY: 'abc123' } },
          linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer lin_456' } },
        },
      }),
    );
    expect(drafts).toEqual([
      {
        name: 'brave-search',
        config: { transport: 'stdio', command: 'npx', args: ['-y', 'brave'], env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' } },
        keys: [{ name: 'BRAVE_API_KEY', value: 'abc123' }],
      },
      {
        name: 'linear',
        config: { transport: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${AUTHORIZATION}' } },
        keys: [{ name: 'AUTHORIZATION', value: 'lin_456' }],
      },
    ]);
    expect(() => parseImport('{"nothing": 1}')).toThrow(/no servers/);
  });
});

describe('MCP resources', () => {
  it('connects to a stdio server and shows its tools, documents and prompts', async () => {
    await api('/api/resources/mcp', {
      body: { name: 'demo', config: { transport: 'stdio', command: process.execPath, args: [fakeMcp], env: { FAKE_SECRET: 'plain' } } },
    });
    const st = await api<Record<string, unknown> & { tools: Array<{ name: string; enabled: boolean }> }>('/api/resources/demo/mcp');
    expect(st.ok).toBe(true);
    expect(st.server).toMatchObject({ name: 'fake-mcp', version: '1.2.3' });
    expect(st.instructions).toBe('A test server.');
    expect(st.tools.map((t) => [t.name, t.enabled])).toEqual([
      ['echo', true],
      ['add', true],
      ['whoami', true],
    ]);
    expect(st.resources).toEqual([expect.objectContaining({ uri: 'demo://note' })]);
    expect(st.prompts).toEqual([expect.objectContaining({ name: 'greet' })]);
    expect(st.stderr).toContain('fake-mcp ready');

    const r = await api<{ content: Array<{ text: string }> }>('/api/resources/demo/mcp/tools/whoami', { body: {} });
    // Its own folder under <data>/mcp, and the env it was configured with.
    expect(r.content[0]!.text).toBe(`secret=plain cwd=${join(dir, 'mcp', 'demo')}`);
    // What it found is kept on the resource, for job prompts.
    const res = await api<{ config: { mcp: { discovered: { server: string; tools: Array<{ name: string }> } } } }>('/api/resources/demo');
    expect(res.config.mcp.discovered).toMatchObject({ server: 'fake-mcp', tools: [{ name: 'echo' }, { name: 'add' }, { name: 'whoami' }] });
  });

  it('lets agents use the enabled tools, natively and with yaho tool', async () => {
    await api('/api/resources/demo/mcp/tools', { method: 'PUT', body: { tools: ['echo', 'whoami'] } });
    await api('/api/agents', { body: { name: 'mcpuser', briefing: 'x', resources: ['demo'] } });
    const events = await runJob('mcpuser', [
      { cmd: 'yaho tools demo' },
      { cmd: 'yaho tool demo echo', stdin: 'text: from the cli\n' },
      { cmd: 'yaho tool demo add', stdin: 'a: 1\nb: 2\n' },
      { cmd: 'yaho mcp read demo demo://note' },
      { cmd: 'yaho mcp prompt demo greet', stdin: 'who: Niels\n' },
      { cmd: `"${process.execPath}" "${probe}" demo__echo '{"text":"native"}'` },
      { cmd: 'yaho finish' },
    ]);
    const outs = events.filter((e) => e.kind === 'tool_result').map((e) => String(e.data.output));
    expect(outs[0]).toContain('slug: echo');
    expect(outs[0]).not.toContain('slug: add');
    expect(outs[1]).toContain('echo: from the cli');
    expect(outs[2]).toContain('turned off');
    expect(outs[3]).toContain('a note from the server');
    expect(outs[4]).toContain('Say hello to Niels');
    const native = JSON.parse(outs[5]!.trim().split('\n').pop()!);
    expect(native.tools).toEqual(['demo__echo', 'demo__whoami']);
    expect(native.result.content[0].text).toBe('echo: native');

    const prompt = events.find((e) => e.kind === 'prompt')!.data.user as string;
    expect(prompt).toContain('### demo (MCP server: fake-mcp)');
    expect(prompt).toContain('`mcp__yaho__demo__echo`, `mcp__yaho__demo__whoami`');
    expect(prompt).not.toContain('demo__add');
  });

  it('keeps MCP resources from agents that were not granted them', async () => {
    await api('/api/agents', { body: { name: 'stranger', briefing: 'x' } });
    const events = await runJob('stranger', [{ cmd: 'yaho tool demo echo', stdin: 'text: hi\n' }, { cmd: 'yaho finish' }]);
    expect(String(events.find((e) => e.kind === 'tool_result')?.data.output)).toContain('not granted');
    // No MCP resources, so no yaho MCP server for the harness.
    expect(JSON.stringify(events)).not.toContain('mcp-config');
  });

  it('connects over Streamable HTTP with a header, and says when the credentials are wrong', async () => {
    await api('/api/resources/mcp', {
      body: { name: 'remote', config: { url: `http://127.0.0.1:${httpPort}/mcp`, headers: { Authorization: 'Bearer let-me-in' } } },
    });
    const ok = await api<{ ok: boolean; tools: unknown[] }>('/api/resources/remote/mcp');
    expect(ok.ok).toBe(true);
    expect(ok.tools).toHaveLength(3);
    const r = await api<{ content: Array<{ text: string }> }>('/api/resources/remote/mcp/tools/add', { body: { a: 2, b: 40 } });
    expect(r.content[0]!.text).toBe('42');

    await api('/api/resources/remote', {
      method: 'PUT',
      body: {
        name: 'remote',
        kind: 'mcp',
        config: { mcp: { url: `http://127.0.0.1:${httpPort}/mcp`, headers: { Authorization: 'Bearer wrong' } } },
      },
    });
    const bad = await api<{ ok: boolean; error: string }>('/api/resources/remote/mcp');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('refused its credentials');
  });

  it('imports servers from JSON and lists presets', async () => {
    const created = await api<Array<{ name: string; kind: string }>>('/api/resources/mcp/import', {
      body: { json: JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: [fakeMcp] } } }) },
    });
    expect(created).toEqual([expect.objectContaining({ name: 'demo-2', kind: 'mcp' })]);
    // Literal secrets need Dopbase, which these tests run without.
    await expect(
      api('/api/resources/mcp/import', { body: { json: JSON.stringify({ mcpServers: { x: { command: 'x', env: { K: 'v' } } } }) } }),
    ).rejects.toThrow(/Dopbase/);
    const presets = await api<Array<{ id: string }>>('/api/mcp/presets');
    expect(presets.map((p) => p.id)).toContain('github');
  });

  it('rejects a bad MCP config', async () => {
    await expect(api('/api/resources/mcp', { body: { name: 'broken', config: { transport: 'carrier-pigeon' } } })).rejects.toThrow(
      /transport/,
    );
  });
});
