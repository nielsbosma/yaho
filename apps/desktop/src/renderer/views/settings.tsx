import { Check as CheckIcon, CheckCircle2, Monitor, Moon, Sun, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Card, ErrorNote, PageHeader, Section } from '../components/ui/display.tsx';
import { Field, Input, Select, Switch } from '../components/ui/form.tsx';
import { ModelPicker } from '../components/ModelPicker.tsx';
import type { AppState } from '../App.tsx';
import { ClaudeCheckPanel } from './onboarding.tsx';
import { api, useApi } from '../lib/api.ts';
import { platform } from '../lib/platform.ts';
import { href } from '../lib/router.ts';
import { PALETTES, usePalette, useTheme, type Theme } from '../lib/theme.ts';
import { cn } from '../components/ui/cn.ts';

interface Settings {
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
  ideas?: { enabled?: boolean; repo?: string };
  defaults: { harness: string; models: string[]; budget_usd: number; max_parallel: number; guardrails: Record<string, number | undefined> };
}

function Check({ label, run }: { label: string; run: () => Promise<string> }) {
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="flex items-center gap-3">
      <Button
        size="sm"
        onClick={async () => {
          setState(null);
          try {
            setState({ ok: true, text: await run() });
          } catch (e) {
            setState({ ok: false, text: (e as Error).message });
          }
        }}
      >
        {label}
      </Button>
      {state && (
        <span className={`flex items-center gap-1 text-xs ${state.ok ? 'text-ok' : 'text-danger'}`}>
          {state.ok ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />} {state.text}
        </span>
      )}
    </div>
  );
}

