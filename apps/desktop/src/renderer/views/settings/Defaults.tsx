import { Card, Section } from '../../components/ui/display.tsx';
import { Field, Input, Switch, Textarea } from '../../components/ui/form.tsx';
import { ModelPicker } from '../../components/ModelPicker.tsx';
import type { Settings, Upd } from './types.ts';

/** "M H * * *" as "HH:MM"; 03:00 when unset or not a daily time. */
function cronTime(cron: string | undefined): string {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron?.trim() ?? '');
  return m ? `${m[2]!.padStart(2, '0')}:${m[1]!.padStart(2, '0')}` : '03:00';
}

/** Defaults for new agents, dreaming, versions and job history. */
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
      <Section title="Dreaming">
        <Card className="grid gap-4 p-4 md:grid-cols-2">
          <label className="flex items-start gap-3 text-sm md:col-span-2">
            <Switch
              checked={s.dreaming?.enabled !== false}
              label="Dreaming"
              onChange={(v) => upd((d) => void (d.dreaming = { ...d.dreaming, enabled: v }))}
            />
            <span>
              Dreaming
              <span className="block text-xs text-muted">
                Each night every agent reviews its jobs since its last dream and tidies its notes, scripts and database, with a cheap model.
                Its database is backed up first, and each dream can be undone from the job or the agent's Versions. Agents with no new jobs
                skip the night; you can turn dreaming off per agent in its definition.
              </span>
            </span>
          </label>
          <Field label="Time" hint="Every night at this time, on this machine's clock.">
            <Input
              type="time"
              value={cronTime(s.dreaming?.cron)}
              onChange={(e) => {
                const [h, m] = e.target.value.split(':').map(Number);
                if (h !== undefined && m !== undefined) upd((d) => void (d.dreaming = { ...d.dreaming, cron: `${m} ${h} * * *` }));
              }}
            />
          </Field>
          <Field label="Cost Limit per Dream (USD)">
            <Input
              type="number"
              min="0"
              step="0.1"
              value={s.dreaming?.max_usd ?? 0.5}
              onChange={(e) => upd((d) => void (d.dreaming = { ...d.dreaming, max_usd: Number(e.target.value) }))}
            />
          </Field>
        </Card>
      </Section>
      <Section title="Versions">
        <Card className="grid gap-4 p-4 md:grid-cols-2">
          <label className="flex items-start gap-3 text-sm md:col-span-2">
            <Switch
              checked={s.versions?.enabled !== false}
              label="Versions"
              onChange={(v) => upd((d) => void (d.versions = { ...d.versions, enabled: v }))}
            />
            <span>
              Versions
              <span className="block text-xs text-muted">
                Yaho keeps each agent's workspace and definition under git and saves a version after every job, so you can see what a job
                changed and undo it. Needs git on this machine.
              </span>
            </span>
          </label>
          <Field label="Keep History (Days)" hint="Older versions are squashed into one.">
            <Input
              type="number"
              min="1"
              value={s.versions?.keep_days ?? 90}
              onChange={(e) => upd((d) => void (d.versions = { ...d.versions, keep_days: Number(e.target.value) }))}
            />
          </Field>
          <Field label="Largest File (MB)" hint="Bigger files are left out of versions.">
            <Input
              type="number"
              min="0"
              value={s.versions?.max_file_mb ?? 5}
              onChange={(e) => upd((d) => void (d.versions = { ...d.versions, max_file_mb: Number(e.target.value) }))}
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
