import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { BrandLogo } from '../../components/BrandLogo.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Card, Section } from '../../components/ui/display.tsx';
import { Field, Input, Select } from '../../components/ui/form.tsx';
import { api, useApi } from '../../lib/api.ts';
import { Check } from './Check.tsx';
import type { Settings } from './types.ts';

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
export function ModelProviders({
  settings: s,
  upd,
  save,
}: {
  settings: Settings;
  upd: (fn: (d: Settings) => void) => void;
  save: () => Promise<boolean>;
}) {
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
                <Field
                  label="API Key"
                  hint={
                    p.kind === 'litellm' ? 'Used by jobs when no master key is set.' : 'Kept in the secrets store; agents never see it.'
                  }
                >
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
                upd(
                  (d) =>
                    void d.providers.push({ id: adding, kind: adding, ...(adding === 'litellm' ? { url: 'http://localhost:4000' } : {}) }),
                );
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
