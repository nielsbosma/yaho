import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

/** Global settings, stored as settings.yaml in the data directory. */
export interface Settings {
  server: { host: string; port: number };
  harnesses: Record<string, { command: string; args?: string[] }>;
  litellm: {
    url: string;
    /** Key the harness uses for model calls when no master key is set. */
    api_key?: string;
    /** With a master key Yaho mints one virtual key per job, capped at the agent's remaining budget. */
    master_key?: string;
  };
  /** bundled: Yaho runs its own Dopbase on local_port. external: an existing server at url, with token. */
  dopbase: { mode: 'bundled' | 'external'; url: string; token?: string; local_port?: number; environment: string; project_prefix: string };
  global_spend_cap_usd: number;
  /** Composio: one API key for the whole app; resources point at its connected accounts. */
  composio?: { api_key?: string; user_id?: string; url?: string };
  /** Agents' ideas for Yaho itself, filed as GitHub issues with the gh CLI (yaho idea). */
  ideas?: { enabled?: boolean; repo?: string };
  /** The in-app chat. Model defaults to the first default model. */
  assistant?: { model?: string };
  defaults: {
    harness: string;
    models: string[];
    budget_usd: number;
    max_parallel: number;
    guardrails: Guardrails;
  };
}

export interface Guardrails {
  rate_per_hour?: number;
  cooldown_seconds?: number;
  hop_limit?: number;
  /** Skip scheduled runs while the human has unread messages from this agent. */
  wait_for_inbox?: boolean;
}

export const defaultSettings = (): Settings => ({
  server: { host: '127.0.0.1', port: 4700 },
  harnesses: { 'claude-code': { command: 'claude' } },
  litellm: { url: 'http://localhost:4000' },
  dopbase: { mode: 'bundled', url: 'http://localhost:8840', local_port: 4702, environment: 'production', project_prefix: 'yaho-' },
  global_spend_cap_usd: 100,
  defaults: {
    harness: 'claude-code',
    models: ['claude-sonnet'],
    budget_usd: 10,
    max_parallel: 1,
    guardrails: { rate_per_hour: 10, cooldown_seconds: 60, hop_limit: 5 },
  },
});

export function dataDir(): string {
  if (process.env.YAHO_DATA_DIR) return process.env.YAHO_DATA_DIR;
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return join(base, 'yaho');
}

export const paths = (root = dataDir()) => ({
  root,
  db: join(root, 'yaho.db'),
  settings: join(root, 'settings.yaml'),
  token: join(root, 'api-token'),
  server: join(root, 'server.yaml'),
  bin: join(root, 'bin'),
  agents: join(root, 'agents'),
  projects: join(root, 'projects'),
  agent: (name: string) => join(root, 'agents', name),
  project: (name: string) => join(root, 'projects', name),
});

function merge<T>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return (over ?? base) as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
  return out as T;
}

export function loadSettings(): Settings {
  const p = paths();
  mkdirSync(p.root, { recursive: true });
  if (!existsSync(p.settings)) {
    writeFileSync(p.settings, YAML.stringify(defaultSettings()));
  }
  return merge(defaultSettings(), YAML.parse(readFileSync(p.settings, 'utf8')) ?? {});
}

export function saveSettings(s: Settings): void {
  writeFileSync(paths().settings, YAML.stringify(s));
}

/** The API token every caller (UI, CLI admin use) presents. Created once per data directory. */
export function apiToken(): string {
  const p = paths();
  mkdirSync(p.root, { recursive: true });
  if (!existsSync(p.token)) writeFileSync(p.token, randomBytes(24).toString('hex'));
  return readFileSync(p.token, 'utf8').trim();
}
