import { CheckCircle2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import YAML from 'yaml';
import { Button } from '../components/ui/button.tsx';
import { Card, ErrorNote, PageHeader, Section } from '../components/ui/display.tsx';
import { Field, Input, Textarea } from '../components/ui/form.tsx';
import { ModelPicker } from '../components/ModelPicker.tsx';
import { api, useApi } from '../lib/api.ts';
import { platform } from '../lib/platform.ts';
import { href } from '../lib/router.ts';

interface Settings {
  server: { host: string; port: number };
  harnesses: Record<string, { command: string; args?: string[] }>;
  litellm: { url: string; api_key?: string; master_key?: string };
  dopbase: { mode: 'bundled' | 'external'; url: string; token?: string; local_port?: number; environment: string; project_prefix: string };
  global_spend_cap_usd: number;
  composio?: { api_key?: string; user_id?: string };
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
  const saved = useApi<Settings>('/api/settings', (e) => e.type === 'changed' && e.entity === 'settings');
  const [s, setS] = useState<Settings | null>(null);
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [yaml, setYaml] = useState('');
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

  const save = async () => {
    setError(null);
    setOk(false);
    try {
      await api('/api/settings', { method: 'PUT', body: mode === 'yaml' ? { yaml } : s });
      setOk(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title="Settings"
        sub="Stored as settings.yaml in the data directory."
        actions={
          <Button
            onClick={() => {
              if (mode === 'form') setYaml(YAML.stringify(s));
              else {
                try {
                  setS(YAML.parse(yaml));
                } catch (e) {
                  setError((e as Error).message);
                  return;
                }
              }
              setMode(mode === 'form' ? 'yaml' : 'form');
            }}
          >
            {mode === 'form' ? 'Edit as YAML' : 'Back to Form'}
          </Button>
        }
      />
      <div className="max-w-3xl space-y-8 p-8">
        <ErrorNote>{error}</ErrorNote>
        {mode === 'yaml' ? (
          <Textarea
            className="min-h-[520px] font-mono text-[12.5px]"
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            spellCheck={false}
          />
        ) : (
          <>
            <Section title="Models (LiteLLM)">
              <Card className="grid gap-4 p-4 md:grid-cols-2">
                <Field label="Proxy URL" className="md:col-span-2">
                  <Input value={s.litellm.url} onChange={(e) => upd((d) => void (d.litellm.url = e.target.value))} />
                </Field>
                <Field label="API key" hint="Used by jobs when no master key is set.">
                  <Input
                    type="password"
                    value={s.litellm.api_key ?? ''}
                    onChange={(e) => upd((d) => void (d.litellm.api_key = e.target.value || undefined))}
                  />
                </Field>
                <Field label="Master key (optional)" hint="Lets Yaho mint a budget-capped key per job, so LiteLLM enforces budgets.">
                  <Input
                    type="password"
                    value={s.litellm.master_key ?? ''}
                    onChange={(e) => upd((d) => void (d.litellm.master_key = e.target.value || undefined))}
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
                <Field label="Where values live" className="md:col-span-2">
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
                  <Field label="Local port" hint="Yaho runs its own Dopbase on 127.0.0.1, with its data in the Yaho data directory.">
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
                <Field label="Project prefix" hint="Each resource is the Dopbase project <prefix><resource>.">
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
            <Section title="Apps (Composio)">
              <Card className="grid gap-4 p-4 md:grid-cols-2">
                <ComposioKeyHelp />
                <Field label="Composio API key" hint="Agents never see it: Yaho makes their calls.">
                  <Input
                    type="password"
                    value={s.composio?.api_key ?? ''}
                    onChange={(e) => upd((d) => void (d.composio = { ...d.composio, api_key: e.target.value || undefined }))}
                  />
                </Field>
                <Field label="User id" hint="Whose connections Yaho uses in your Composio project.">
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
                <Field label="Global spend cap (USD)" hint="When total spend reaches it, no job starts and running jobs stop.">
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
                <Field label="Max parallel jobs">
                  <Input
                    type="number"
                    min="1"
                    value={s.defaults.max_parallel}
                    onChange={(e) => upd((d) => void (d.defaults.max_parallel = Number(e.target.value)))}
                  />
                </Field>
              </Card>
            </Section>
            <Section title="Harnesses">
              <Card className="space-y-3 p-4">
                {Object.entries(s.harnesses).map(([name, h]) => (
                  <Field key={name} label={name} hint="The command Yaho runs for this harness.">
                    <Input value={h.command} onChange={(e) => upd((d) => void (d.harnesses[name]!.command = e.target.value))} />
                  </Field>
                ))}
              </Card>
            </Section>
          </>
        )}
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={() => void save()}>
            Save Settings
          </Button>
          {ok && <span className="text-sm text-ok">Saved</span>}
        </div>
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
