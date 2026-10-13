import { Check as CheckIcon, CheckCircle2, Monitor, Moon, Plus, Sun, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState, Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Card, ErrorNote, PageHeader, Section } from '../components/ui/display.tsx';
import { Field, Input, Select, Switch } from '../components/ui/form.tsx';
import { ModelPicker } from '../components/ModelPicker.tsx';
import type { AppState } from '../App.tsx';
import { ClaudeCheckPanel } from './onboarding.tsx';
import { BrandLogo } from '../components/BrandLogo.tsx';
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

/** Equal settings, whatever order their keys were set in; an empty value counts as absent. */
const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([, x]) => x !== undefined && x !== '')
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canon(x)]),
        )
      : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

export function SettingsView({ route }: { route: string[] }) {
  const state = useApi<AppState>('/api/state');
  const saved = useApi<Settings>('/api/settings', (e) => e.type === 'changed' && e.entity === 'settings');
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  /** What the page last loaded: a change elsewhere (the chat, another window) replaces the page only when it has no edits. */
  const [base, setBase] = useState<Settings | null>(null);
  useEffect(() => {
    if (!saved.data) return;
    setS((prev) => (prev && base && !same(prev, base) ? prev : structuredClone(saved.data!)));
    setBase(saved.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.data]);
  if (!s) return null;
  /** Something differs from what was last loaded or saved. */
  const dirty = !!base && same(s, base) === false;

  const upd = (fn: (d: Settings) => void) =>
    setS((prev) => {
      const next = structuredClone(prev!);
      fn(next);
      return next;
    });

  /** Save; false when it failed (the error shows at the top), so a Test after it stops. */
  const save = async (): Promise<boolean> => {
    setError(null);
    setOk(false);
    try {
      await api('/api/settings', { method: 'PUT', body: s });
      setBase(s);
      setOk(true);
      setTimeout(() => setOk(false), 2000);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Settings"
        actions={
          <>
            <Button onClick={() => void api('/api/onboarding/reset', { method: 'POST' }).then(() => location.reload())}>Run Setup Again</Button>
            <Button variant="primary" disabled={!dirty} title={dirty ? undefined : 'Nothing to save'} onClick={() => void save()}>
              Save Settings
            </Button>
            {/* Fades in after a save and away again by itself. */}
            <span
              role="status"
              aria-live="polite"
              className={cn('flex items-center gap-1 text-sm text-ok transition-all duration-300', ok ? 'translate-x-0 opacity-100' : '-translate-x-1 opacity-0')}
            >
              <CheckIcon className="size-4" /> Saved
            </span>
          </>
        }
      />
      <SettingsPanes active={route[1]} error={error}>
        <Pane id="appearance" label="Appearance">
          <Appearance />
        </Pane>
        <Pane id="models" label="Model Providers">
          <ModelProviders settings={s} upd={upd} save={save} />
        </Pane>
        <Pane id="integrations" label="Integrations">
        <Section title="Slack" icon={<BrandLogo brand="slack" size="sm" />}>
          <SlackSettings value={s.slack ?? {}} stored={s.secrets_set ?? {}} onChange={(v) => upd((d) => void (d.slack = v))} />
        </Section>
        <Section title="Composio" icon={<BrandLogo brand="composio" size="sm" />}>
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
                  if (!(await save())) throw new Error('could not save the settings');
                  const r = await api<Array<{ toolkit: string }>>('/api/composio/connections');
                  return `connected · ${r.length} connection${r.length === 1 ? '' : 's'}`;
                }}
              />
            </div>
          </Card>
        </Section>
        </Pane>
        <Pane id="guardrails" label="Guard Rails">
        <Section title="Guard Rails">
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
        </Pane>
        <Pane id="defaults" label="Defaults">
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
        </Pane>
        {state.data?.server && (
          <Pane id="server" label="Server Access">
            <ServerAccess />
          </Pane>
        )}
        <Pane id="updates" label="Updates">
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
        </Pane>
        <Pane id="harnesses" label="Harnesses">
          <Harnesses settings={s} upd={upd} desktop={!state.data?.server} />
        </Pane>
        <Pane id="advanced" label="Advanced">
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
                  if (!(await save())) throw new Error('could not save the settings');
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
        </Pane>
        {state.data?.debug && (
          <Pane id="debug" label="Debug">
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
          </Pane>
        )}
      </SettingsPanes>
    </div>
  );
}

/** One page of Settings: its place in the list on the left, and its content. */
function Pane({ children }: { id: string; label: string; icon?: ReactNode; children: ReactNode }) {
  return <>{children}</>;
}

/**
 * Settings as a list of sections on the left (in PANE_ORDER) and the chosen one on the right (#/settings/<id>; the first
 * by default).
 * Save Settings in the header saves every section at once.
 */
const PANE_ORDER = ['models', 'harnesses', 'integrations', 'guardrails', 'defaults', 'server', 'updates', 'appearance', 'advanced', 'debug'];

