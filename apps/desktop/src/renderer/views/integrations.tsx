import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronRight, MonitorX } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Card, Section } from '../components/ui/display.tsx';
import { Field, Input, Select, Switch } from '../components/ui/form.tsx';
import { BrandLogo } from '../components/BrandLogo.tsx';
import { api, useApi } from '../lib/api.ts';
import { platform } from '../lib/platform.ts';
import { href } from '../lib/router.ts';
import { cn } from '../components/ui/cn.ts';
import { Check, type Settings } from './settings.tsx';

/** How an integration stands: set up and working, needing attention, broken, or not set up. */
type State = 'ok' | 'warn' | 'error' | 'off';
interface Summary {
  state: State;
  line: string;
}

const DOT: Record<State, string> = { ok: 'bg-ok', warn: 'bg-warn', error: 'bg-danger', off: 'bg-line-strong' };

const notConnected = (st: { configured: boolean; connected: boolean; error?: string }): Summary | null =>
  !st.configured
    ? { state: 'off', line: 'Not set up.' }
    : st.error
      ? { state: 'error', line: `Not connected: ${st.error}` }
      : !st.connected
        ? { state: 'warn', line: 'Connecting…' }
        : null;

/** Each integration's status line, from its status endpoint. The list and the integration's own page show the same. */
const SUMMARY = {
  slack: (st?: SlackStatus): Summary =>
    !st
      ? { state: 'off', line: '' }
      : (notConnected(st) ??
        (!st.owner
          ? { state: 'warn', line: `Connected to ${st.team ?? 'Slack'}. Open Yaho in Slack once (Apps → Yaho) so it knows it is you.` }
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
};

interface ComposioHealth {
  configured: boolean;
  error?: string;
  connections?: Array<{ status: string; toolkit: string; resources: string[] }>;
}

/** Composio is fine while its key works and every connection a resource uses is active (an expired sign-in needs attention). */
function composioSummary(h?: ComposioHealth): Summary {
  if (!h) return { state: 'off', line: '' };
  if (!h.configured) return { state: 'off', line: 'Not set up.' };
  if (h.error) return { state: 'error', line: `Not connected: ${h.error}` };
  const conns = h.connections ?? [];
  const broken = conns.filter((c) => !['ACTIVE', 'INITIATED', 'INITIALIZING'].includes(c.status));
  if (broken.length)
    return {
      state: 'warn',
      line: `${broken.length} connection${broken.length === 1 ? ' needs' : 's need'} attention: ${broken.map((c) => `${c.toolkit} (${c.status.toLowerCase()})`).join(', ')}.`,
    };
  return { state: 'ok', line: `Connected · ${conns.length} connection${conns.length === 1 ? '' : 's'}.` };
}

function useComposioHealth(enabled: boolean): ComposioHealth | undefined {
  const status = useApi<{ configured: boolean }>(
    enabled ? '/api/composio/status' : null,
    (e) => e.type === 'changed' && e.entity === 'settings',
  );
  const conns = useApi<ComposioHealth['connections']>(
    enabled && status.data?.configured ? '/api/composio/connections' : null,
    (e) => e.type === 'changed' && (e.entity === 'settings' || e.entity === 'resources'),
  );
  if (!status.data) return undefined;
  if (!status.data.configured) return { configured: false };
  if (conns.error) return { configured: true, error: conns.error };
  if (!conns.data) return undefined;
  return { configured: true, connections: conns.data };
}

type Id = 'slack' | 'telegram' | 'whatsapp' | 'email' | 'sms' | 'browser' | 'composio';

/** Every integration: what it is, its logo, and whether it needs Yaho reachable from the internet (the server version). */
const INTEGRATIONS: Array<{ id: Id; name: string; brand: string; about: string; online?: boolean; status?: string; entity?: string }> = [
  {
    id: 'slack',
    name: 'Slack',
    brand: 'slack',
    about: 'Your inbox as Slack DMs, answered from Slack.',
    status: '/api/slack',
    entity: 'slack',
  },
  {
    id: 'telegram',
    name: 'Telegram',
    brand: 'telegram',
    about: 'Your inbox in a chat with your own Telegram bot.',
    status: '/api/telegram',
    entity: 'telegram',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    brand: 'whatsapp',
    about: 'Your inbox on WhatsApp, through your own business number.',
    online: true,
    status: '/api/whatsapp',
    entity: 'whatsapp',
  },
  {
    id: 'email',
    name: 'Email',
    brand: 'resend',
    about: 'Agents get their own address through Resend and act on replies.',
    online: true,
    status: '/api/resend',
    entity: 'resend',
  },
  {
    id: 'sms',
    name: 'SMS',
    brand: 'twilio',
    about: 'Agents text people from a Twilio number and act on replies.',
    online: true,
    status: '/api/twilio',
    entity: 'twilio',
  },
  {
    id: 'browser',
    name: 'Browser',
    brand: 'browser',
    about: 'A real browser for agents: open pages, sign in, click and fill in forms.',
    status: '/api/browser',
    entity: 'browser',
  },
  { id: 'composio', name: 'Composio', brand: 'composio', about: 'Gmail, Calendar, GitHub and hundreds more apps for agents.' },
];

/** Integrations need webhooks from the internet, which only the server version gets. */
const DESKTOP_NOTE =
  'Not available on the desktop version of Yaho: it needs webhooks from the internet, which only the server version receives.';

/**
 * Settings → Integrations: every integration with its status (#/settings/integrations), and a click through to one's
 * own settings (#/settings/integrations/<id>). Its fields are saved with Save Settings, like the rest of Settings.
 */
export function Integrations({
  route,
  settings: s,
  upd,
  save,
  server,
}: {
  route: string[];
  settings: Settings;
  upd: (fn: (d: Settings) => void) => void;
  save: () => Promise<boolean>;
  server: boolean;
}) {
  const def = INTEGRATIONS.find((i) => i.id === route[0]);
  if (!def)
    return (
      <Section title="Integrations">
        <Card className="divide-y divide-line">
          {INTEGRATIONS.map((i) => (
            <IntegrationRow key={i.id} def={i} available={!i.online || server} />
          ))}
        </Card>
      </Section>
    );
  const available = !def.online || server;
  const stored = s.secrets_set ?? {};
  return (
    <section className="space-y-4">
      <a href={href('settings', 'integrations')} className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> All Integrations
      </a>
      <h2 className="flex items-center gap-3 text-lg font-semibold">
        <BrandLogo brand={def.brand} />
        {def.name}
      </h2>
      {!available ? (
        <Card className="flex items-start gap-3 p-4 text-sm text-muted">
          <MonitorX className="mt-0.5 size-4 shrink-0" />
          <span>{DESKTOP_NOTE}</span>
        </Card>
      ) : def.id === 'slack' ? (
        <SlackSettings value={s.slack ?? {}} stored={stored} onChange={(v) => upd((d) => void (d.slack = v))} />
      ) : def.id === 'telegram' ? (
        <TelegramSettings value={s.telegram ?? {}} stored={stored} onChange={(v) => upd((d) => void (d.telegram = v))} />
      ) : def.id === 'whatsapp' ? (
        <WhatsAppSettings value={s.whatsapp ?? {}} stored={stored} server={server} onChange={(v) => upd((d) => void (d.whatsapp = v))} />
      ) : def.id === 'email' ? (
        <EmailSettings value={s.resend ?? {}} stored={stored} server={server} onChange={(v) => upd((d) => void (d.resend = v))} />
      ) : def.id === 'browser' ? (
        <BrowserSettings value={s.browser ?? {}} stored={stored} server={server} onChange={(v) => upd((d) => void (d.browser = v))} />
      ) : def.id === 'sms' ? (
        <SmsSettings value={s.twilio ?? {}} stored={stored} server={server} onChange={(v) => upd((d) => void (d.twilio = v))} />
      ) : (
        <ComposioSettings settings={s} upd={upd} save={save} />
      )}
    </section>
  );
}

/** One line of the list: logo, name, what it does, and how it stands. */
function IntegrationRow({ def, available }: { def: (typeof INTEGRATIONS)[number]; available: boolean }) {
  const st = useApi<never>(
    available && def.status ? def.status : null,
    (e) => e.type === 'changed' && (e.entity === def.entity || e.entity === 'settings'),
  );
  const composio = useComposioHealth(available && def.id === 'composio');
  const summary: Summary | undefined = !available
    ? undefined
    : def.id === 'composio'
      ? composio && composioSummary(composio)
      : st.data
        ? SUMMARY[def.id as Exclude<Id, 'composio'>](st.data)
        : undefined;
  return (
    <a href={href('settings', 'integrations', def.id)} className="flex items-center gap-3 px-4 py-3 hover:bg-hover/60">
      <BrandLogo brand={def.brand} className={cn(!available && 'opacity-50 grayscale')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">
          {def.name}
          {!available && <span className="rounded-full bg-hover px-2 py-0.5 text-[11px] font-normal text-muted">Server version only</span>}
        </div>
        <div className="truncate text-xs text-muted" title={summary?.line || undefined}>
          {!available ? 'Not available on the desktop version of Yaho.' : summary && summary.state !== 'off' ? summary.line : def.about}
        </div>
      </div>
      <StateMark state={available ? summary?.state : undefined} />
      <ChevronRight className="size-4 shrink-0 text-muted" />
    </a>
  );
}

function StateMark({ state }: { state?: State }) {
  if (state === 'ok') return <CheckCircle2 className="size-5 shrink-0 text-ok" aria-label="Set up" />;
  if (state === 'warn') return <AlertTriangle className="size-5 shrink-0 text-warn" aria-label="Needs attention" />;
  if (state === 'error') return <AlertTriangle className="size-5 shrink-0 text-danger" aria-label="Not working" />;
  return <span className="shrink-0 text-xs text-muted">{state === 'off' ? 'Not set up' : ''}</span>;
}

/** The numbered setup steps every integration page shows. */
function Steps({ steps }: { steps: Array<[string, ReactNode]> }) {
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

function StatusLine({ state, line, action }: { state: State; line: string; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className={cn('size-2 shrink-0 rounded-full', DOT[state])} />
      <span className="min-w-0 flex-1">{line}</span>
      {action}
    </div>
  );
}

function ComposioSettings({
  settings: s,
  upd,
  save,
}: {
  settings: Settings;
  upd: (fn: (d: Settings) => void) => void;
  save: () => Promise<boolean>;
}) {
  const health = useComposioHealth(true);
  const summary = composioSummary(health);
  return (
    <Card className="grid gap-4 p-4 md:grid-cols-2">
      {health && (
        <div className="md:col-span-2">
          <StatusLine {...summary} />
        </div>
      )}
      <ComposioKeyHelp />
      <Field label="Composio API Key" hint="Agents never see it: Yaho makes their calls.">
        <Input
          type="password"
          value={s.composio?.api_key ?? ''}
          placeholder={s.secrets_set?.['composio.api_key'] ? 'Value set · type to replace' : undefined}
          onChange={(e) => upd((d) => void (d.composio = { ...d.composio, api_key: e.target.value || undefined }))}
        />
      </Field>
      <Field label="User ID" hint="Whose connections Yaho uses in your Composio project.">
        <Input
          value={s.composio?.user_id ?? 'yaho'}
          onChange={(e) => upd((d) => void (d.composio = { ...d.composio, user_id: e.target.value || undefined }))}
        />
      </Field>
      <div className="md:col-span-2">
        <Check
          label="Test Composio"
          run={async () => {
            if (!(await save())) throw new Error('could not save the settings');
            const r = await api<Array<{ toolkit: string }>>('/api/composio/connections');
            return `connected · ${r.length} connection${r.length === 1 ? '' : 's'}`;
          }}
        />
      </div>
    </Card>
  );
}

interface TelegramStatus {
  configured: boolean;
  connected: boolean;
  bot?: string;
  linked: boolean;
  error?: string;
  link_url?: string;
}

/**
 * Your Yaho inbox in a chat with your own Telegram bot. Yaho fetches the bot's updates itself (long polling), so it
 * works on the desktop too. Opening the bot's one-time link tells Yaho which chat is yours.
 */
function TelegramSettings({
  value,
  stored,
  onChange,
}: {
  value: NonNullable<Settings['telegram']>;
  stored: Record<string, boolean>;
  onChange: (v: NonNullable<Settings['telegram']>) => void;
}) {
  const status = useApi<TelegramStatus>(
    '/api/telegram',
    (e) => e.type === 'changed' && (e.entity === 'telegram' || e.entity === 'settings'),
  );
  const st = status.data;
  const set = (patch: Partial<NonNullable<Settings['telegram']>>) => onChange({ ...value, ...patch });
  const { line, state } = SUMMARY.telegram(st ?? undefined);
  const steps: Array<[string, ReactNode]> = [
    [
      'Create a bot with BotFather',
      <>
        <div className="mt-1.5">
          <Button size="sm" variant="primary" onClick={() => platform.openExternal('https://t.me/BotFather')}>
            Open BotFather
          </Button>
        </div>
        <p className="mt-1.5 text-muted">
          Send <code>/newbot</code>, give it a name and a username ending in <code>bot</code>. BotFather answers with the bot's token: paste
          it below as Bot Token and click <b className="text-ink">Save Settings</b>.
        </p>
      </>,
    ],
    [
      'Open your bot',
      <>
        <div className="mt-1.5">
          <Button size="sm" disabled={!st?.link_url} onClick={() => st?.link_url && platform.openExternal(st.link_url)}>
            Open in Telegram
          </Button>
        </div>
        <p className="mt-1.5 text-muted">
          The link carries a one-time code: press <b className="text-ink">Start</b> in Telegram and Yaho answers that it is connected. Only
          that chat can use the bot.
        </p>
      </>,
    ],
  ];
  return (
    <Card className="space-y-4 p-4">
      <StatusLine
        state={state}
        line={line}
        action={
          st?.configured && (
            <Button size="sm" onClick={() => void api('/api/telegram/reconnect', { method: 'POST' }).then(() => status.reload())}>
              Reconnect
            </Button>
          )
        }
      />
      <Steps steps={steps} />
      <Field label="Bot Token" hint="From BotFather, like 123456789:AA…">
        <Input
          type="password"
          value={value.bot_token ?? ''}
          placeholder={stored['telegram.bot_token'] ? 'Value set · type to replace' : '123456789:AA…'}
          onChange={(e) => set({ bot_token: e.target.value.trim() || undefined })}
        />
      </Field>
      <PostChoice label="Post to Telegram" value={value.post} onChange={(post) => set({ post })} />
      {st?.linked && (
        <p className="text-xs text-muted">
          Linked to one Telegram chat.{' '}
          <button
            type="button"
            className="cursor-pointer text-accent hover:underline"
            onClick={() => void api('/api/telegram/forget-owner', { method: 'POST' }).then(() => status.reload())}
          >
            Forget it
          </button>{' '}
          to make a new link.
        </p>
      )}
    </Card>
  );
}

/** How to create a Composio API key, and which permissions Yaho needs. */
function ComposioKeyHelp() {
  const rows: Array<[string, string, string]> = [
    ['Toolkits', 'Read', 'the All Apps list'],
    ['Tools', 'Read', 'tool lists and their inputs'],
    ['Connected accounts', 'Read + Write', 'your connections; Write lets the Connect button add new ones'],
    ['Auth configs', 'Read + Write', 'Write sets up sign-in the first time you connect an app'],
    ['Tool execution', 'Write', 'agents running tools with yaho tool'],
  ];
  return (
    <details className="group rounded-lg border border-line bg-bg/60 px-3 py-2 text-sm md:col-span-2">
      <summary className="cursor-pointer font-medium text-ink/90 select-none">How to Get a Composio API Key</summary>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-ink/85">
        <li>
          Sign in at{' '}
          <button
            type="button"
            className="cursor-pointer text-accent underline"
            onClick={() => platform.openExternal('https://platform.composio.dev')}
          >
            platform.composio.dev
          </button>{' '}
          (a free account is enough) and open your project.
        </li>
        <li>Go to the project's Settings → API Keys and choose Create API key. Name it, for example, "Yaho".</li>
        <li>Tick these permissions. They can't be changed later, so check them before you create the key:</li>
      </ol>
      <table className="mt-2 ml-5 text-xs">
        <tbody>
          {rows.map(([perm, level, why]) => (
            <tr key={perm}>
              <td className="py-0.5 pr-4 font-medium">{perm}</td>
              <td className="py-0.5 pr-4 whitespace-nowrap text-accent">{level}</td>
              <td className="py-0.5 text-muted">{why}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 ml-5 text-xs text-muted">
        Sessions, session tool execution and triggers are not used. Tool execution sits further down Composio's list than the others.
      </p>
      <ol start={4} className="mt-2 list-decimal space-y-1.5 pl-5 text-ink/85">
        <li>Copy the key, paste it below and press Test Composio. Composio shows the key only once.</li>
        <li>
          Then open{' '}
          <a className="text-accent underline" href={href('resources', 'composio')}>
            Resources → From Composio
          </a>{' '}
          to connect apps and add them as resources.
        </li>
      </ol>
    </details>
  );
}

interface SlackStatus {
  configured: boolean;
  connected: boolean;
  team?: string;
  owner: boolean;
  error?: string;
  create_url: string;
  manifest: string;
}

/**
 * Your Yaho inbox as Slack DMs. Setup: create the app from Yaho's manifest, install it, paste its two tokens, then
 * open Yaho in Slack once so it knows it is you. Tokens are saved with Save Settings, which reconnects.
 */
function SlackSettings({
  value,
  stored,
  onChange,
}: {
  value: NonNullable<Settings['slack']>;
  stored: Record<string, boolean>;
  onChange: (v: NonNullable<Settings['slack']>) => void;
}) {
  const status = useApi<SlackStatus>('/api/slack', (e) => e.type === 'changed' && (e.entity === 'slack' || e.entity === 'settings'));
  const st = status.data;
  const set = (patch: Partial<NonNullable<Settings['slack']>>) => onChange({ ...value, ...patch });
  const { line, state: tone } = SUMMARY.slack(st ?? undefined);
  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('size-2 shrink-0 rounded-full', DOT[tone])} />
        <span className="min-w-0 flex-1">{line}</span>
        {st?.configured && (
          <Button size="sm" onClick={() => void api('/api/slack/reconnect', { method: 'POST' }).then(() => status.reload())}>
            Reconnect
          </Button>
        )}
      </div>
      <ol className="space-y-3 text-sm">
        {(
          [
            [
              'Create the app',
              <>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" onClick={() => st && platform.openExternal(st.create_url)}>
                    Open Slack
                  </Button>
                  <Button size="sm" onClick={() => st && void navigator.clipboard.writeText(st.manifest)}>
                    Copy Manifest
                  </Button>
                </div>
                <p className="mt-1.5 text-muted">
                  In Slack choose <b className="text-ink">Create New App → From a Manifest</b>, pick your workspace, switch to JSON, paste
                  the manifest over what is there, and click <b className="text-ink">Create</b>.
                </p>
              </>,
            ],
            [
              'Install it and copy the Bot Token',
              <p className="mt-0.5 text-muted">
                In the app's left menu open <b className="text-ink">OAuth &amp; Permissions</b>, click{' '}
                <b className="text-ink">Install to Workspace</b> and allow it. Copy the <b className="text-ink">Bot User OAuth Token</b>{' '}
                (starts with <code>xoxb-</code>) into Bot Token below.
              </p>,
            ],
            [
              'Make the App Token',
              <p className="mt-0.5 text-muted">
                Open <b className="text-ink">Basic Information</b>, scroll to <b className="text-ink">App-Level Tokens</b>, click{' '}
                <b className="text-ink">Generate Token and Scopes</b>, name it Yaho, add the scope <code>connections:write</code>, and
                generate. Copy the token (starts with <code>xapp-</code>) into App Token below. The other secrets on that page are not
                needed.
              </p>,
            ],
            [
              'Save and say hello',
              <p className="mt-0.5 text-muted">
                Click <b className="text-ink">Save Settings</b>. Then in Slack open <b className="text-ink">Apps → Yaho</b> once: the first
                person to open it becomes its owner, and Yaho DMs you that it is connected.
              </p>,
            ],
          ] as const
        ).map(([title, body], i) => (
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
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Bot Token" hint="OAuth & Permissions → Bot User OAuth Token (xoxb-…).">
          <Input
            type="password"
            value={value.bot_token ?? ''}
            placeholder={stored['slack.bot_token'] ? 'Value set · type to replace' : 'xoxb-…'}
            onChange={(e) => set({ bot_token: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="App Token" hint="Basic Information → App-Level Tokens (xapp-…).">
          <Input
            type="password"
            value={value.app_token ?? ''}
            placeholder={stored['slack.app_token'] ? 'Value set · type to replace' : 'xapp-…'}
            onChange={(e) => set({ app_token: e.target.value.trim() || undefined })}
          />
        </Field>
      </div>
      <PostChoice label="Post to Slack" value={value.post} onChange={(post) => set({ post })} />
      {st?.owner && (
        <p className="text-xs text-muted">
          Linked to one Slack user.{' '}
          <button
            type="button"
            className="cursor-pointer text-accent hover:underline"
            onClick={() => void api('/api/slack/forget-owner', { method: 'POST' }).then(() => status.reload())}
          >
            Forget it
          </button>{' '}
          to let whoever opens the app next become the owner.
        </p>
      )}
    </Card>
  );
}

/** Choose between posting every message or only those that wait for an answer (Slack and WhatsApp). */
function PostChoice({
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

interface WhatsAppStatus {
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

/**
 * Your Yaho inbox on WhatsApp, through the Cloud API and your own Meta app and business number. Meta calls Yaho's
 * webhook, so it needs the server version, reachable over HTTPS.
 */
function WhatsAppSettings({
  value,
  stored,
  server,
  onChange,
}: {
  value: NonNullable<Settings['whatsapp']>;
  stored: Record<string, boolean>;
  server: boolean;
  onChange: (v: NonNullable<Settings['whatsapp']>) => void;
}) {
  const status = useApi<WhatsAppStatus>(
    '/api/whatsapp',
    (e) => e.type === 'changed' && (e.entity === 'whatsapp' || e.entity === 'settings'),
  );
  const st = status.data;
  const set = (patch: Partial<NonNullable<Settings['whatsapp']>>) => onChange({ ...value, ...patch });
  const webhook = st ? (server ? `${location.origin}${st.webhook_path}` : `https://<your tunnel>${st.webhook_path}`) : '';
  const { line, state: tone } = SUMMARY.whatsapp(st ?? undefined);
  const steps: Array<[string, ReactNode]> = [
    [
      'Create a Meta app with WhatsApp',
      <>
        <div className="mt-1.5">
          <Button size="sm" variant="primary" onClick={() => platform.openExternal('https://developers.facebook.com/apps/create/')}>
            Open Meta for Developers
          </Button>
        </div>
        <p className="mt-1.5 text-muted">
          Create an app of type <b className="text-ink">Business</b> and add the <b className="text-ink">WhatsApp</b> product. Under{' '}
          <b className="text-ink">WhatsApp → API Setup</b> use the free test number (add your own number as a recipient) or add a number of
          your own. That number becomes Yaho's; it cannot also be on the WhatsApp app. Copy its <b className="text-ink">Phone Number ID</b>{' '}
          below.
        </p>
      </>,
    ],
    [
      'Make a lasting token',
      <p className="mt-0.5 text-muted">
        The token on API Setup lasts a day. In <b className="text-ink">Business Settings → System Users</b> add a system user, give it the
        app with full control, and generate a token with <code>whatsapp_business_messaging</code> and{' '}
        <code>whatsapp_business_management</code>. Paste it as Access Token. Copy the <b className="text-ink">App Secret</b> from{' '}
        <b className="text-ink">App Settings → Basic</b>.
      </p>,
    ],
    [
      'Point the webhook at Yaho',
      <>
        <p className="mt-0.5 text-muted">
          In <b className="text-ink">WhatsApp → Configuration → Webhook</b> enter this callback URL and verify token, verify, then subscribe
          to <b className="text-ink">messages</b>.
        </p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void navigator.clipboard.writeText(webhook)}>
            Copy Callback URL
          </Button>
          <Button size="sm" onClick={() => st?.verify_token && void navigator.clipboard.writeText(st.verify_token)}>
            Copy Verify Token
          </Button>
        </div>
        {st?.last_webhook && <p className="mt-1 text-xs text-muted">Last heard from Meta {new Date(st.last_webhook).toLocaleString()}.</p>}
      </>,
    ],
    [
      'Save and say hello',
      <p className="mt-0.5 text-muted">
        Enter your own WhatsApp number, click <b className="text-ink">Save Settings</b>, and send Yaho's number any message from WhatsApp.
        Yaho answers that it is connected. Only your number can use it.
      </p>,
    ],
  ];
  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('size-2 shrink-0 rounded-full', DOT[tone])} />
        <span className="min-w-0 flex-1">{line}</span>
        {st?.configured && (
          <Button size="sm" onClick={() => void api('/api/whatsapp/reconnect', { method: 'POST' }).then(() => status.reload())}>
            Reconnect
          </Button>
        )}
      </div>
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
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Phone Number ID" hint="WhatsApp → API Setup, under the number.">
          <Input value={value.phone_number_id ?? ''} onChange={(e) => set({ phone_number_id: e.target.value.trim() || undefined })} />
        </Field>
        <Field label="Your WhatsApp Number" hint="With country code. Only this number can use Yaho.">
          <Input
            value={value.number ?? ''}
            placeholder="+46 70 123 45 67"
            onChange={(e) => set({ number: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="Access Token" hint="A system user's token.">
          <Input
            type="password"
            value={value.access_token ?? ''}
            placeholder={stored['whatsapp.access_token'] ? 'Value set · type to replace' : 'EAA…'}
            onChange={(e) => set({ access_token: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="App Secret" hint="App Settings → Basic. Checks that webhook calls come from Meta.">
          <Input
            type="password"
            value={value.app_secret ?? ''}
            placeholder={stored['whatsapp.app_secret'] ? 'Value set · type to replace' : undefined}
            onChange={(e) => set({ app_secret: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field
          label="Waiting Template (Optional)"
          hint={
            <>
              WhatsApp only lets Yaho write freely within 24 hours of your last message. With an approved Utility template whose body has
              one variable, such as “Your Yaho agents have new messages: {'{{1}}'}”, Yaho tells you once when messages are waiting.
            </>
          }
        >
          <Input
            value={value.template ?? ''}
            placeholder="yaho_waiting"
            onChange={(e) => set({ template: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="Template Language" hint="The language code it was approved in.">
          <Input
            value={value.template_language ?? ''}
            placeholder="en"
            onChange={(e) => set({ template_language: e.target.value.trim() || undefined })}
          />
        </Field>
      </div>
      <PostChoice label="Post to WhatsApp" value={value.post} onChange={(post) => set({ post })} />
    </Card>
  );
}

interface EmailStatus {
  configured: boolean;
  connected: boolean;
  domain?: string;
  domain_status?: string;
  last_webhook?: string;
  last_ignored?: string;
  error?: string;
  webhook_path: string;
}

/**
 * Email for agents through Resend: agents with Email on get <name>@<domain>, and replies come back through Resend's
 * inbound webhook, so Yaho must be reachable over HTTPS like for WhatsApp.
 */
function EmailSettings({
  value,
  stored,
  server,
  onChange,
}: {
  value: NonNullable<Settings['resend']>;
  stored: Record<string, boolean>;
  server: boolean;
  onChange: (v: NonNullable<Settings['resend']>) => void;
}) {
  const status = useApi<EmailStatus>('/api/resend', (e) => e.type === 'changed' && (e.entity === 'resend' || e.entity === 'settings'));
  const st = status.data;
  const set = (patch: Partial<NonNullable<Settings['resend']>>) => onChange({ ...value, ...patch });
  const webhook = st ? (server ? `${location.origin}${st.webhook_path}` : `https://<your tunnel>${st.webhook_path}`) : '';
  const { line, state: tone } = SUMMARY.email(st ?? undefined);
  const steps: Array<[string, ReactNode]> = [
    [
      'Add your domain to Resend',
      <>
        <div className="mt-1.5">
          <Button size="sm" variant="primary" onClick={() => platform.openExternal('https://resend.com/domains')}>
            Open Resend Domains
          </Button>
        </div>
        <p className="mt-1.5 text-muted">
          Add a domain (a subdomain such as <code>agents.example.com</code> keeps it apart from your own mail), add the DNS records Resend
          shows, and turn on <b className="text-ink">Receiving</b> for it, which adds an MX record. Every address on it then reaches Yaho.
        </p>
      </>,
    ],
    [
      'Make an API key',
      <p className="mt-0.5 text-muted">
        In <b className="text-ink">API Keys</b> create a key with <b className="text-ink">Full access</b> (Yaho reads received emails, which
        a sending-only key cannot) and paste it below.
      </p>,
    ],
    [
      'Point the webhook at Yaho',
      <>
        <p className="mt-0.5 text-muted">
          In <b className="text-ink">Webhooks</b> add an endpoint with this URL and the <b className="text-ink">email.received</b> event,
          then paste its <b className="text-ink">Signing Secret</b> below.
        </p>
        <div className="mt-1.5">
          <Button size="sm" onClick={() => void navigator.clipboard.writeText(webhook)}>
            Copy Webhook URL
          </Button>
        </div>
        {st?.last_webhook && (
          <p className="mt-1 text-xs text-muted">Last heard from Resend {new Date(st.last_webhook).toLocaleString()}.</p>
        )}
        {st?.last_ignored && <p className="mt-1 text-xs text-muted">Last email not delivered: {st.last_ignored}</p>}
      </>,
    ],
    [
      'Turn on Email for an agent',
      <p className="mt-0.5 text-muted">
        In the agent's settings under <b className="text-ink">Access</b>. With its Inbox Trigger on, a reply starts a job right away.
      </p>,
    ],
  ];
  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('size-2 shrink-0 rounded-full', DOT[tone])} />
        <span className="min-w-0 flex-1">{line}</span>
        {st?.configured && (
          <Button size="sm" onClick={() => void api('/api/resend/reconnect', { method: 'POST' }).then(() => status.reload())}>
            Reconnect
          </Button>
        )}
      </div>
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
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Domain" hint="Verified in Resend, with receiving on.">
          <Input
            value={value.domain ?? ''}
            placeholder="agents.example.com"
            onChange={(e) => set({ domain: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="API Key" hint="Full access.">
          <Input
            type="password"
            value={value.api_key ?? ''}
            placeholder={stored['resend.api_key'] ? 'Value set · type to replace' : 're_…'}
            onChange={(e) => set({ api_key: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="Webhook Signing Secret" hint="Checks that webhook calls come from Resend.">
          <Input
            type="password"
            value={value.webhook_secret ?? ''}
            placeholder={stored['resend.webhook_secret'] ? 'Value set · type to replace' : 'whsec_…'}
            onChange={(e) => set({ webhook_secret: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field
          label="Accept New Emails"
          hint="Off: agents only get replies to emails they sent. On: anyone who writes to an agent's address reaches it."
        >
          <div className="flex h-9 items-center">
            <Switch checked={!!value.accept_new} onChange={(v) => set({ accept_new: v || undefined })} label="Accept New Emails" />
          </div>
        </Field>
      </div>
    </Card>
  );
}

interface SmsStatus {
  configured: boolean;
  connected: boolean;
  number?: string;
  sms_url?: string;
  last_webhook?: string;
  last_ignored?: string;
  error?: string;
  webhook_path: string;
}

/**
 * SMS for agents through Twilio: agents with SMS on share one number, and texts to it come back through Twilio's
 * webhook to the agent that last texted that phone, so Yaho must be reachable over HTTPS like for Email.
 */
function SmsSettings({
  value,
  stored,
  server,
  onChange,
}: {
  value: NonNullable<Settings['twilio']>;
  stored: Record<string, boolean>;
  server: boolean;
  onChange: (v: NonNullable<Settings['twilio']>) => void;
}) {
  const status = useApi<SmsStatus>('/api/twilio', (e) => e.type === 'changed' && (e.entity === 'twilio' || e.entity === 'settings'));
  const agents = useApi<Array<{ name: string; sms?: boolean }>>('/api/agents');
  const st = status.data;
  const set = (patch: Partial<NonNullable<Settings['twilio']>>) => onChange({ ...value, ...patch });
  const webhook = st ? (server ? `${location.origin}${st.webhook_path}` : `https://<your tunnel>${st.webhook_path}`) : '';
  const { line, state: tone } = SUMMARY.sms(st ?? undefined);
  const steps: Array<[string, ReactNode]> = [
    [
      'Get a Twilio number',
      <>
        <div className="mt-1.5">
          <Button
            size="sm"
            variant="primary"
            onClick={() => platform.openExternal('https://console.twilio.com/us1/develop/phone-numbers/manage/incoming')}
          >
            Open Twilio Numbers
          </Button>
        </div>
        <p className="mt-1.5 text-muted">
          Buy a number that can send and receive <b className="text-ink">SMS</b> in the country of the people your agents will text (some
          countries need a registration first), and type it below in international form.
        </p>
      </>,
    ],
    [
      'Copy the account keys',
      <p className="mt-0.5 text-muted">
        The <b className="text-ink">Account SID</b> and <b className="text-ink">Auth Token</b> on the Twilio Console's home page; paste them
        below. The token also checks that webhook calls come from Twilio.
      </p>,
    ],
    [
      'Point the number at Yaho',
      <>
        <p className="mt-0.5 text-muted">
          On the number's page under <b className="text-ink">Messaging Configuration</b>, set <b className="text-ink">A message comes in</b>{' '}
          to Webhook, this URL, HTTP POST, and save.
        </p>
        <div className="mt-1.5">
          <Button size="sm" onClick={() => void navigator.clipboard.writeText(webhook)}>
            Copy Webhook URL
          </Button>
        </div>
        {st?.last_webhook && (
          <p className="mt-1 text-xs text-muted">Last heard from Twilio {new Date(st.last_webhook).toLocaleString()}.</p>
        )}
        {st?.last_ignored && <p className="mt-1 text-xs text-muted">Last text not delivered: {st.last_ignored}</p>}
      </>,
    ],
    [
      'Turn on SMS for an agent',
      <p className="mt-0.5 text-muted">
        In the agent's settings under <b className="text-ink">Access</b>. A reply goes to the agent that texted that phone last, and with
        its Inbox Trigger on it starts a job right away.
      </p>,
    ],
  ];
  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('size-2 shrink-0 rounded-full', DOT[tone])} />
        <span className="min-w-0 flex-1">{line}</span>
        {st?.configured && (
          <Button size="sm" onClick={() => void api('/api/twilio/reconnect', { method: 'POST' }).then(() => status.reload())}>
            Reconnect
          </Button>
        )}
      </div>
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
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Phone Number" hint="The Twilio number, in international form.">
          <Input
            value={value.number ?? ''}
            placeholder="+46701234567"
            onChange={(e) => set({ number: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="Account SID">
          <Input
            value={value.account_sid ?? ''}
            placeholder="AC…"
            onChange={(e) => set({ account_sid: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="Auth Token">
          <Input
            type="password"
            value={value.auth_token ?? ''}
            placeholder={stored['twilio.auth_token'] ? 'Value set · type to replace' : 'Auth Token'}
            onChange={(e) => set({ auth_token: e.target.value.trim() || undefined })}
          />
        </Field>
        <Field label="New Texts Go To" hint="Texts from phones no agent has texted. Nobody: they are dropped.">
          <Select value={value.new_agent ?? ''} onChange={(e) => set({ new_agent: e.target.value || undefined })}>
            <option value="">Nobody</option>
            {(agents.data ?? [])
              .filter((a) => a.sms || a.name === value.new_agent)
              .map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
          </Select>
        </Field>
      </div>
    </Card>
  );
}

interface BrowserStatus {
  provider: string;
  ready: boolean;
  detail: string;
  running: number;
}

const BROWSER_PROVIDERS = {
  local: 'This computer',
  browserbase: 'Browserbase',
  steel: 'Steel',
  cdp: 'Other (CDP URL)',
} as const;

function BrowserSettings({
  value,
  stored,
  server,
  onChange,
}: {
  value: NonNullable<Settings['browser']>;
  stored: Record<string, boolean>;
  server: boolean;
  onChange: (v: NonNullable<Settings['browser']>) => void;
}) {
  const status = useApi<BrowserStatus>('/api/browser', (e) => e.type === 'changed' && e.entity === 'settings');
  const [test, setTest] = useState<{ ok: boolean; error?: string; version?: string } | 'running' | null>(null);
  const set = (patch: Partial<NonNullable<Settings['browser']>>) => onChange({ ...value, ...patch });
  const provider = value.provider ?? 'local';
  const { line, state } = SUMMARY.browser(status.data ?? undefined);
  const secret = (path: string, label: string) => (stored[path] ? 'Value set · type to replace' : label);
  return (
    <Card className="space-y-4 p-4">
      <StatusLine
        state={state}
        line={line}
        action={
          <Button
            size="sm"
            disabled={test === 'running'}
            onClick={async () => {
              setTest('running');
              setTest(
                await api<{ ok: boolean; error?: string; version?: string }>('/api/browser/test', { method: 'POST' }).catch((e: Error) => ({
                  ok: false,
                  error: e.message,
                })),
              );
            }}
          >
            {test === 'running' ? 'Testing…' : 'Test'}
          </Button>
        }
      />
      {test && test !== 'running' && (
        <p className={cn('text-xs', test.ok ? 'text-ok' : 'text-danger')}>
          {test.ok ? `Started ${test.version ?? 'the browser'} and closed it again.` : test.error}
        </p>
      )}
      <p className="text-sm text-muted">
        Agents with <b className="text-ink">Browser</b> on (in the agent's settings under Access) get a browser of their own in each job,
        closed when the job ends, and drive it with <code>yaho browser</code>. Sign-ins stay between jobs. Save Settings before testing a
        change.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Where It Runs">
          <Select
            value={provider}
            onChange={(e) => set({ provider: e.target.value === 'local' ? undefined : (e.target.value as typeof provider) })}
          >
            {Object.entries(BROWSER_PROVIDERS).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        {provider === 'local' && (
          <>
            <Field label="Browser Path" hint="Empty: the installed Chrome, Edge or Chromium.">
              <Input
                value={value.executable ?? ''}
                placeholder={status.data?.provider === 'local' && status.data.ready ? status.data.detail : ''}
                onChange={(e) => set({ executable: e.target.value.trim() || undefined })}
              />
            </Field>
            {!server && (
              <label className="flex items-start gap-3 text-sm md:col-span-2">
                <Switch
                  checked={value.headless === false}
                  label="Show the Window"
                  onChange={(v) => set({ headless: v ? false : undefined })}
                />
                <span>
                  Show the Window
                  <span className="block text-xs text-muted">
                    Watch agents browse, and step in to sign in or solve a captcha. Off: the browser runs hidden.
                  </span>
                </span>
              </label>
            )}
          </>
        )}
        {(provider === 'browserbase' || provider === 'steel') && (
          <Field label="API Key" hint="Agents never see it.">
            <Input
              type="password"
              value={value.api_key ?? ''}
              placeholder={secret('browser.api_key', 'API Key')}
              onChange={(e) => set({ api_key: e.target.value.trim() || undefined })}
            />
          </Field>
        )}
        {provider === 'browserbase' && (
          <Field label="Project ID">
            <Input value={value.project_id ?? ''} onChange={(e) => set({ project_id: e.target.value.trim() || undefined })} />
          </Field>
        )}
        {provider === 'cdp' && (
          <Field label="CDP URL" hint="A ws:// or wss:// endpoint (or http:// to look it up), e.g. Browserless or Browser Use.">
            <Input
              type="password"
              value={value.cdp_url ?? ''}
              placeholder={secret('browser.cdp_url', 'wss://…')}
              onChange={(e) => set({ cdp_url: e.target.value.trim() || undefined })}
            />
          </Field>
        )}
      </div>
      {provider !== 'local' && (
        <p className="text-xs text-muted">
          Each job gets its own session at {BROWSER_PROVIDERS[provider]}, released when the job ends; its live view is linked in the job.
          Cookies are saved between jobs.
        </p>
      )}
      <p className="text-xs text-muted">Which sites the browser may open is set in Guard Rails.</p>
    </Card>
  );
}
