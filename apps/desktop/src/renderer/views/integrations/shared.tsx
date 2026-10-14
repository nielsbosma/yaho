import { useState, type ReactNode } from 'react';
import { Field } from '../../components/ui/form.tsx';
import { cn } from '../../components/ui/cn.ts';
import { api, type Webhook } from '../../lib/api.ts';

/** How an integration stands: set up and working, needing attention, broken, or not set up. */
export type State = 'ok' | 'warn' | 'error' | 'off';
export interface Summary {
  state: State;
  line: string;
}

export const DOT: Record<State, string> = { ok: 'bg-ok', warn: 'bg-warn', error: 'bg-danger', off: 'bg-line-strong' };

export const notConnected = (st: { configured: boolean; connected: boolean; error?: string }): Summary | null =>
  !st.configured
    ? { state: 'off', line: 'Not set up.' }
    : st.error
      ? { state: 'error', line: `Not connected: ${st.error}` }
      : !st.connected
        ? { state: 'warn', line: 'Connecting…' }
        : null;

/** Each integration's status line, from its status endpoint. The list and the integration's own page show the same. */
export const SUMMARY = {
  slack: (st?: SlackStatus): Summary =>
    !st
      ? { state: 'off', line: '' }
      : (notConnected(st) ??
        (!st.owner
          ? { state: 'warn', line: `Connected to ${st.team ?? 'Slack'}. Send Yaho your link code (step 4) so it knows it is you.` }
          : { state: 'ok', line: `Connected to ${st.team ?? 'Slack'}. Your inbox is posted to your DMs.` })),
  telegram: (st?: TelegramStatus): Summary =>
    !st
      ? { state: 'off', line: '' }
      : (notConnected(st) ??
        (!st.linked
          ? { state: 'warn', line: `Connected to @${st.bot ?? 'your bot'}. Open the bot's link (step 2) so Yaho knows it is you.` }
          : { state: 'ok', line: `Connected to @${st.bot ?? 'your bot'}. Your inbox is posted to your Telegram.` })),
  whatsapp: (st?: WhatsAppStatus): Summary =>
    !st
      ? { state: 'off', line: '' }
      : (notConnected(st) ??
        (!st.owner
          ? { state: 'warn', line: `Connected to ${st.number ?? 'WhatsApp'}. Enter your own WhatsApp number below.` }
          : !st.linked
            ? {
                state: 'warn',
                line: `Connected to ${st.number ?? 'WhatsApp'}. Send it any message from your WhatsApp so Yaho knows it is you.`,
              }
            : st.window_open
              ? { state: 'ok', line: `Connected to ${st.number ?? 'WhatsApp'}. Your inbox is posted to your WhatsApp.` }
              : {
                  state: 'ok',
                  line: `Connected to ${st.number ?? 'WhatsApp'}. Messages wait until you next write to it (WhatsApp's 24-hour rule).`,
                })),
  email: (st?: EmailStatus): Summary =>
    !st
      ? { state: 'off', line: '' }
      : (notConnected(st) ??
        (st.domain_status === 'verified'
          ? { state: 'ok', line: `Connected. Agents with Email on send from <name>@${st.domain}.` }
          : {
              state: 'warn',
              line: `Connected, but ${st.domain} is ${st.domain_status?.replace(/_/g, ' ') ?? 'not verified'} in Resend.`,
            })),
  browser: (st?: BrowserStatus): Summary =>
    !st
      ? { state: 'off', line: '' }
      : !st.ready
        ? { state: 'warn', line: `${st.detail}.` }
        : {
            state: 'ok',
            line: `${st.provider === 'local' ? `Local: ${st.detail}` : st.detail}.${st.running ? ` ${st.running} open now.` : ''} For agents with Browser on.`,
          },
  sms: (st?: SmsStatus): Summary => {
    if (!st) return { state: 'off', line: '' };
    const pointed = !!st.sms_url && st.sms_url.endsWith(st.webhook_path);
    return (
      notConnected(st) ??
      (pointed
        ? { state: 'ok', line: `Connected. Agents with SMS on text from ${st.number}.` }
        : {
            state: 'warn',
            line: `Connected, but texts to ${st.number} go ${st.sms_url ? `to ${st.sms_url}` : 'nowhere'}; point its webhook at Yaho (step 3).`,
          })
    );
  },
  webhooks: (list?: Webhook[]): Summary => {
    if (!list) return { state: 'off', line: '' };
    if (!list.length) return { state: 'off', line: 'Not set up.' };
    const day = new Date(Date.now() - 86_400_000).toISOString();
    const refused = list.filter((w) => w.last_rejected && w.last_rejected > day && w.last_rejected > (w.last_delivery ?? ''));
    const agents = new Set(list.map((w) => w.agent)).size;
    const count = `${list.length} webhook${list.length === 1 ? '' : 's'} on ${agents} agent${agents === 1 ? '' : 's'}`;
    return refused.length
      ? { state: 'warn', line: `${count}. Refused lately: ${refused.map((w) => `${w.agent}/${w.name}`).join(', ')}.` }
      : { state: 'ok', line: `${count}.` };
  },
};