function SettingsPanes({ active, error, children }: { active?: string; error: string | null; children: ReactNode }) {
  const rank = (id: string) => (PANE_ORDER.includes(id) ? PANE_ORDER.indexOf(id) : PANE_ORDER.length);
  const panes = (Children.toArray(children).filter(isValidElement) as Array<ReactElement<{ id: string; label: string; icon?: ReactNode; children: ReactNode }>>).sort(
    (a, b) => rank(a.props.id) - rank(b.props.id),
  );
  const current = panes.find((p) => p.props.id === active) ?? panes[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav aria-label="Settings sections" className="shrink-0 border-line px-4 pt-4 md:w-52 md:overflow-y-auto md:border-r md:px-3 md:py-6">
        <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {panes.map((p) => (
            <li key={p.props.id}>
              <a
                href={href('settings', p.props.id)}
                aria-current={p === current ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap',
                  p === current ? 'bg-hover font-medium text-ink' : 'text-muted hover:bg-hover/60 hover:text-ink',
                )}
              >
                {p.props.icon}
                {p.props.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="max-w-3xl space-y-8 p-8">
          <ErrorNote>{error}</ErrorNote>
          {current?.props.children}
        </div>
      </div>
    </div>
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

/** Server version: sign out, end every session, and the API token for the CLI and scripts (after the password and code). */
function ServerAccess() {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
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
          To move the authenticator to a new phone, set YAHO_TOTP_RESET=1 there and redeploy, sign in with the password and scan the
          new QR code, then remove YAHO_TOTP_RESET.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void signOut(false)}>Sign Out</Button>
          <Button onClick={() => void signOut(true)}>Sign Out Everywhere</Button>
        </div>
        <Field label="API Token" hint="For the yaho CLI and scripts. Enter the password and a code to show it.">
          {token ? (
            <code className="block rounded-lg bg-code px-3 py-2 text-xs break-all select-all">{token}</code>
          ) : (
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setError(null);
                try {
                  setToken((await api<{ token: string }>('/api/session/token', { body: { password, code } })).token);
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <div className="flex-1">
                <Input type="password" value={password} placeholder="Password" onChange={(e) => setPassword(e.target.value)} />
              </div>
              <div className="w-32">
                <Input inputMode="numeric" autoComplete="one-time-code" value={code} placeholder="Code" onChange={(e) => setCode(e.target.value)} />
              </div>
              <Button type="submit" disabled={!password || !code.trim()}>
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

interface ProviderKind {
  kind: string;
  label: string;
  available: boolean;
  description: string;
}

/**
 * The model providers: each with its key (kept in Dopbase), a test that lists its models, and which one is the default
 * (model names without a provider prefix go there). Add one per kind; LiteLLM also takes its URL and a master key.
 */
function ModelProviders({ settings: s, upd, save }: { settings: Settings; upd: (fn: (d: Settings) => void) => void; save: () => Promise<boolean> }) {
  const kinds = useApi<ProviderKind[]>('/api/providers');
  const [adding, setAdding] = useState('');
  const defaultId = s.default_provider ?? s.providers[0]?.id;
  const label = (kind: string) => kinds.data?.find((k) => k.kind === kind)?.label ?? kind;
  const free = (kinds.data ?? []).filter((k) => k.available && !s.providers.some((p) => p.kind === k.kind));
  const set = (id: string, fn: (p: Settings['providers'][number]) => void) =>
    upd((d) => {
      const p = d.providers.find((x) => x.id === id);
      if (p) fn(p);
    });
  return (
    <Section title="Model Providers">
      <div className="space-y-3">
        {s.providers.map((p) => {
          const stored = (f: string) => s.secrets_set?.[`providers.${p.id}.${f}`];
          return (
            <Card key={p.id} className="space-y-4 p-4">
              <div className="flex items-center gap-3">
                <BrandLogo brand={p.kind} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{label(p.kind)}</div>
                  <div className="text-xs text-muted">
                    {p.id === defaultId ? 'Default: model names without a provider use it' : `Models named ${p.id}/…`}
                  </div>
                </div>
                {p.id !== defaultId && (
                  <Button size="sm" onClick={() => upd((d) => void (d.default_provider = p.id))}>
                    Make Default
                  </Button>
                )}
                {s.providers.length > 1 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    title="Remove"
                    onClick={() =>
                      upd((d) => {
                        d.providers = d.providers.filter((x) => x.id !== p.id);
                        if (d.default_provider === p.id) d.default_provider = d.providers[0]?.id;
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                {p.kind === 'litellm' && (
                  <Field label="Proxy URL" className="md:col-span-2">
                    <Input value={p.url ?? ''} onChange={(e) => set(p.id, (x) => void (x.url = e.target.value))} />
                  </Field>
                )}
                <Field label="API Key" hint={p.kind === 'litellm' ? 'Used by jobs when no master key is set.' : 'Kept in the secrets store; agents never see it.'}>
                  <Input
                    type="password"
                    value={p.api_key ?? ''}
                    placeholder={stored('api_key') ? 'Value set · type to replace' : undefined}
                    onChange={(e) => set(p.id, (x) => void (x.api_key = e.target.value || undefined))}
                  />
                </Field>
                {(p.kind === 'litellm' || p.kind === 'openrouter') && (
                  <Field
                    label={p.kind === 'openrouter' ? 'Management Key (Optional)' : 'Master Key (Optional)'}
                    hint={
                      p.kind === 'openrouter'
                        ? 'From OpenRouter → Settings → Management Keys. Lets Yaho create a key per job with a credit limit, so OpenRouter enforces budgets.'
                        : 'Lets Yaho mint a budget-capped key per job, so LiteLLM enforces budgets.'
                    }
                  >
                    <Input
                      type="password"
                      value={p.master_key ?? ''}
                      placeholder={stored('master_key') ? 'Value set · type to replace' : undefined}
                      onChange={(e) => set(p.id, (x) => void (x.master_key = e.target.value || undefined))}
                    />
                  </Field>
                )}
              </div>
              <Check
                label="Test"
                run={async () => {
                  if (!(await save())) throw new Error('could not save the settings');
                  const r = await api<{ models: string[] }>(`/api/providers/${p.id}/models`);
                  return `${r.models.length} models: ${r.models.slice(0, 4).join(', ')}${r.models.length > 4 ? '…' : ''}`;
                }}
              />
            </Card>
          );
        })}
        {free.length > 0 && (
          <div className="flex items-center gap-2">
            <Select value={adding} onChange={(e) => setAdding(e.target.value)} className="w-56">
              <option value="">Add a provider…</option>
              {free.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </Select>
            <Button
              disabled={!adding}
              onClick={() => {
                upd((d) => void d.providers.push({ id: adding, kind: adding, ...(adding === 'litellm' ? { url: 'http://localhost:4000' } : {}) }));
                setAdding('');
              }}
            >
              <Plus /> Add
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}

const HARNESSES = [
  { id: 'claude-code', label: 'Claude Code', logo: 'claude', about: "Anthropic's agent. Works with every model provider." },
  { id: 'codex', label: 'Codex', logo: 'openai', about: "OpenAI's agent. Needs a provider with OpenAI's Responses API: OpenAI, LiteLLM, Opper or OpenRouter." },
] as const;

/**
 * The harnesses agents run in, as cards like Model Providers: each with its command, a check (installed, recent, a real
 * answer through your provider), and which one new agents use (each agent can still pick its own).
 */
function Harnesses({ settings: s, upd, desktop }: { settings: Settings; upd: (fn: (d: Settings) => void) => void; desktop: boolean }) {
  return (
    <Section title="Harnesses">
      <div className="space-y-3">
        {HARNESSES.map((h) => {
          const cfg = s.harnesses[h.id] ?? { command: h.id === 'codex' ? 'codex' : 'claude' };
          const isDefault = s.defaults.harness === h.id;
          return (
            <Card key={h.id} className="space-y-4 p-4">
              <div className="flex items-center gap-3">
                <BrandLogo brand={h.logo} />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{h.label}</div>
                  <div className="text-xs text-muted">{isDefault ? 'Default for new agents' : h.about}</div>
                </div>
                {!isDefault && (
                  <Button size="sm" onClick={() => upd((d) => void (d.defaults.harness = h.id))}>
                    Make Default
                  </Button>
                )}
              </div>
              <Field label="Command" hint="What Yaho runs for this harness: a name on PATH or a full path.">
                <Input value={cfg.command} onChange={(e) => upd((d) => void (d.harnesses[h.id] = { ...d.harnesses[h.id], command: e.target.value }))} />
              </Field>
              <ClaudeCheckPanel auto={false} harness={h.id} />
              {h.id === 'claude-code' && desktop && (
                <label className="flex items-start gap-3 border-t border-line pt-4 text-sm">
                  <Switch
                    checked={!!cfg.args?.includes('--chrome')}
                    label="Agents Can Use Chrome"
                    onChange={(v) =>
                      upd((d) => {
                        const x = d.harnesses['claude-code']!;
                        const rest = (x.args ?? []).filter((a) => a !== '--chrome');
                        x.args = v ? [...rest, '--chrome'] : rest;
                      })
                    }
                  />
                  <span>
                    Agents Can Use Chrome
                    <span className="block text-xs text-muted">
                      Starts Claude Code with <code>--chrome</code>, so every agent gets the Claude in Chrome browser tools. Needs Chrome open with the
                      Claude extension signed in. Agents act in your real browser, with your logins.
                    </span>
                  </span>
                </label>
              )}
            </Card>
          );
        })}
      </div>
    </Section>
  );
}
