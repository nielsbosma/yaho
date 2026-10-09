import { CheckCircle2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import YAML from 'yaml';
import { Button } from '../components/ui/button.tsx';
import { Card, ErrorNote, PageHeader, Section } from '../components/ui/display.tsx';
import { Field, Input, ListInput, Textarea } from '../components/ui/form.tsx';
import { api, useApi } from '../lib/api.ts';
import type { ViewProps } from './index.tsx';

interface Settings {
  server: { host: string; port: number };
  harnesses: Record<string, { command: string; args?: string[] }>;
  litellm: { url: string; api_key?: string; master_key?: string };
  dopbase: { mode: 'bundled' | 'external'; url: string; token?: string; local_port?: number; environment: string; project_prefix: string };
  global_spend_cap_usd: number;
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

export function SettingsView(_: ViewProps) {
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
            {mode === 'form' ? 'Edit as YAML' : 'Back to form'}
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
                <Field label="Master key (optional)" hint="Lets YAHO mint a budget-capped key per job, so LiteLLM enforces budgets.">
                  <Input
                    type="password"
                    value={s.litellm.master_key ?? ''}
                    onChange={(e) => upd((d) => void (d.litellm.master_key = e.target.value || undefined))}
                  />
                </Field>
                <div className="md:col-span-2">
                  <Check
                    label="List models"
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
                        {m === 'bundled' ? 'Bundled (local)' : 'External server'}
                      </button>
                    ))}
                  </div>
                </Field>
                {s.dopbase.mode === 'bundled' ? (
                  <Field label="Local port" hint="YAHO runs its own Dopbase on 127.0.0.1, with its data in the YAHO data directory.">
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
                    label="Test connection"
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
            <Section title="Defaults for new agents">
              <Card className="grid gap-4 p-4 md:grid-cols-2">
                <Field label="Models">
                  <ListInput value={s.defaults.models} onChange={(v) => upd((d) => void (d.defaults.models = v))} />
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
                  <Field key={name} label={name} hint="The command YAHO runs for this harness.">
                    <Input value={h.command} onChange={(e) => upd((d) => void (d.harnesses[name]!.command = e.target.value))} />
                  </Field>
                ))}
              </Card>
            </Section>
          </>
        )}
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={() => void save()}>
            Save settings
          </Button>
          {ok && <span className="text-sm text-ok">Saved</span>}
        </div>
      </div>
    </>
  );
}
