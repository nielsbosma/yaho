import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Ctx } from '../context.ts';
import { asAgent } from '../harness/asAgent.ts';
import { Dopbase } from '../secrets/dopbase.ts';
import * as s from '../store.ts';
import { HttpError } from '../store.ts';
import { referencedKeys, resolveConfig, toolEnabled, type McpConfig } from './config.ts';

/** Where Yaho keeps an MCP server's OAuth client and tokens: next to the resource's keys in Dopbase, never injected. */
export const OAUTH_KEY = 'MCP_OAUTH';
const IDLE_MS = 10 * 60_000;
const CONNECT_MS = 60_000;

interface OAuthState {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  redirect_url?: string;
}

interface Conn {
  client: Client;
  /** The config it was opened with; key values and sign-ins close it when they change. */
  sig: string;
  used: number;
  stderr: string[];
  tools?: Tool[];
}

/** Yaho's side of an MCP server's OAuth: dynamic client registration, PKCE, tokens saved to Dopbase. */
class Provider implements OAuthClientProvider {
  authUrl?: URL;
  private verifier?: string;
  private flow?: string;
  private save: (st: OAuthState) => Promise<void>;
  private st: OAuthState;
  private redirect?: string;
  constructor(save: (st: OAuthState) => Promise<void>, st: OAuthState, redirect?: string) {
    this.save = save;
    this.st = st;
    this.redirect = redirect;
  }
  get redirectUrl() {
    return this.redirect ?? this.st.redirect_url;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Yaho',
      client_uri: 'https://github.com/nielsbosma/yaho',
      redirect_uris: [String(this.redirectUrl ?? 'http://127.0.0.1/api/mcp/oauth/callback')],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    return (this.flow ??= randomBytes(16).toString('hex'));
  }
  clientInformation() {
    return this.st.client;
  }
  async saveClientInformation(c: OAuthClientInformationMixed) {
    this.st.client = c;
    await this.save(this.st);
  }
  tokens() {
    return this.st.tokens;
  }
  async saveTokens(t: OAuthTokens) {
    this.st.tokens = t;
    this.st.redirect_url = this.redirectUrl;
    await this.save(this.st);
  }
  redirectToAuthorization(u: URL) {
    this.authUrl = u;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    if (!this.verifier) throw new Error('no sign-in in progress');
    return this.verifier;
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') delete this.st.client;
    if (scope === 'all' || scope === 'tokens') delete this.st.tokens;
    if (scope === 'verifier') this.verifier = undefined;
    if (scope !== 'verifier' && scope !== 'discovery') await this.save(this.st);
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new HttpError(504, `${what} took longer than ${ms / 1000}s`)), ms).unref()),
  ]);

export const needsAuth = (e: unknown): boolean =>
  e instanceof UnauthorizedError || /\b401\b|unauthori[sz]ed|invalid_token/i.test(String((e as Error)?.message ?? e));

/**
 * The core's MCP client. One connection per MCP resource, shared by every agent that may use it, opened on first use
 * and closed after ten idle minutes or when the resource's config (or a key value) changes. stdio servers run as the
 * agents' user in the server version, like the harnesses.
 */
