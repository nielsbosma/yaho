import { Check as CheckIcon, CheckCircle2, Monitor, Moon, Plus, Sun, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState, Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Button } from '../components/ui/button.tsx';
import { Card, ErrorNote, PageHeader, Section } from '../components/ui/display.tsx';
import { Field, Input, Select, Switch, Textarea } from '../components/ui/form.tsx';
import { ModelPicker } from '../components/ModelPicker.tsx';
import type { AppState } from '../App.tsx';
import { ClaudeCheckPanel } from './onboarding.tsx';
import { Integrations } from './integrations.tsx';
import { BrandLogo } from '../components/BrandLogo.tsx';
import { CommandRulesEditor, type CommandRule } from '../components/CommandRulesEditor.tsx';
import { api, useApi } from '../lib/api.ts';
import { href } from '../lib/router.ts';
import { PALETTES, usePalette, useTheme, type Theme } from '../lib/theme.ts';
import { cn } from '../components/ui/cn.ts';

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

export function Check({ label, run }: { label: string; run: () => Promise<string> }) {
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
          <Integrations route={route.slice(2)} settings={s} upd={upd} save={save} server={!!state.data?.server} />
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
            <SandboxMode value={s.sandbox} onChange={(v) => upd((d) => void (d.sandbox = v))} />
          </Card>
        </Section>
        <CommandRules value={s.command_rules} onChange={(v) => upd((d) => void (d.command_rules = v))} />
        </Pane>
        <Pane id="defaults" label="Defaults">
        <Section title="Defaults for New Agents">
              <Field
                label="Browser: Allowed Sites"
                className="md:col-span-2"
                hint="One site per line (example.com also allows its subdomains). Agents' browsers can only open pages on these. Empty: any site."
              >
                <Textarea
                  rows={3}
                  value={(s.browser?.allowed_sites ?? []).join('\n')}
                  placeholder={'example.com\ndocs.acme.dev'}
                  onChange={(e) =>
                    upd(
                      (d) =>
                        void (d.browser = { ...d.browser, allowed_sites: e.target.value.trim() ? e.target.value.split('\n') : undefined }),
                    )
                  }
                />
              </Field>
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
        <Section title="Job History">
          <Card className="p-4">
            <label className="flex items-start gap-3 text-sm">
              <Switch
                checked={s.history?.recaps !== false}
                label="Job Recaps"
                onChange={(v) => upd((d) => void (d.history = { ...d.history, recaps: v }))}
              />
              <span>
                Job Recaps
                <span className="block text-xs text-muted">
                  When a job ends, the agent's last model writes a short recap of it, so the agent can find the job later with yaho history search. Each
                  recap is a small model call, charged to the job.
                </span>
              </span>
            </label>
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

/**
 * Run harnesses in their sandbox: shell commands and file edits may only write in the agent's workspace (and the temp
 * folder). Unset follows the version: on in the server version, off on the desktop.
 */
function SandboxMode({ value, onChange }: { value: boolean | undefined; onChange: (v: boolean) => void }) {
  const info = useApi<{ default: boolean; problems: Record<string, string | null> }>('/api/sandbox', (e) => e.type === 'changed' && e.entity === 'settings');
  const on = value ?? info.data?.default ?? false;
  const problems = Object.entries(info.data?.problems ?? {}).filter(([, p]) => p) as Array<[string, string]>;
  return (
    <div className="space-y-2 md:col-span-2">
      <label className="flex items-start gap-3 text-sm">
        <Switch checked={on} label="Sandbox Mode" onChange={onChange} />
        <span>
          Sandbox Mode
          <span className="block text-xs text-muted">
            Agents' commands and file edits may only change their own workspace; the rest of the computer is read-only to them. The network stays
            open. {info.data?.default ? 'On by default in the server version.' : 'Off by default on the desktop.'}
          </span>
        </span>
      </label>
      {on &&
        problems.map(([h, p]) => (
          <p key={h} className="text-xs text-warn">
            {p}: jobs on {h} fail while Sandbox Mode is on.
          </p>
        ))}
    </div>
  );
}

/**
 * Command Rules: shell commands checked before they run. Off unless turned on; the rules start as the default list
 * (an unset list means the defaults, so they follow Yaho's until edited).
 */
function CommandRules({
  value,
  onChange,
}: {
  value: { enabled?: boolean; rules?: CommandRule[] } | undefined;
  onChange: (v: { enabled?: boolean; rules?: CommandRule[] }) => void;
}) {
  const defaults = useApi<CommandRule[]>('/api/command-rules/defaults');
  const on = !!value?.enabled;
  const rules = value?.rules ?? defaults.data ?? [];
  return (
    <Section title="Command Rules">
      <Card className="space-y-4 p-4">
        <label className="flex items-start gap-3 text-sm">
          <Switch checked={on} label="Command Rules" onChange={(v) => onChange({ ...value, enabled: v })} />
          <span>
            Check Agents' Commands
            <span className="block text-xs text-muted">
              Every shell command an agent runs is checked against these rules first. Block refuses it. Ask pauses the job and asks you in the inbox
              (Allow once, Always allow or Deny); the job resumes with your answer. Allow lets a command through that an Ask rule would hold. Block
              always wins. Patterns use * as a wildcard and match the whole command; write /…/ for a regular expression.
            </span>
          </span>
        </label>
        {on && (
          <>
            <CommandRulesEditor rules={rules} onChange={(r) => onChange({ ...value, rules: r })} />
            {value?.rules && (
              <Button size="sm" variant="link" onClick={() => onChange({ ...value, rules: undefined })}>
                Reset to Defaults
              </Button>
            )}
          </>
        )}
      </Card>
    </Section>
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

/** Server version: sign out, end every session, and the API token for the CLI and scripts (after the password and code). */
function ServerAccess() {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [totp, setTotp] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetch('/api/session')
      .then((r) => r.json())
      .then((s: { totp?: boolean }) => setTotp(!!s.totp))
      .catch((e) => setError(`Could not read the session: ${(e as Error).message}`));
  }, []);
  const signOut = async (everywhere: boolean) => {
    setError(null);
    try {
      if (everywhere) await api('/api/session/revoke-all', { method: 'POST' });
      await fetch('/api/session', { method: 'DELETE' });
      location.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Section title="Server Access">
      <Card className="space-y-4 p-4">
        <p className="text-sm text-muted">
          The password is YAHO_PASSWORD in this server's deploy settings. Change it there and redeploy; that also signs everyone out.
          {totp
            ? ' To move the authenticator to a new phone, set YAHO_TOTP_RESET=1 there and redeploy, sign in with the password and scan the new QR code, then remove YAHO_TOTP_RESET.'
            : ' To also ask for a code from an authenticator app, set YAHO_TOTP=1 there and redeploy.'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void signOut(false)}>Sign Out</Button>
          <Button onClick={() => void signOut(true)}>Sign Out Everywhere</Button>
        </div>
        <Field label="API Token" hint={`For the yaho CLI and scripts. Enter the password${totp ? ' and a code' : ''} to show it.`}>
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
              {totp && (
                <div className="w-32">
                  <Input inputMode="numeric" autoComplete="one-time-code" value={code} placeholder="Code" onChange={(e) => setCode(e.target.value)} />
                </div>
              )}
              <Button type="submit" disabled={!password || (totp && !code.trim())}>
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
