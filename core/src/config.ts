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
  /**
   * WhatsApp: the inbox as messages from the person's own WhatsApp Business number, over the Cloud API (a webhook, so
   * Yaho must be reachable from the internet). number is the person's own WhatsApp number; since is when they first
   * wrote to Yaho; last_inbound opens the 24-hour window; template (one {{1}} variable) says messages are waiting when
   * it is closed. since, last_inbound, nudged and verify_token are managed by the core.
   */
  whatsapp?: {
    access_token?: string;
    app_secret?: string;
    phone_number_id?: string;
    number?: string;
    verify_token?: string;
    since?: string;
    last_inbound?: string;
    nudged?: string;
    post?: 'all' | 'expects_response';
    template?: string;
    template_language?: string;
  };
  /**
   * Email through Resend: agents with email on get <agent>@<domain>, send from it, and replies come back through
   * Resend's inbound webhook (so Yaho must be reachable from the internet). accept_new: also take emails that are not
   * replies to one an agent sent.
   */
  resend?: { api_key?: string; webhook_secret?: string; domain?: string; accept_new?: boolean };
  /**
   * SMS through Twilio: agents with sms on share one Twilio number, and texts to it come back through Twilio's webhook
   * (so Yaho must be reachable from the internet), to the agent that last texted that phone. new_agent: the agent that
   * gets texts from phones no agent has texted; unset, those are dropped.
   */
  twilio?: { account_sid?: string; auth_token?: string; number?: string; new_agent?: string };
  /**
   * Telegram: the inbox as messages from the person's own bot, over long polling (no webhook, so it also works on the
   * desktop). owner is the chat that opened the bot's link with link_code; since is when that happened. owner, since,
   * link_code and bot are managed by the core.
   */
  telegram?: { bot_token?: string; owner?: string; since?: string; link_code?: string; bot?: string; post?: 'all' | 'expects_response' };
  /** Run harnesses in their sandbox (writes only to the agent's workspace). Unset: on in the server version, off on the desktop. */
  sandbox?: boolean;
  /** Past jobs: recaps by the agent's last model when a job ends, for yaho history search (default on). */
  history?: { recaps?: boolean };
  /**
   * A browser for agents with browser on (yaho browser). provider: local (Chrome, Edge or Chromium on this machine;
   * executable overrides which, headless false shows its window on the desktop) or a cloud browser over CDP: Browserbase
   * (api_key, project_id), Steel (api_key) or any CDP endpoint (cdp_url). allowed_sites (Guard Rails): the sites its
   * tabs may open; empty means any.
   */
  browser?: {
    provider?: 'local' | 'browserbase' | 'steel' | 'cdp';
    executable?: string;
    headless?: boolean;
    api_key?: string;
    project_id?: string;
    cdp_url?: string;
    allowed_sites?: string[];
  };
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
  totp: join(root, 'totp-secret'),
  server: join(root, 'server.yaml'),
  bin: join(root, 'bin'),
  /** The core's Unix socket, for sandboxed jobs (not on Windows). */
  socket: join(root, 'bin', 'yaho.sock'),
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
  const section =
    (name: 'composio' | 'slack' | 'whatsapp' | 'resend' | 'twilio' | 'telegram' | 'browser') => (x: Settings, create?: boolean) =>
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
    { path: 'whatsapp.access_token', key: 'WHATSAPP_ACCESS_TOKEN', field: 'access_token', holder: section('whatsapp') },
    { path: 'whatsapp.app_secret', key: 'WHATSAPP_APP_SECRET', field: 'app_secret', holder: section('whatsapp') },
    { path: 'resend.api_key', key: 'RESEND_API_KEY', field: 'api_key', holder: section('resend') },
    { path: 'resend.webhook_secret', key: 'RESEND_WEBHOOK_SECRET', field: 'webhook_secret', holder: section('resend') },
    { path: 'twilio.auth_token', key: 'TWILIO_AUTH_TOKEN', field: 'auth_token', holder: section('twilio') },
    { path: 'browser.api_key', key: 'BROWSER_API_KEY', field: 'api_key', holder: section('browser') },
    { path: 'browser.cdp_url', key: 'BROWSER_CDP_URL', field: 'cdp_url', holder: section('browser') },
    { path: 'telegram.bot_token', key: 'TELEGRAM_BOT_TOKEN', field: 'bot_token', holder: section('telegram') },
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
