import { Card, Section } from '../../components/ui/display.tsx';
import { Field, Input } from '../../components/ui/form.tsx';
import { api } from '../../lib/api.ts';
import { Check } from './Check.tsx';
import type { Settings, Upd } from './types.ts';

/** Where secret values live: the bundled Dopbase or an external server. */
export function Advanced({ settings: s, upd, save }: { settings: Settings; upd: Upd; save: () => Promise<boolean> }) {
  return (
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
  );
}
