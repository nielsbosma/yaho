import { SchedulePicker } from '../../components/SchedulePicker.tsx';
import { useEffect, useState } from 'react';
import YAML from 'yaml';
import { Button } from '../../components/ui/button.tsx';
import { cn } from '../../components/ui/cn.ts';
import { Card, ErrorNote, PageHeader, Section } from '../../components/ui/display.tsx';
import { Field, Input, Select, Switch, Textarea } from '../../components/ui/form.tsx';
import { api, useApi, type Agent, type Project, type Resource, type WebhookTrigger } from '../../lib/api.ts';
import type { AppState } from '../../App.tsx';
import { go, href } from '../../lib/router.ts';
import { ModelPicker } from '../../components/ModelPicker.tsx';
import { MultiPicker } from '../../components/MultiPicker.tsx';
import { WebhookTriggers } from '../../components/WebhookTriggers.tsx';
import { AgentGuardrails } from './AgentGuardrails.tsx';
import { DeleteAgent } from './DeleteAgent.tsx';
import { Examples } from './Examples.tsx';

const blank = (): Agent => ({
  name: '',
  enabled: true,
  briefing: '',
  harness: 'claude-code',
  models: [],
  budget_usd: 10,
  max_parallel: 1,
  guardrails: {},
  triggers: [{ inbox: true }],
  projects: [],
  resources: [],
});

const definitionOf = (a: Agent) => ({
  name: a.name,
  enabled: a.enabled,
  briefing: a.briefing,
  harness: a.harness,
  models: a.models,
  budget_usd: a.budget_usd,
  ...(a.budget_reset ? { budget_reset: a.budget_reset } : {}),
  max_parallel: a.max_parallel,
  triggers: a.triggers,
  projects: a.projects,
  resources: a.resources,
  guardrails: a.guardrails,
  ...(a.email ? { email: true } : {}),
  ...(a.sms ? { sms: true } : {}),
  ...(a.browser ? { browser: true } : {}),
});

