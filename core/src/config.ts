import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';

/** Global settings, stored as settings.yaml in the data directory. */
export interface Settings {
  /** session_epoch: raised by Sign Out Everywhere (server version), which ends every session. */
  server: { host: string; port: number; session_epoch?: number };
  harnesses: Record<string, { command: string; args?: string[] }>;
  /**
   * Where models come from. Only kind litellm works today (see providers.ts for the ones coming). A model name may name
   * its provider, "<id>/<model>"; a bare name uses default_provider.
   */
  providers: ProviderConfig[];
  /** The provider for model names without one; the first provider when unset. */
  default_provider?: string;
  /** bundled: Yaho runs its own Dopbase on local_port. external: an existing server at url, with token. */
  dopbase: { mode: 'bundled' | 'external'; url: string; token?: string; local_port?: number; environment: string; project_prefix: string };
  global_spend_cap_usd: number;
  /** Composio: one API key for the whole app; resources point at its connected accounts. */
  composio?: { api_key?: string; user_id?: string; url?: string };
  /** Agents' ideas for Yaho itself, filed as GitHub issues with the gh CLI (yaho idea). */
  ideas?: { enabled?: boolean; repo?: string };
  /**
   * Slack: the inbox as DMs from the person's own Slack app, over Socket Mode. owner is the Slack user who first opened
   * the app; since is when that happened (messages from then on are posted). post: every message, or only those that
   * expect a response.
   */
  slack?: { bot_token?: string; app_token?: string; owner?: string; since?: string; post?: 'all' | 'expects_response' };
  /** The in-app chat. Model defaults to the first default model. */
  assistant?: { model?: string };
  /** When the first-run setup was finished (or skipped). Until then the app shows it. */
  onboarded_at?: string;
  /** Update checks: automatic (default on), and the npm dist-tag to follow (latest = stable, next = preview). */
  updates?: { auto?: boolean; channel?: 'latest' | 'next' };
  defaults: {
    harness: string;
    models: string[];
    budget_usd: number;
    max_parallel: number;
    guardrails: Guardrails;
  };
}

/** One model provider. Secret fields live in Dopbase as PROVIDER_<ID>_API_KEY and PROVIDER_<ID>_MASTER_KEY. */
export interface ProviderConfig {
  /** Short name, used in model names ("<id>/<model>") and in the Dopbase key names. */
  id: string;
  /** litellm today; later anthropic, claude-subscription, openai, openrouter, opper, berget. */
  kind: string;
  url?: string;
  /** Key for model calls (LiteLLM: when no master key is set). */
  api_key?: string;
  /** LiteLLM: with a master key Yaho mints one virtual key per job, capped at the agent's remaining budget. */
  master_key?: string;
}

/**
 * Settings files from before providers: the litellm block becomes the first provider. Runs on the raw YAML, so the
 * file on disk, the secrets move and the in-memory settings all see the same shape.
 */
export function migrateSettingsShape(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.litellm && !raw.providers) {
    raw.providers = [{ id: 'litellm', kind: 'litellm', ...(raw.litellm as object) }];
    delete raw.litellm;
  }
  return raw;
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
  harnesses: { 'claude-code': { command: 'claude' }, codex: { command: 'codex' } },
  providers: [{ id: 'litellm', kind: 'litellm', url: 'http://localhost:4000' }],
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
  const raw = migrateSettingsShape((YAML.parse(readFileSync(p.settings, 'utf8')) ?? {}) as Record<string, unknown>);
  return merge(defaultSettings(), raw);
}

/** Settings that are secrets: [section, field, Dopbase key]. They live in the bundled Dopbase, not in settings.yaml. */
/**
 * One secret setting: where it sits in the settings (path, for the UI's secrets_set), its Dopbase key, and the object
 * holding it. Secrets live in the bundled Dopbase, not in settings.yaml.
 */
export interface SecretSlot {
  path: string;
  key: string;
  field: string;
  /** The object holding the field; with create, made when missing (an optional section like slack). */
  holder(s: Settings, create?: boolean): Record<string, unknown> | undefined;
}

const keyPart = (id: string) => id.toUpperCase().replace(/[^A-Z0-9]/g, '_');

export function secretSlots(s: Settings): SecretSlot[] {
  const section = (name: 'composio' | 'slack') => (x: Settings, create?: boolean) =>
    (create ? (x[name] ??= {}) : x[name]) as Record<string, unknown> | undefined;
  return [
    ...s.providers.flatMap((p) =>
      (['api_key', 'master_key'] as const).map((field) => ({
        path: `providers.${p.id}.${field}`,
        key: `PROVIDER_${keyPart(p.id)}_${field.toUpperCase()}`,
        field,
        holder: (x: Settings) => x.providers.find((q) => q.id === p.id) as unknown as Record<string, unknown> | undefined,
      })),
    ),
    { path: 'composio.api_key', key: 'COMPOSIO_API_KEY', field: 'api_key', holder: section('composio') },
    { path: 'slack.bot_token', key: 'SLACK_BOT_TOKEN', field: 'bot_token', holder: section('slack') },
    { path: 'slack.app_token', key: 'SLACK_APP_TOKEN', field: 'app_token', holder: section('slack') },
  ];
}

/** Secret settings (by path) confirmed in Dopbase; saveSettings leaves them out of the file. */
export const secretsStored = new Set<string>();

export function saveSettings(s: Settings): void {
  const out = structuredClone(s);
  for (const slot of secretSlots(out)) if (secretsStored.has(slot.path)) delete slot.holder(out)?.[slot.field];
  writeFileSync(paths().settings, YAML.stringify(out));
}

/** The API token every caller (UI, CLI admin use) presents. Created once per data directory. */
export function apiToken(): string {
  const p = paths();
  mkdirSync(p.root, { recursive: true });
  if (!existsSync(p.token)) writeFileSync(p.token, randomBytes(24).toString('hex'));
  return readFileSync(p.token, 'utf8').trim();
}