export function SettingsView() {
  const state = useApi<AppState>('/api/state');
  const saved = useApi<Settings>('/api/settings', (e) => e.type === 'changed' && e.entity === 'settings');
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (saved.data) setS(structuredClone(saved.data));
  }, [saved.data]);
  if (!s) return null;

  const upd = (fn: (d: Settings) => void) =>
    setS((prev) => {
      const next = structuredClone(prev!);
      fn(next);
      return next;
    });
  // The LiteLLM provider, the only kind that works today; made if a settings file has none.
  const liteOf = (d: Settings) => {
    let p = d.providers.find((x) => x.kind === 'litellm');
    if (!p) d.providers.unshift((p = { id: 'litellm', kind: 'litellm', url: 'http://localhost:4000' }));
    return p;
  };
  const lite = s.providers.find((x) => x.kind === 'litellm') ?? { id: 'litellm', kind: 'litellm' };
  const updLite = (fn: (p: Settings['providers'][number]) => void) => upd((d) => fn(liteOf(d)));

  const save = async () => {
    setError(null);
    setOk(false);
    try {
      await api('/api/settings', { method: 'PUT', body: s });
      setOk(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title="Settings"
        sub="Stored as settings.yaml in the data directory; keys and tokens are kept in the bundled Dopbase."
        actions={
          <>
            {ok && <span className="text-sm text-ok">Saved</span>}
            <Button onClick={() => void api('/api/onboarding/reset', { method: 'POST' }).then(() => location.reload())}>Run Setup Again</Button>
            <Button variant="primary" onClick={() => void save()}>
              Save Settings
            </Button>
          </>
        }
      />
      <div className="max-w-3xl space-y-8 p-8">
        <ErrorNote>{error}</ErrorNote>
        <Appearance />
        <Section title="Models (LiteLLM)">
          <Card className="grid gap-4 p-4 md:grid-cols-2">
            <p className="text-xs text-muted md:col-span-2">
              LiteLLM is the model provider today. OpenAI, Anthropic, your Claude Code subscription, OpenRouter, Opper.AI and Berget.AI are coming.
            </p>
            <Field label="Proxy URL" className="md:col-span-2">
              <Input value={lite.url ?? ''} onChange={(e) => updLite((p) => void (p.url = e.target.value))} />
            </Field>
            <Field label="API Key" hint="Used by jobs when no master key is set.">
              <Input
                type="password"
                value={lite.api_key ?? ''}
                placeholder={s.secrets_set?.[`providers.${lite.id}.api_key`] ? 'Value set · type to replace' : undefined}
                onChange={(e) => updLite((p) => void (p.api_key = e.target.value || undefined))}
              />
            </Field>
            <Field label="Master Key (Optional)" hint="Lets Yaho mint a budget-capped key per job, so LiteLLM enforces budgets.">
              <Input
                type="password"
                value={lite.master_key ?? ''}
                placeholder={s.secrets_set?.[`providers.${lite.id}.master_key`] ? 'Value set · type to replace' : undefined}
                onChange={(e) => updLite((p) => void (p.master_key = e.target.value || undefined))}
              />
            </Field>
            <div className="md:col-span-2">
              <Check
                label="List Models"
                run={async () => {
                  await save();
                  const r = await api<{ models: string[] }>('/api/settings/litellm/models');
                  return `${r.models.length} models: ${r.models.slice(0, 6).join(', ')}${r.models.length > 6 ? '…' : ''}`;
                }}
              />
            </div>
          </Card>
        </Section>
        <Section title="Secrets (Dopbase)">
          <Card className="grid gap-4 p-4 md:grid-cols-2">
            <Field label="Where Values Live" className="md:col-span-2">
              <div className="flex gap-1 rounded-lg bg-hover p-0.5 text-sm w-fit">
                {(['bundled', 'external'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => upd((d) => void (d.dopbase.mode = m))}
                    className={`cursor-pointer rounded-md px-3 py-1 ${s.dopbase.mode === m ? 'bg-panel shadow-sm' : 'text-muted'}`}
                  >
                    {m === 'bundled' ? 'Bundled (Local)' : 'External Server'}
                  </button>
                ))}
              </div>
            </Field>
            {s.dopbase.mode === 'bundled' ? (
              <Field label="Local Port" hint="Yaho runs its own Dopbase on 127.0.0.1, with its data in the Yaho data directory.">
                <Input
                  type="number"
                  value={s.dopbase.local_port ?? 4702}
                  onChange={(e) => upd((d) => void (d.dopbase.local_port = Number(e.target.value)))}
                />
              </Field>
            ) : (
              <>
                <Field label="Server URL">
                  <Input value={s.dopbase.url} onChange={(e) => upd((d) => void (d.dopbase.url = e.target.value))} />
                </Field>
                <Field label="Token" hint="A Dopbase CLI or admin token that can create projects and set secrets.">
                  <Input
                    type="password"
                    value={s.dopbase.token ?? ''}
                    onChange={(e) => upd((d) => void (d.dopbase.token = e.target.value || undefined))}
                  />
                </Field>
              </>
            )}
            <Field label="Environment">
              <Input value={s.dopbase.environment} onChange={(e) => upd((d) => void (d.dopbase.environment = e.target.value))} />
            </Field>
            <Field label="Project Prefix" hint="Each resource is the Dopbase project <prefix><resource>.">
              <Input value={s.dopbase.project_prefix} onChange={(e) => upd((d) => void (d.dopbase.project_prefix = e.target.value))} />
            </Field>
            <div className="md:col-span-2">
              <Check
                label="Test Connection"
                run={async () => {
                  await save();
                  const r = await api<{ ok: boolean; error?: string; health?: { version?: string } }>('/api/settings/dopbase/test', {
                    method: 'POST',
                  });
                  if (!r.ok) throw new Error(r.error ?? 'failed');
                  return `connected${r.health?.version ? ` (Dopbase ${r.health.version})` : ''}`;
                }}
              />
            </div>
          </Card>
        </Section>
        <Section title="Slack">
          <SlackSettings value={s.slack ?? {}} stored={s.secrets_set ?? {}} onChange={(v) => upd((d) => void (d.slack = v))} />
        </Section>
        <Section title="Apps (Composio)">
          <Card className="grid gap-4 p-4 md:grid-cols-2">
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
                  await save();
                  const r = await api<Array<{ toolkit: string }>>('/api/composio/connections');
                  return `connected · ${r.length} connection${r.length === 1 ? '' : 's'}`;
                }}
              />
            </div>
          </Card>
        </Section>
        <Section title="Spending">
          <Card className="grid gap-4 p-4 md:grid-cols-2">
            <Field label="Global Spend Cap (USD)" hint="When total spend reaches it, no job starts and running jobs stop.">
              <Input
                type="number"
                min="0"
                value={s.global_spend_cap_usd}
                onChange={(e) => upd((d) => void (d.global_spend_cap_usd = Number(e.target.value)))}
              />
            </Field>
          </Card>
        </Section>
        <Section title="Defaults for New Agents">
          <Card className="grid gap-4 p-4 md:grid-cols-2">
            <Field label="Models" className="md:col-span-2" group>
              <ModelPicker value={s.defaults.models} onChange={(v) => upd((d) => void (d.defaults.models = v))} />
            </Field>
            <Field label="Budget (USD)">
              <Input
                type="number"
                min="0"
                value={s.defaults.budget_usd}
                onChange={(e) => upd((d) => void (d.defaults.budget_usd = Number(e.target.value)))}
              />
            </Field>
            <Field label="Max Parallel Jobs">
              <Input
                type="number"
                min="1"
                value={s.defaults.max_parallel}
                onChange={(e) => upd((d) => void (d.defaults.max_parallel = Number(e.target.value)))}
              />
            </Field>
          </Card>
        </Section>
        {state.data?.server && <ServerAccess />}
        <Section title="Updates">
          <Card className="space-y-4 p-4">
            <Switch
              checked={s.updates?.auto !== false}
              onChange={(v) => upd((d) => void (d.updates = { ...d.updates, auto: v }))}
              label="Check for Updates Automatically"
            />
            <Field label="Update Channel" hint="Preview gets new versions first, before they are released to everyone.">
              <Select value={s.updates?.channel ?? 'latest'} onChange={(e) => upd((d) => void (d.updates = { ...d.updates, channel: e.target.value as 'latest' | 'next' }))}>
                <option value="latest">Stable</option>
                <option value="next">Preview</option>
              </Select>
            </Field>
          </Card>
        </Section>
        <Section title="Claude Code">
          <Card className="p-4">
            <ClaudeCheckPanel auto={false} />
          </Card>
        </Section>
        <Section title="Harnesses">
          <Card className="space-y-3 p-4">
            {Object.entries(s.harnesses).map(([name, h]) => (
              <Field key={name} label={name} hint="The command Yaho runs for this harness.">
                <Input value={h.command} onChange={(e) => upd((d) => void (d.harnesses[name]!.command = e.target.value))} />
              </Field>
            ))}
            {s.harnesses['claude-code'] && (
              <label className="flex items-start gap-3 pt-1 text-sm">
                <Switch
                  checked={!!s.harnesses['claude-code'].args?.includes('--chrome')}
                  label="Agents Can Use Chrome"
                  onChange={(v) =>
                    upd((d) => {
                      const h = d.harnesses['claude-code']!;
                      const rest = (h.args ?? []).filter((a) => a !== '--chrome');
                      h.args = v ? [...rest, '--chrome'] : rest;
                    })
                  }
                />
                <span>
                  Agents Can Use Chrome
                  <span className="block text-xs text-muted">
                    Starts Claude Code with <code>--chrome</code>, so every agent gets the Claude in Chrome browser tools. Needs Chrome open
                    with the Claude extension signed in. Agents act in your real browser, with your logins.
                  </span>
                </span>
              </label>
            )}
          </Card>
        </Section>

        {state.data?.debug && (
          <Section title="Debug">
            <Card className="space-y-4 p-4">
              <p className="text-sm text-muted">Shown because Yaho runs in debug mode (the dev session, or YAHO_DEBUG=1).</p>
              <label className="flex items-start gap-3 text-sm">
                <Switch
                  checked={s.ideas?.enabled !== false}
                  label="Agents File Ideas for Yaho"
                  onChange={(v) => upd((d) => void (d.ideas = { ...d.ideas, enabled: v }))}
                />
                <span>
                  Agents File Ideas for Yaho as GitHub Issues
                  <span className="block text-xs text-muted">
                    When something about Yaho holds an agent back, it suggests a feature with <code>yaho idea</code>. Filed with your{' '}
                    <code>gh</code> login; without it, the idea comes to your inbox with a link instead. At most 3 per agent a day.
                  </span>
                </span>
              </label>
            </Card>
          </Section>
        )}
      </div>
    </>
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

