import { Card, Section } from '../../components/ui/display.tsx';
import { Field, Input, Switch, Textarea } from '../../components/ui/form.tsx';
import { ModelPicker } from '../../components/ModelPicker.tsx';
import type { Settings, Upd } from './types.ts';

/** Defaults for new agents, and job history. */
export function Defaults({ settings: s, upd }: { settings: Settings; upd: Upd }) {
  return (
    <>
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
              upd((d) => void (d.browser = { ...d.browser, allowed_sites: e.target.value.trim() ? e.target.value.split('\n') : undefined }))
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
                When a job ends, the agent's last model writes a short recap of it, so the agent can find the job later with yaho history
                search. Each recap is a small model call, charged to the job.
              </span>
            </span>
          </label>
        </Card>
      </Section>
    </>
  );
}
