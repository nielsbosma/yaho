import type { CommandRule } from '../../components/CommandRulesEditor.tsx';

export interface Settings {
  /** Which secrets are stored in Dopbase ("section.field"); their values never come to the UI. */
  secrets_set?: Record<string, boolean>;
  updates?: { auto?: boolean; channel?: 'latest' | 'next' };
  server: { host: string; port: number };
  harnesses: Record<string, { command: string; args?: string[] }>;
  providers: Array<{ id: string; kind: string; url?: string; api_key?: string; master_key?: string }>;
  default_provider?: string;
  dopbase: { mode: 'bundled' | 'external'; url: string; token?: string; local_port?: number; environment: string; project_prefix: string };
  global_spend_cap_usd: number;
  composio?: { api_key?: string; user_id?: string };
  slack?: { bot_token?: string; app_token?: string; owner?: string; since?: string; post?: 'all' | 'expects_response' };
  whatsapp?: {
    access_token?: string;
    app_secret?: string;
    phone_number_id?: string;
    number?: string;
    post?: 'all' | 'expects_response';
    template?: string;
    template_language?: string;
  };
  resend?: { api_key?: string; webhook_secret?: string; domain?: string; accept_new?: boolean };
  twilio?: { account_sid?: string; auth_token?: string; number?: string; new_agent?: string };
  browser?: {
    provider?: 'local' | 'browserbase' | 'steel' | 'cdp';
    executable?: string;
    headless?: boolean;
    api_key?: string;
    project_id?: string;
    cdp_url?: string;
    allowed_sites?: string[];
  };
  telegram?: { bot_token?: string; post?: 'all' | 'expects_response' };
  sandbox?: boolean;
  command_rules?: { enabled?: boolean; rules?: CommandRule[] };
  history?: { recaps?: boolean };
  ideas?: { enabled?: boolean; repo?: string };
  defaults: { harness: string; models: string[]; budget_usd: number; max_parallel: number; guardrails: Record<string, number | undefined> };
}

/** Change the settings being edited (a draft; Save Settings stores it). */
export type Upd = (fn: (d: Settings) => void) => void;