export interface TelegramStatus {
  configured: boolean;
  connected: boolean;
  bot?: string;
  linked: boolean;
  error?: string;
  link_url?: string;
}

export interface SlackStatus {
  configured: boolean;
  connected: boolean;
  team?: string;
  owner: boolean;
  link_code?: string;
  error?: string;
  create_url: string;
  manifest: string;
}

export interface WhatsAppStatus {
  configured: boolean;
  connected: boolean;
  number?: string;
  name?: string;
  owner: boolean;
  linked: boolean;
  window_open: boolean;
  last_webhook?: string;
  error?: string;
  webhook_path: string;
  verify_token?: string;
}

export interface EmailStatus {
  configured: boolean;
  connected: boolean;
  domain?: string;
  domain_status?: string;
  last_webhook?: string;
  last_ignored?: string;
  error?: string;
  webhook_path: string;
}

export interface SmsStatus {
  configured: boolean;
  connected: boolean;
  number?: string;
  sms_url?: string;
  last_webhook?: string;
  last_ignored?: string;
  error?: string;
  webhook_path: string;
}

export interface BrowserStatus {
  provider: string;
  ready: boolean;
  detail: string;
  running: number;
}

/** The numbered setup steps every integration page shows. */
export function Steps({ steps }: { steps: Array<[string, ReactNode]> }) {
  return (
    <ol className="space-y-3 text-sm">
      {steps.map(([title, body], i) => (
        <li key={title} className="flex gap-3">
          <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-hover text-[11px] font-semibold text-muted">
            {i + 1}
          </span>
          <div className="min-w-0">
            <div className="font-medium">{title}</div>
            {body}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** A button's call to the core: the error, if any, is kept to show instead of lost. */
export function useAction(): [string | undefined, (path: string, then: () => void) => void] {
  const [error, setError] = useState<string>();
  const run = (path: string, then: () => void) => {
    setError(undefined);
    api(path, { method: 'POST' }).then(then, (e: Error) => setError(e.message));
  };
  return [error, run];
}

export function StatusLine({ state, line, action }: { state: State; line: string; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={cn('size-2 shrink-0 rounded-full', DOT[state])} />
      <span className="min-w-0 flex-1">{line}</span>
      {action}
    </div>
  );
}

/** Choose between posting every message or only those that wait for an answer (Slack and WhatsApp). */
export function PostChoice({
  label,
  value,
  onChange,
}: {
  label: string;
  value: 'all' | 'expects_response' | undefined;
  onChange: (v: 'all' | 'expects_response') => void;
}) {
  return (
    <Field label={label}>
      <div className="flex w-fit rounded-lg bg-hover p-0.5 text-sm" role="radiogroup" aria-label={label}>
        {(
          [
            ['all', 'All Messages'],
            ['expects_response', 'Only Messages That Expect a Response'],
          ] as const
        ).map(([v, text]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={(value ?? 'all') === v}
            onClick={() => onChange(v)}
            className={cn(
              'cursor-pointer rounded-md px-3 py-1',
              (value ?? 'all') === v ? 'bg-panel shadow-sm' : 'text-muted hover:text-ink',
            )}
          >
            {text}
          </button>
        ))}
      </div>
    </Field>
  );
}

export const listText = (v?: string | string[]) => (Array.isArray(v) ? v.join(', ') : (v ?? ''));