export function AgentEditor({ existing }: { existing?: Agent }) {
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [draft, setDraft] = useState<Agent>(existing ? { ...existing } : blank());
  // A new agent starts on the default harness from Settings (Harnesses → Make Default).
  useEffect(() => {
    if (existing) return;
    void api<{ defaults: { harness?: string } }>('/api/settings').then((st) => {
      if (st.defaults.harness) setDraft((d) => ({ ...d, harness: st.defaults.harness! }));
    });
  }, [existing]);
  const [yaml, setYaml] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const projects = useApi<Project[]>('/api/projects');
  const resources = useApi<Resource[]>('/api/resources');
  const email = useApi<{ configured: boolean; domain?: string }>('/api/resend');
  const sms = useApi<{ configured: boolean; number?: string }>('/api/twilio');
  const state = useApi<AppState>('/api/state');
  const browser = useApi<{ ready: boolean; detail: string }>('/api/browser');
  const [forgot, setForgot] = useState(false);
  useEffect(() => {
    if (existing) setDraft({ ...existing });
  }, [existing]);

  const switchMode = (m: 'form' | 'yaml') => {
    setError(null);
    if (m === 'yaml') setYaml(YAML.stringify(definitionOf(draft)));
    else {
      try {
        setDraft({ ...blank(), ...YAML.parse(yaml) });
      } catch (e) {
        setError(`YAML: ${(e as Error).message}`);
        return;
      }
    }
    setMode(m);
  };

  const save = async () => {
    setError(null);
    setSaving(true);
    try {
      const body = mode === 'yaml' ? { yaml } : definitionOf(draft);
      const saved = existing
        ? await api<Agent>(`/api/agents/${existing.name}`, { method: 'PUT', body })
        : await api<Agent>('/api/agents', { method: 'POST', body });
      go('agents', saved.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof Agent>(k: K, v: Agent[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const crons = draft.triggers.filter((t): t is { cron: string } => 'cron' in t).map((t) => t.cron);
  const inbox = draft.triggers.some((t) => 'inbox' in t && t.inbox);
  const hooks = draft.triggers.filter((t): t is WebhookTrigger => 'webhook' in t);
  // The inbox trigger is always written, off too: a new agent without one gets it switched on.
  const setTriggers = (c: string[], i: boolean, h = hooks) => set('triggers', [...c.map((cron) => ({ cron })), { inbox: i }, ...h]);

  const body = (
    <div className="max-w-3xl space-y-5">
      <div className="flex gap-1 rounded-lg bg-hover p-0.5 text-sm w-fit">
        {(['form', 'yaml'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => mode !== m && switchMode(m)}
            className={cn('cursor-pointer rounded-md px-3 py-1', mode === m ? 'bg-panel shadow-sm' : 'text-muted')}
          >
            {m === 'form' ? 'Form' : 'YAML'}
          </button>
        ))}
      </div>
      <ErrorNote>{error}</ErrorNote>
      {mode === 'yaml' ? (
        <Textarea
          className="min-h-[480px] font-mono text-[12.5px]"
          value={yaml}
          onChange={(e) => setYaml(e.target.value)}
          spellCheck={false}
        />
      ) : (
        <div className="space-y-8">
          <Section title="Basics">
            <Card className="space-y-4 p-4">
              <Field label="Name" hint="Lowercase letters, digits and dashes.">
                <Input
                  className="md:max-w-sm"
                  value={draft.name}
                  onChange={(e) => set('name', e.target.value)}
                  placeholder="social-scout"
                />
              </Field>
              <Field label="Briefing" hint="What this agent is for, its loop, and its limits. It reads this at the start of every job.">
                <Textarea
                  className="min-h-48"
                  value={draft.briefing}
                  onChange={(e) => set('briefing', e.target.value)}
                  placeholder="What this agent is for, its loop, and its limits."
                />
              </Field>
            </Card>
          </Section>

          <Section title="Models and Budget">
            <Card className="space-y-4 p-4">
              <Field
                label="Harness"
                hint={
                  draft.harness === 'codex'
                    ? "OpenAI's Codex. Needs a model on a provider with OpenAI's Responses API: OpenAI, LiteLLM, Opper or OpenRouter."
                    : "Anthropic's Claude Code. Works with every model provider."
                }
              >
                <Select value={draft.harness} onChange={(e) => set('harness', e.target.value)} className="md:w-64">
                  <option value="claude-code">Claude Code</option>
                  <option value="codex">Codex</option>
                </Select>
              </Field>
              {/* Codex is built for OpenAI's models: Claude through a proxy's Responses route refuses its requests. */}
              {draft.harness === 'codex' && draft.models.some((m) => /claude|anthropic/i.test(m)) && (
                <div role="alert" className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
                  Codex works best with OpenAI's GPT models. With a Claude model ({draft.models.find((m) => /claude|anthropic/i.test(m))})
                  its jobs are likely to fail; pick a GPT model, or use Claude Code for Claude models.
                </div>
              )}
              <Field label="Allowed Models" hint="From your model providers. Jobs run with the primary." group>
                <ModelPicker value={draft.models} onChange={(v) => set('models', v)} />
              </Field>
              <div className="grid gap-4 md:grid-cols-3">
                <Field label="Budget (USD)" hint="What the agent may spend on itself in each period.">
                  <Input
                    type="number"
                    min="0"
                    step="0.5"
                    value={draft.budget_usd}
                    onChange={(e) => set('budget_usd', Number(e.target.value))}
                  />
                </Field>
                <Field label="Budget Resets" hint="Daily at midnight, or on the 1st of each month.">
                  <Select
                    value={draft.budget_reset ?? 'never'}
                    onChange={(e) =>
                      set('budget_reset', e.target.value === 'never' ? undefined : (e.target.value as Agent['budget_reset']))
                    }
                  >
                    <option value="never">Never</option>
                    <option value="daily">Daily</option>
                    <option value="monthly">Monthly</option>
                  </Select>
                </Field>
                <Field label="Max Parallel Jobs" hint="How many of its jobs may run at once.">
                  <Input type="number" min="1" value={draft.max_parallel} onChange={(e) => set('max_parallel', Number(e.target.value))} />
                </Field>
              </div>
            </Card>
          </Section>

          <Section title="When It Runs">
            <Card className="space-y-4 p-4">
              <Field label="Schedule" group>
                <SchedulePicker value={crons} onChange={(v) => setTriggers(v, inbox)} />
              </Field>
              <div className="grid gap-4 border-t border-line pt-4 md:grid-cols-2">
                <Field label="Inbox Trigger" hint="A new message starts a job.">
                  <div className="flex h-9 items-center">
                    <Switch checked={inbox} onChange={(v) => setTriggers(crons, v)} label="Inbox Trigger" />
                  </div>
                </Field>
                <Field
                  label="Dreaming"
                  hint="Each night it reviews its recent jobs and tidies its notes, scripts and database. You can see and undo each dream under Versions."
                >
                  <div className="flex h-9 items-center">
                    <Switch checked={draft.dreaming !== false} onChange={(v) => set('dreaming', v)} label="Dreaming" />
                  </div>
                </Field>
                <Field label="Wait for Me" hint="Skip scheduled runs while your inbox has unread messages from this agent.">
                  <div className="flex h-9 items-center">
                    <Switch
                      checked={!!draft.guardrails.wait_for_inbox}
                      onChange={(v) => set('guardrails', { ...draft.guardrails, wait_for_inbox: v || undefined })}
                      label="Wait for Me"
                    />
                  </div>
                </Field>
              </div>
              <div className="border-t border-line pt-4">
                <Field
                  label="Webhooks"
                  hint="Any service can start a job by posting to the webhook's URL. Renaming a webhook gives it a new URL."
                  group
                >
                  <WebhookTriggers
                    agent={existing?.name ?? null}
                    value={hooks}
                    onChange={(h) => setTriggers(crons, inbox, h)}
                    server={!!state.data?.server}
                  />
                </Field>
              </div>
            </Card>
          </Section>

          <Section title="Access">
            <Card className="grid gap-4 p-4 md:grid-cols-2">
              <Field label="Projects" hint="Their briefings and files are in every job's context." group>
                <MultiPicker
                  noun="Project"
                  emptyText="No projects"
                  options={projects.data?.map((p) => ({ value: p.name, label: p.title, hint: p.briefing.split('\n')[0] })) ?? []}
                  value={draft.projects}
                  onChange={(v) => set('projects', v)}
                />
              </Field>
              <Field label="Resources" hint="Keys and connected apps the agent may use." group>
                <MultiPicker
                  noun="Resource"
                  emptyText="No resources"
                  options={resources.data?.map((r) => ({ value: r.name, hint: r.briefing.split('\n')[0] })) ?? []}
                  value={draft.resources}
                  onChange={(v) => set('resources', v)}
                />
              </Field>
              <Field
                label="Email"
                hint={
                  email.data?.configured
                    ? `Its own address, ${draft.name || '<name>'}@${email.data.domain}, to email people and get their replies in its inbox.`
                    : 'Its own email address to email people and get their replies. Set up Email in Settings → Integrations first.'
                }
              >
                <div className="flex h-9 items-center">
                  <Switch checked={!!draft.email} onChange={(v) => set('email', v || undefined)} label="Email" />
                </div>
              </Field>
              <Field
                label="SMS"
                hint={
                  sms.data?.configured
                    ? `Text people from ${sms.data.number} and get their replies in its inbox.`
                    : 'Text people and get their replies. Set up SMS in Settings → Integrations first.'
                }
              >
                <div className="flex h-9 items-center">
                  <Switch checked={!!draft.sms} onChange={(v) => set('sms', v || undefined)} label="SMS" />
                </div>
              </Field>
              <Field
                label="Browser"
                hint={
                  browser.data?.ready
                    ? 'A real browser in each job to open pages, sign in, click and fill in forms. Sign-ins stay between jobs.'
                    : 'A real browser in each job. Set up Browser in Settings → Integrations first.'
                }
              >
                <div className="flex h-9 items-center gap-3">
                  <Switch checked={!!draft.browser} onChange={(v) => set('browser', v || undefined)} label="Browser" />
                  {existing?.browser && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={forgot}
                      onClick={async () => {
                        await api(`/api/agents/${encodeURIComponent(existing.name)}/browser`, { method: 'DELETE' });
                        setForgot(true);
                      }}
                    >
                      {forgot ? 'Sign-ins Forgotten' : 'Forget Sign-ins'}
                    </Button>
                  )}
                </div>
              </Field>
            </Card>
          </Section>

          <AgentGuardrails draft={draft} set={set} />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={saving}>
          {existing ? 'Save' : 'Create Agent'}
        </Button>
        {existing && <DeleteAgent name={existing.name} />}
      </div>
    </div>
  );

  if (existing) return body;
  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Agents', to: href('agents') }]}
        title="New Agent"
        sub="Fill in the form, switch to YAML and paste a definition, or start from an example."
      />
      <div className="space-y-8 p-8">
        <Examples />
        {body}
      </div>
    </>
  );
}