export class McpHub {
  private conns = new Map<string, Conn>();
  private connecting = new Map<string, Promise<Conn>>();
  private flows = new Map<string, { resource: string; url: string; provider: Provider; at: number }>();
  private sweep: NodeJS.Timeout;
  private ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
    this.sweep = setInterval(() => {
      for (const [name, c] of this.conns) if (Date.now() - c.used > IDLE_MS) void this.close(name);
      for (const [k, f] of this.flows) if (Date.now() - f.at > IDLE_MS) this.flows.delete(k);
    }, 60_000);
    this.sweep.unref();
  }

  private config(name: string): McpConfig {
    const res = s.getResource(this.ctx, name);
    if (res.kind !== 'mcp' || !res.config?.mcp) throw new HttpError(400, `${name} is not an MCP resource`);
    return res.config.mcp;
  }

  private async values(name: string, cfg: McpConfig): Promise<Record<string, string>> {
    if (!referencedKeys(cfg).length) return {};
    const dop = new Dopbase(this.ctx);
    if (!dop.configured) throw new HttpError(503, `${name} uses keys, but Dopbase is not configured`);
    return dop.runtimeValues(name);
  }

  private async oauthState(name: string): Promise<OAuthState> {
    const dop = new Dopbase(this.ctx);
    if (!dop.configured) return {};
    const raw = await dop.value(name, OAUTH_KEY).catch(() => null);
    try {
      return raw ? (JSON.parse(raw) as OAuthState) : {};
    } catch {
      return {};
    }
  }

  private saver(name: string) {
    return async (st: OAuthState) => {
      const dop = new Dopbase(this.ctx);
      if (!dop.configured) throw new HttpError(503, 'signing in to an MCP server needs Dopbase, where Yaho keeps the tokens');
      await dop.setValue(name, OAUTH_KEY, JSON.stringify(st));
    };
  }

  /** The open connection to a resource's server, opening (or reopening) it as needed. */
  async connection(name: string): Promise<Conn> {
    const have = this.conns.get(name);
    if (have && have.sig === signature(this.config(name))) {
      have.used = Date.now();
      return have;
    }
    const pending = this.connecting.get(name);
    if (pending) return pending;
    const p = this.open(name).finally(() => this.connecting.delete(name));
    this.connecting.set(name, p);
    return p;
  }

  private async open(name: string): Promise<Conn> {
    const cfg = this.config(name);
    const sig = signature(cfg);
    const resolved = resolveConfig(cfg, await this.values(name, cfg));
    const oauth = resolved.transport !== 'stdio' ? await this.oauthState(name) : {};
    if (this.conns.has(name)) await this.close(name);

    const stderr: string[] = [];
    let transport: Transport;
    if (resolved.transport === 'stdio') {
      const cwd = resolved.cwd ?? join(this.ctx.paths.root, 'mcp', name);
      mkdirSync(cwd, { recursive: true });
      const [command, args] = asAgent(resolved.command!, resolved.args ?? []);
      const env: Record<string, string> = { ...getDefaultEnvironment(), ...resolved.env };
      if (process.env.YAHO_AGENT_HOME) env.YAHO_AGENT_HOME = process.env.YAHO_AGENT_HOME;
      const t = new StdioClientTransport({ command, args, env, cwd, stderr: 'pipe' });
      t.stderr?.on('data', (d: Buffer) => {
        for (const line of d.toString('utf8').split(/\r?\n/)) if (line.trim()) stderr.push(line);
        if (stderr.length > 50) stderr.splice(0, stderr.length - 50);
      });
      transport = t;
    } else {
      const headers = resolved.headers ?? {};
      const authProvider = usesHeaderAuth(resolved) ? undefined : new Provider(this.saver(name), oauth);
      const url = new URL(resolved.url!);
      transport =
        resolved.transport === 'sse'
          ? new SSEClientTransport(url, { requestInit: { headers }, authProvider })
          : new StreamableHTTPClientTransport(url, { requestInit: { headers }, authProvider });
    }
    const client = new Client({ name: 'yaho', version: '1' }, { capabilities: {} });
    const conn: Conn = { client, sig, used: Date.now(), stderr };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      conn.tools = undefined;
    });
    client.onclose = () => {
      if (this.conns.get(name) === conn) this.conns.delete(name);
    };
    try {
      await withTimeout(client.connect(transport), CONNECT_MS, `connecting to ${name}`);
    } catch (e) {
      await client.close().catch(() => undefined);
      if (resolved.transport !== 'stdio' && needsAuth(e))
        throw usesHeaderAuth(resolved)
          ? new HttpError(502, `${name} refused its credentials (401): check the key in its Authorization header`)
          : new HttpError(409, `${name} needs you to sign in: open the resource in Yaho and press Sign In`);
      const tail = stderr.slice(-5).join('\n');
      throw new HttpError(502, `could not connect to ${name}: ${(e as Error).message}${tail ? `\n${tail}` : ''}`);
    }
    this.conns.set(name, conn);
    return conn;
  }

  async close(name: string): Promise<void> {
    const c = this.conns.get(name);
    this.conns.delete(name);
    await c?.client.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweep);
    await Promise.all([...this.conns.keys()].map((n) => this.close(n)));
  }

  /** Every tool the server offers, remembering their names on the resource for job prompts. */
  async allTools(name: string): Promise<Tool[]> {
    const conn = await this.connection(name);
    if (!conn.tools) {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = await conn.client.listTools(cursor ? { cursor } : undefined);
        tools.push(...r.tools);
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      conn.tools = tools;
      this.remember(name, conn, tools);
    }
    return conn.tools;
  }

  /** The tools agents may use. */
  async tools(name: string): Promise<Tool[]> {
    const cfg = this.config(name);
    return (await this.allTools(name)).filter((t) => toolEnabled(cfg, t.name));
  }

  private remember(name: string, conn: Conn, tools: Tool[]): void {
    const res = s.getResource(this.ctx, name);
    const cfg = res.config?.mcp;
    if (!cfg) return;
    const v = conn.client.getServerVersion();
    const discovered = {
      server: v?.title ?? v?.name,
      version: v?.version,
      tools: tools.map((t) => ({ name: t.name, description: t.description?.slice(0, 300) })),
    };
    const same = JSON.stringify({ ...cfg.discovered, at: undefined }) === JSON.stringify({ ...discovered, at: undefined });
    if (!same)
      s.saveResource(this.ctx, {
        name,
        config: { ...res.config, mcp: { ...cfg, discovered: { ...discovered, at: new Date().toISOString() } } },
      });
  }

  async call(name: string, tool: string, args: unknown): Promise<unknown> {
    const cfg = this.config(name);
    if (!toolEnabled(cfg, tool)) throw new HttpError(403, `the tool ${tool} of ${name} is turned off`);
    const run = async () => {
      const conn = await this.connection(name);
      conn.used = Date.now();
      return conn.client.callTool({ name: tool, arguments: (args ?? {}) as Record<string, unknown> }, undefined, {
        timeout: (cfg.timeout_s ?? 120) * 1000,
        resetTimeoutOnProgress: true,
      });
    };
    try {
      return await run();
    } catch (e) {
      // The server went away (it crashed, or closed an idle session): reconnect once.
      if (!/not connected|closed|ECONNRESET|session/i.test(String((e as Error).message))) throw mcpError(name, e);
      await this.close(name);
      return run().catch((e2) => {
        throw mcpError(name, e2);
      });
    }
  }

  async resources(name: string): Promise<unknown[]> {
    const conn = await this.connection(name);
    if (!conn.client.getServerCapabilities()?.resources) return [];
    return (await conn.client.listResources()).resources;
  }

  async read(name: string, uri: string): Promise<unknown> {
    const conn = await this.connection(name);
    return conn.client.readResource({ uri }).catch((e) => {
      throw mcpError(name, e);
    });
  }

  async prompts(name: string): Promise<unknown[]> {
    const conn = await this.connection(name);
    if (!conn.client.getServerCapabilities()?.prompts) return [];
    return (await conn.client.listPrompts()).prompts;
  }

  async prompt(name: string, prompt: string, args: Record<string, string>): Promise<unknown> {
    const conn = await this.connection(name);
    return conn.client.getPrompt({ name: prompt, arguments: args }).catch((e) => {
      throw mcpError(name, e);
    });
  }

  /** Everything the resource page shows; a failure is part of the answer, not an error. */
  async status(name: string): Promise<Record<string, unknown>> {
    const cfg = this.config(name);
    const signedIn = cfg.transport !== 'stdio' && !!(await this.oauthState(name)).tokens;
    try {
      const tools = await this.allTools(name);
      const conn = await this.connection(name);
      return {
        ok: true,
        signed_in: signedIn,
        server: conn.client.getServerVersion() ?? null,
        instructions: conn.client.getInstructions() ?? null,
        capabilities: conn.client.getServerCapabilities() ?? {},
        tools: tools.map((t) => ({ ...t, enabled: toolEnabled(cfg, t.name) })),
        resources: await this.resources(name).catch(() => []),
        prompts: await this.prompts(name).catch(() => []),
        stderr: conn.stderr.slice(-20),
      };
    } catch (e) {
      return {
        ok: false,
        signed_in: signedIn,
        needs_auth: (e as HttpError).status === 409 && /sign in/.test((e as Error).message),
        error: (e as Error).message,
      };
    }
  }

  /** Start signing in to a server that uses OAuth; the browser comes back to /api/mcp/oauth/callback. */
  async signIn(name: string, origin: string): Promise<{ redirect_url?: string; connected?: boolean }> {
    const cfg = this.config(name);
    if (cfg.transport === 'stdio') throw new HttpError(400, 'stdio servers have no sign-in');
    const url = resolveConfig(cfg, await this.values(name, cfg)).url!;
    const redirect = `${(process.env.YAHO_PUBLIC_URL || origin).replace(/\/$/, '')}/api/mcp/oauth/callback`;
    const st = await this.oauthState(name);
    // A client registered for another address cannot come back to this one.
    if (st.redirect_url && st.redirect_url !== redirect) delete st.client;
    const provider = new Provider(this.saver(name), st, redirect);
    const r = await auth(provider, { serverUrl: url }).catch((e) => {
      throw new HttpError(502, `${name}: could not start signing in: ${(e as Error).message}`);
    });
    if (r === 'AUTHORIZED') {
      await this.close(name);
      return { connected: true };
    }
    if (!provider.authUrl) throw new HttpError(502, `${name} gave no sign-in page`);
    this.flows.set(provider.state(), { resource: name, url, provider, at: Date.now() });
    return { redirect_url: provider.authUrl.toString() };
  }

  async finishSignIn(state: string, code: string): Promise<string> {
    const flow = this.flows.get(state);
    if (!flow) throw new HttpError(400, 'this sign-in expired or was already used: start again from Yaho');
    this.flows.delete(state);
    await auth(flow.provider, { serverUrl: flow.url, authorizationCode: code });
    await this.close(flow.resource);
    this.ctx.bus.emitEvent({ type: 'changed', entity: 'resources', name: flow.resource });
    return flow.resource;
  }

  async signOut(name: string): Promise<void> {
    this.config(name);
    const dop = new Dopbase(this.ctx);
    if (dop.configured) await dop.deleteValue(name, OAUTH_KEY);
    await this.close(name);
    this.ctx.bus.emitEvent({ type: 'changed', entity: 'resources', name });
  }
}

const usesHeaderAuth = (c: McpConfig) => Object.keys(c.headers ?? {}).some((h) => h.toLowerCase() === 'authorization');

/** What a connection depends on: the config without what Yaho records on it. */
const signature = (c: McpConfig) =>
  createHash('sha256')
    .update(JSON.stringify({ ...c, discovered: undefined, tools: undefined }))
    .digest('hex');

function mcpError(name: string, e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (needsAuth(e)) return new HttpError(409, `${name} needs you to sign in: open the resource in Yaho and press Sign In`);
  return new HttpError(502, `${name}: ${(e as Error).message}`);
}