/** Light or dark, and the color theme. Applied at once and kept on this device, not in settings.yaml. */
function Appearance() {
  const [theme, setTheme] = useTheme();
  const [palette, setPalette] = usePalette();
  const modes: Array<[Theme, typeof Sun, string]> = [
    ['system', Monitor, 'Match System'],
    ['light', Sun, 'Light'],
    ['dark', Moon, 'Dark'],
  ];
  return (
    <Section title="Appearance">
      <Card className="space-y-5 p-4">
        <Field label="Mode">
          <div className="flex w-fit rounded-lg bg-hover p-0.5 text-sm" role="radiogroup" aria-label="Mode">
            {modes.map(([t, Icon, label]) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={theme === t}
                onClick={() => setTheme(t)}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 [&_svg]:size-3.5',
                  theme === t ? 'bg-panel shadow-sm' : 'text-muted hover:text-ink',
                )}
              >
                <Icon /> {label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Color Theme" hint="Buttons, links, charts and highlights. Each has a light and a dark shade.">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Color theme">
            {PALETTES.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={palette === p.id}
                onClick={() => setPalette(p.id)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-lg border py-1.5 pr-3 pl-1.5 text-sm transition-colors',
                  palette === p.id ? 'border-accent bg-accent/10' : 'border-line hover:border-line-strong',
                )}
              >
                <span className="flex size-6 overflow-hidden rounded-md">
                  <span className="flex-1" style={{ background: p.light }} />
                  <span className="flex-1" style={{ background: p.dark }} />
                </span>
                {p.label}
                {palette === p.id && <CheckIcon className="size-3.5 text-accent" />}
              </button>
            ))}
          </div>
        </Field>
      </Card>
    </Section>
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
  onChange: (v: NonNullable<Settings['slack']>) => void }) {
  const status = useApi<SlackStatus>('/api/slack', (e) => e.type === 'changed' && (e.entity === 'slack' || e.entity === 'settings'));
  const st = status.data;
  const set = (patch: Partial<NonNullable<Settings['slack']>>) => onChange({ ...value, ...patch });
  const line = !st
    ? ''
    : !st.configured
      ? 'Not set up.'
      : st.error
        ? `Not connected: ${st.error}`
        : !st.connected
          ? 'Connecting…'
          : !st.owner
            ? `Connected to ${st.team ?? 'Slack'}. Open Yaho in Slack once (Apps → Yaho) so it knows it is you.`
            : `Connected to ${st.team ?? 'Slack'}. Your inbox is posted to your DMs.`;
  const tone = st?.connected && st.owner ? 'bg-ok' : st?.error ? 'bg-danger' : st?.configured ? 'bg-warn' : 'bg-line-strong';
  return (
    <Card className="space-y-4 p-4">
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('size-2 shrink-0 rounded-full', tone)} />
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
                  In Slack choose <b className="text-ink">Create New App → From a Manifest</b>, pick your workspace, switch to JSON, paste the
                  manifest over what is there, and click <b className="text-ink">Create</b>.
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
                <b className="text-ink">Generate Token and Scopes</b>, name it Yaho, add the scope <code>connections:write</code>, and generate.
                Copy the token (starts with <code>xapp-</code>) into App Token below. The other secrets on that page are not needed.
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
          <Input type="password" value={value.bot_token ?? ''} placeholder={stored['slack.bot_token'] ? 'Value set · type to replace' : 'xoxb-…'} onChange={(e) => set({ bot_token: e.target.value.trim() || undefined })} />
        </Field>
        <Field label="App Token" hint="Basic Information → App-Level Tokens (xapp-…).">
          <Input type="password" value={value.app_token ?? ''} placeholder={stored['slack.app_token'] ? 'Value set · type to replace' : 'xapp-…'} onChange={(e) => set({ app_token: e.target.value.trim() || undefined })} />
        </Field>
      </div>
      <Field label="Post to Slack">
        <div className="flex w-fit rounded-lg bg-hover p-0.5 text-sm" role="radiogroup" aria-label="Post to Slack">
          {(
            [
              ['all', 'All Messages'],
              ['expects_response', 'Only Messages That Expect a Response'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={(value.post ?? 'all') === v}
              onClick={() => set({ post: v })}
              className={cn('cursor-pointer rounded-md px-3 py-1', (value.post ?? 'all') === v ? 'bg-panel shadow-sm' : 'text-muted hover:text-ink')}
            >
              {label}
            </button>
          ))}
        </div>
      </Field>
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

/** Server version: sign out, end every session, and the API token for the CLI and scripts (after the password). */
function ServerAccess() {
  const [password, setPassword] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signOut = async (everywhere: boolean) => {
    if (everywhere) await api('/api/session/revoke-all', { method: 'POST' });
    await fetch('/api/session', { method: 'DELETE' });
    location.reload();
  };
  return (
    <Section title="Server Access">
      <Card className="space-y-4 p-4">
        <p className="text-sm text-muted">
          The password is YAHO_PASSWORD in this server's deploy settings. Change it there and redeploy; that also signs everyone out.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void signOut(false)}>Sign Out</Button>
          <Button onClick={() => void signOut(true)}>Sign Out Everywhere</Button>
        </div>
        <Field label="API Token" hint="For the yaho CLI and scripts. Enter the password to show it.">
          {token ? (
            <code className="block rounded-lg bg-code px-3 py-2 text-xs break-all select-all">{token}</code>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                try {
                  setToken((await api<{ token: string }>('/api/session/token', { body: { password } })).token);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <div className="flex-1">
                <Input type="password" value={password} placeholder="Password" onChange={(e) => setPassword(e.target.value)} />
              </div>
              <Button type="submit" disabled={!password}>
                Show Token
              </Button>
            </form>
          )}
        </Field>
        <ErrorNote>{error}</ErrorNote>
      </Card>
    </Section>
  );
}
