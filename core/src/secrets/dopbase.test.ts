import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { defaultSettings, paths } from '../config.ts';
import { Bus, type Ctx } from '../context.ts';
import { openDb } from '../db/index.ts';
import { saveResource } from '../store.ts';
import { Dopbase, envForAgent } from './dopbase.ts';

/** A minimal Dopbase speaking the v1 envelope for the endpoints Yaho uses. */
function mockDopbase(): { server: Server; url: () => string; envs: Map<string, Map<string, string>> } {
  const projects = new Set<string>();
  const envs = new Map<string, Map<string, string>>(); // env id -> key -> value
  const ids = new Map<string, string>(); // "project/env" -> id
  const ok = (res: import('node:http').ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status < 300 ? { success: true, data } : { success: false, error: { [String(data)]: 'x' } }));
  };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer t0k') return ok(res, 'UNAUTHORIZED', 401);
    let body = '';
    for await (const c of req) body += c;
    const u = new URL(req.url!, 'http://x');
    const p = u.pathname.replace('/api/v1', '');
    let m: RegExpMatchArray | null;
    if (req.method === 'GET' && p === '/environments/resolve') {
      const id = ids.get(u.searchParams.get('reference')!);
      return id ? ok(res, { id }) : ok(res, 'ENVIRONMENT_NOT_FOUND', 404);
    }
    if (req.method === 'POST' && p === '/projects') {
      projects.add(JSON.parse(body).name);
      return ok(res, { id: 'prj' });
    }
    if (req.method === 'POST' && (m = p.match(/^\/projects\/([^/]+)\/environments$/))) {
      const id = `env_${ids.size + 1}`;
      ids.set(`${decodeURIComponent(m[1]!)}/${JSON.parse(body).name}`, id);
      envs.set(id, new Map());
      return ok(res, { id });
    }
    if (req.method === 'PUT' && (m = p.match(/^\/environments\/([^/]+)\/secrets\/([^/]+)$/))) {
      envs.get(m[1]!)!.set(decodeURIComponent(m[2]!), JSON.parse(body).value);
      return ok(res, {});
    }
    if (req.method === 'DELETE' && (m = p.match(/^\/environments\/([^/]+)\/secrets\/([^/]+)$/))) {
      envs.get(m[1]!)!.delete(decodeURIComponent(m[2]!));
      return ok(res, {});
    }
    if (req.method === 'GET' && (m = p.match(/^\/environments\/([^/]+)\/secrets\/runtime$/))) {
      return ok(res, { entries: [...envs.get(m[1]!)!].map(([key, value]) => ({ key, value })) });
    }
    ok(res, 'NOT_FOUND', 404);
  });
  return { server, url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`, envs };
}

let dir: string;
let ctx: Ctx;
const mock = mockDopbase();

beforeAll(async () => {
  await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', r));
  dir = mkdtempSync(join(tmpdir(), 'yaho-dop-'));
  process.env.YAHO_DATA_DIR = dir;
  const settings = defaultSettings();
  settings.dopbase = { mode: 'external', url: mock.url(), token: 't0k', environment: 'production', project_prefix: 'yaho-' };
  ctx = { db: openDb(join(dir, 'yaho.db')), settings, paths: paths(dir), apiToken: 'x', bus: new Bus(), apiUrl: '' };
  saveResource(ctx, {
    name: 'ads',
    keys: [
      { name: 'ACCOUNT', secret: false },
      { name: 'TOKEN', secret: true },
    ],
  });
});
afterAll(() => {
  ctx.db.close();
  mock.server.close();
  delete process.env.YAHO_DATA_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('Dopbase secrets', () => {
  it('creates the project on first write and stores values only in Dopbase', async () => {
    const d = new Dopbase(ctx);
    await d.setValue('ads', 'ACCOUNT', 'acc-1');
    await d.setValue('ads', 'TOKEN', 'very-secret-value');
    expect([...mock.envs.values()][0]!.get('TOKEN')).toBe('very-secret-value');
    ctx.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    expect(readFileSync(join(dir, 'yaho.db')).includes('very-secret-value')).toBe(false);
    const flags = ctx.db.prepare("SELECT name, has_value FROM resource_keys WHERE resource = 'ads' ORDER BY name").all();
    expect(flags).toEqual([
      { name: 'ACCOUNT', has_value: 1 },
      { name: 'TOKEN', has_value: 1 },
    ]);
  });

  it('injects only declared keys of granted resources', async () => {
    [...mock.envs.values()][0]!.set('UNDECLARED', 'nope');
    const { env, warnings } = await envForAgent(ctx, ['ads']);
    expect(env).toEqual({ ACCOUNT: 'acc-1', TOKEN: 'very-secret-value' });
    expect(warnings).toEqual([]);
  });

  it('reports, rather than fails, when Dopbase is not configured', async () => {
    const token = ctx.settings.dopbase.token;
    ctx.settings.dopbase.token = undefined;
    const { env, warnings } = await envForAgent(ctx, ['ads']);
    expect(env).toEqual({});
    expect(warnings[0]).toContain('not configured');
    ctx.settings.dopbase.token = token;
  });
});

describe("Yaho's own keys", () => {
  it('turns a settings file from before providers into providers, moves its keys into Dopbase, and hides them', async () => {
    const { writeFileSync } = await import('node:fs');
    const YAML = (await import('yaml')).default;
    const { loadSettings } = await import('../config.ts');
    const { loadSecrets, storeSecrets, publicSettings, applySettingsUpdate, SETTINGS_PROJECT } = await import('./settingsSecrets.ts');
    // An old file: a litellm block with its key, and Slack tokens. Dopbase already holds LITELLM_MASTER_KEY, the name
    // the first secrets release used.
    const old = { ...ctx.settings, litellm: { url: 'http://llm', api_key: 'sk-file' }, slack: { bot_token: 'xoxb-1', app_token: 'xapp-1', owner: 'U1' } } as Record<string, unknown>;
    delete old.providers;
    writeFileSync(ctx.paths.settings, YAML.stringify(old));
    await new Dopbase(ctx).setProjectValue(SETTINGS_PROJECT, 'LITELLM_MASTER_KEY', 'mk-old');
    const loaded = loadSettings();
    loaded.dopbase = ctx.settings.dopbase;
    ctx.settings = loaded;
    expect(ctx.settings.providers).toEqual([{ id: 'litellm', kind: 'litellm', url: 'http://llm', api_key: 'sk-file' }]);

    const r = await loadSecrets(ctx);
    expect(r.moved).toEqual(['providers.litellm.api_key', 'slack.bot_token', 'slack.app_token']);
    const file = readFileSync(ctx.paths.settings, 'utf8');
    expect(file).not.toContain('sk-file');
    expect(file).not.toContain('xoxb-1');
    expect(file).not.toMatch(/^litellm:/m);
    expect(file).toContain('kind: litellm');
    expect(file).toContain('owner: U1');
    expect(ctx.settings.providers[0]!.api_key).toBe('sk-file');
    // The old Dopbase name was carried over to the provider's.
    expect(ctx.settings.providers[0]!.master_key).toBe('mk-old');
    const env = [...mock.envs.values()].find((e) => e.has('PROVIDER_LITELLM_API_KEY'))!;
    expect(env.has('LITELLM_MASTER_KEY')).toBe(false);
    expect(env.get('PROVIDER_LITELLM_MASTER_KEY')).toBe('mk-old');

    const pub = publicSettings(ctx.settings);
    expect(JSON.stringify(pub)).not.toContain('sk-file');
    expect(pub.secrets_set['providers.litellm.api_key']).toBe(true);

    // The UI sends settings back without secret values: they stay. A new value replaces, null clears.
    applySettingsUpdate(ctx.settings, { ...pub, slack: { ...pub.slack, bot_token: 'xoxb-2', app_token: null as unknown as string } });
    await storeSecrets(ctx);
    expect(ctx.settings.providers[0]!.api_key).toBe('sk-file');
    expect(env.get('SLACK_BOT_TOKEN')).toBe('xoxb-2');
    expect(env.has('SLACK_APP_TOKEN')).toBe(false);
    expect(readFileSync(ctx.paths.settings, 'utf8')).not.toContain('xoxb-2');
  });

  it('finds the provider in a model name only when it is a configured provider', async () => {
    const { resolveModel } = await import('../providers.ts');
    const s = { ...ctx.settings, providers: [{ id: 'litellm', kind: 'litellm', url: 'u' }, { id: 'berget', kind: 'berget' }] };
    expect(resolveModel(s, 'claude-sonnet').provider.id).toBe('litellm');
    expect(resolveModel(s, 'berget/llama-4')).toMatchObject({ provider: { id: 'berget' }, model: 'llama-4' });
    // A LiteLLM name with a slash stays whole.
    expect(resolveModel(s, 'openai/gpt-4o')).toMatchObject({ provider: { id: 'litellm' }, model: 'openai/gpt-4o' });
  });
});
