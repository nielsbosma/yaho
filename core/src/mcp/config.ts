import { HttpError } from '../store.ts';

/**
 * An MCP server as a resource (config.mcp). stdio servers are started by the core; http (Streamable HTTP) and sse
 * servers are reached over the network. Values in env, headers, args and the url may name the resource's keys as
 * ${KEY}: the core fills them in from Dopbase when it connects, so key values never reach an agent.
 */
export interface McpConfig {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** stdio: where the server runs; default a folder of its own under <data>/mcp. */
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** The tools agents may use; unset means all of them. */
  tools?: string[] | null;
  /** Seconds a tool call may take (default 120). */
  timeout_s?: number;
  /** What the last successful connection found, for the job prompt and the resource list. */
  discovered?: McpDiscovery;
}

export interface McpDiscovery {
  server?: string;
  version?: string;
  tools: Array<{ name: string; description?: string }>;
  at: string;
}

const KEY_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const strings = (v: unknown, what: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' && typeof x !== 'number'))
    throw new HttpError(400, `${what} must be a list of strings`);
  return v.map(String);
};

const record = (v: unknown, what: string): Record<string, string> => {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `${what} must be a mapping of names to values`);
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x ?? '')]));
};

/** Check and tidy a config from the UI, a YAML definition or an import. */
export function normalizeMcp(input: unknown, prev?: McpConfig): McpConfig {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'an MCP resource needs config.mcp');
  const i = input as Record<string, unknown>;
  const url = typeof i.url === 'string' ? i.url.trim() : '';
  const transport = (i.transport ?? i.type ?? (url ? 'http' : 'stdio')) as string;
  const t = transport === 'streamable-http' || transport === 'streamableHttp' ? 'http' : transport;
  if (t !== 'stdio' && t !== 'http' && t !== 'sse') throw new HttpError(400, `transport must be stdio, http or sse (not ${transport})`);
  const out: McpConfig = { transport: t };
  if (t === 'stdio') {
    const command = typeof i.command === 'string' ? i.command.trim() : '';
    if (!command) throw new HttpError(400, 'a stdio MCP server needs a command');
    out.command = command;
    out.args = strings(i.args, 'args');
    out.env = record(i.env, 'env');
    if (typeof i.cwd === 'string' && i.cwd.trim()) out.cwd = i.cwd.trim();
  } else {
    if (!url) throw new HttpError(400, `an ${t} MCP server needs a url`);
    if (!/^https?:\/\//i.test(url.replace(KEY_REF, 'x'))) throw new HttpError(400, 'the url must start with http:// or https://');
    out.url = url;
    out.headers = record(i.headers, 'headers');
  }
  if (i.tools !== undefined && i.tools !== null) out.tools = strings(i.tools, 'tools');
  if (i.timeout_s !== undefined) {
    const n = Number(i.timeout_s);
    if (!Number.isFinite(n) || n <= 0 || n > 3600) throw new HttpError(400, 'timeout_s must be between 1 and 3600');
    out.timeout_s = n;
  }
  const discovered = (i.discovered as McpDiscovery | undefined) ?? prev?.discovered;
  if (discovered) out.discovered = discovered;
  return out;
}

/** The keys a config names with ${KEY}. */
export function referencedKeys(c: McpConfig): string[] {
  const all = [c.command, ...(c.args ?? []), ...Object.values(c.env ?? {}), c.url, ...Object.values(c.headers ?? {}), c.cwd];
  const out = new Set<string>();
  for (const s of all) for (const m of String(s ?? '').matchAll(KEY_REF)) out.add(m[1]!);
  return [...out];
}

/** Fill in ${KEY} from values; a key without a value is an error that names it. */
export function substitute(s: string, values: Record<string, string>): string {
  return s.replace(KEY_REF, (_, k: string) => {
    if (!(k in values)) throw new HttpError(409, `the key ${k} has no value yet: set it on the resource`);
    return values[k]!;
  });
}

export function resolveConfig(c: McpConfig, values: Record<string, string>): McpConfig {
  const sub = (s: string) => substitute(s, values);
  const map = (r?: Record<string, string>) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, sub(v)])) : r);
  return {
    ...c,
    command: c.command && sub(c.command),
    args: c.args?.map(sub),
    env: map(c.env),
    cwd: c.cwd && sub(c.cwd),
    url: c.url && sub(c.url),
    headers: map(c.headers),
  };
}

/** Whether agents may use a tool of this server. */
export const toolEnabled = (c: McpConfig, tool: string): boolean => !c.tools || c.tools.includes(tool);

/** A tool's name as agents see it natively: <resource>__<tool>, within the 64 characters harnesses accept. */
export function nativeToolName(resource: string, tool: string): string {
  return `${resource}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

export interface McpDraft {
  name: string;
  config: McpConfig;
  keys: Array<{ name: string; value: string }>;
}

const resourceName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'mcp';

const keyName = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^([0-9])/, '_$1');

/**
 * Servers from the `mcpServers` JSON that Claude Desktop, Claude Code, Cursor and VS Code use (or a single server's
 * entry). Literal env values and header values become secret keys, referenced as ${KEY}, so they go to Dopbase and
 * not into the resource's config.
 */
export function parseImport(text: string): McpDraft[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'paste the JSON with "mcpServers" (as in claude_desktop_config.json or .mcp.json)');
  }
  const d = data as Record<string, unknown>;
  const servers = (d.mcpServers ?? d.servers ?? (d.mcp as Record<string, unknown> | undefined)?.servers ?? null) as Record<
    string,
    unknown
  > | null;
  const entries: Array<[string, unknown]> = servers ? Object.entries(servers) : d.command || d.url ? [[String(d.name ?? 'mcp'), d]] : [];
  if (!entries.length) throw new HttpError(400, 'no servers found: expected { "mcpServers": { "<name>": { ... } } }');
  return entries.map(([name, raw]) => {
    const cfg = normalizeMcp(raw);
    const keys: McpDraft['keys'] = [];
    const lift = (r: Record<string, string> | undefined) => {
      for (const [k, v] of Object.entries(r ?? {})) {
        if (!v || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v)) continue;
        // ${VAR} as Claude Code writes it, or a literal value: either way the value becomes a key.
        const bearer = /^(Bearer|Basic|Token)\s+(.+)$/i.exec(v);
        const kn = keyName(k);
        keys.push({ name: kn, value: bearer ? bearer[2]! : v });
        r![k] = bearer ? `${bearer[1]} \${${kn}}` : `\${${kn}}`;
      }
    };
    lift(cfg.env);
    lift(cfg.headers);
    return { name: resourceName(name), config: cfg, keys };
  });
}
