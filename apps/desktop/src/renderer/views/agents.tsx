import { describeCron, SchedulePicker } from '../components/SchedulePicker.tsx';
import { WorkspaceBrowser } from '../components/WorkspaceBrowser.tsx';
import { Markdown } from '../components/Markdown.tsx';
import { useContextMenu, type MenuItem } from '../components/ContextMenu.tsx';
import { RunDialog, useAgentMenu } from '../components/AgentMenu.tsx';
import { DataTable, LayoutSwitch, useLayout } from '../components/ListLayout.tsx';
import { Bot, ExternalLink, History, LibraryBig, Play, Plus, Sparkles, Trash2, Wallet } from 'lucide-react';
import { chatAboutAgent } from '../lib/chat.ts';
import { useEffect, useState } from 'react';
import YAML from 'yaml';
import { Button } from '../components/ui/button.tsx';
import { cn } from '../components/ui/cn.ts';
import { Dialog } from '../components/ui/dialog.tsx';
import { ago, Badge, Card, Empty, ErrorNote, money, PageHeader, Section, StatusBadge, Tabs } from '../components/ui/display.tsx';
import { Field, Input, Switch, Textarea } from '../components/ui/form.tsx';
import { api, useApi, type Agent, type Artifact, type Job, type Project, type Resource, type TriggerSpec } from '../lib/api.ts';
import { go, href } from '../lib/router.ts';
import type { ViewProps } from './index.tsx';
import { ModelPicker } from '../components/ModelPicker.tsx';
import { MultiPicker } from '../components/MultiPicker.tsx';
import { ArtifactGrid } from './artifacts.tsx';
import { JobList } from './jobs.tsx';

const agentChanged = (name?: string) => (e: { type: string; entity?: string; name?: string; job?: unknown }) =>
  (e.type === 'changed' && e.entity === 'agents' && (!name || e.name === name)) || e.type === 'job';

export function AgentsView({ route }: ViewProps) {
  if (route[1] === 'new') return <AgentEditor />;
  if (route[1]) return <AgentDetail name={route[1]} tab={route[2] ?? 'overview'} />;
  return <AgentList />;
}

function AgentList() {
  const agents = useApi<Agent[]>('/api/agents', agentChanged());
  const menu = useAgentMenu();
  const rowMenu = (a: Agent): MenuItem[] => [{ label: 'Open', icon: <ExternalLink />, onSelect: () => go('agents', a.name) }, ...menu.items(a)];
  const cardMenu = useContextMenu();
  const [layout, setLayout] = useLayout('agents');
  return (
    <>
      <PageHeader
        title="Agents"
        sub="Long-lived agents that run on triggers, within a budget."
        actions={
          <>
            <LayoutSwitch value={layout} onChange={setLayout} />
            <Button variant="primary" onClick={() => go('agents', 'new')}>
              <Plus /> New Agent
            </Button>
          </>
        }
      />
      {layout === 'table' && !!agents.data?.length && (
        <div className="p-8">
          <DataTable
            rows={agents.data}
            menu={rowMenu}
            rowKey={(a) => a.name}
            to={(a) => ['agents', a.name]}
            columns={[
              {
                label: 'Agent',
                cell: (a) => (
                  <span className="flex items-center gap-2 font-medium">
                    <Bot className={cn('size-4', a.running ? 'text-info' : 'text-muted')} />
                    {a.name}
                    {!a.enabled && <Badge>disabled</Badge>}
                  </span>
                ),
              },
              {
                label: 'Status',
                cell: (a) =>
                  a.running ? (
                    <StatusBadge status="running" />
                  ) : a.queued ? (
                    <StatusBadge status="queued" />
                  ) : (
                    <span className="text-muted">idle</span>
                  ),
              },
              {
                label: 'Triggers',
                cell: (a) => <span className="text-muted">{a.triggers.map(triggerLabel).join(' · ') || 'manual only'}</span>,
              },
              { label: 'Models', cell: (a) => <code className="text-xs">{a.models[0] ?? 'default'}</code> },
              { label: 'Unread', cell: (a) => (a.unread ? <Badge tone="accent">{a.unread}</Badge> : null), className: 'text-right' },
              {
                label: 'Spend',
                cell: (a) => (
                  <span className="tabular-nums">
                    {money(a.spent_usd)} / {money(a.budget_usd)}
                  </span>
                ),
                className: 'text-right',
              },
            ]}
          />
        </div>
      )}
      {menu.element}
      {cardMenu.element}
      <div className={cn('grid gap-3 p-8 md:grid-cols-2', layout === 'table' && 'hidden')}>
        {agents.data?.map((a) => (
          <a key={a.name} href={href('agents', a.name)} onContextMenu={(e) => cardMenu.open(e, rowMenu(a))}>
            <Card className="p-4 transition-colors hover:border-line-strong">
              <div className="flex items-center gap-2">
                <Bot className={cn('size-4', a.running ? 'text-info' : 'text-muted')} />
                <span className="font-medium">{a.name}</span>
                {!a.enabled && <Badge>disabled</Badge>}
                {a.running ? <StatusBadge status="running" /> : null}
                {a.unread ? <Badge tone="accent">{a.unread} unread</Badge> : null}
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-muted">{a.briefing || 'No briefing yet.'}</p>
              <div className="mt-3 flex gap-4 text-xs text-muted">
                <span>
                  {money(a.spent_usd)} / {money(a.budget_usd)}
                </span>
                <span>{a.triggers.map(triggerLabel).join(' · ') || 'manual only'}</span>
              </div>
            </Card>
          </a>
        ))}
      </div>
      {agents.data?.length === 0 && (
        <Empty icon={<Bot />} title="No agents yet">
          Create one, or paste an agent definition in YAML.
        </Empty>
      )}
    </>
  );
}

export const triggerLabel = (t: TriggerSpec) => ('cron' in t ? describeCron(t.cron) : 'on inbox messages');

function AgentDetail({ name, tab }: { name: string; tab: string }) {
  const agent = useApi<Agent>(`/api/agents/${encodeURIComponent(name)}`, agentChanged(name));
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const a = agent.data;
  if (agent.error) return <Empty title="Agent not found">{agent.error}</Empty>;
  if (!a) return null;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      {/* Header and tabs stay put while the content scrolls. */}
      <div className="sticky top-0 z-20 bg-bg">
        <PageHeader
          crumbs={[{ label: 'Agents', to: href('agents') }]}
          title={
            <span className="flex items-center gap-3">
              {a.name}
              {!a.enabled && <Badge>disabled</Badge>}
            </span>
          }
          sub={`${a.harness} · ${a.models.join(', ') || 'no models'} · ${a.triggers.map(triggerLabel).join(' · ') || 'manual only'}`}
          actions={
            <>
              <label className="mr-2 flex items-center gap-2 text-sm text-muted">
                Enabled
                <Switch
                  checked={a.enabled}
                  label="Enabled"
                  onChange={(v) => void act(() => api(`/api/agents/${a.name}`, { method: 'PATCH', body: { enabled: v } }))}
                />
              </label>
              <Button onClick={() => chatAboutAgent(a.name)} title="Ask about this agent, or have Yaho change it">
                <Sparkles /> Chat About Agent
              </Button>
              <Button variant="primary" disabled={!a.enabled} onClick={() => setRunning(true)}>
                <Play /> Run Now
              </Button>
            </>
          }
        />
        <Tabs
          value={tab}
          onChange={(t) => go('agents', a.name, t)}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'edit', label: 'Definition' },
            { id: 'briefings', label: 'Briefing History' },
            { id: 'workspace', label: 'Workspace' },
            { id: 'artifacts', label: 'Artifacts' },
          ]}
        />
      </div>
      <div className="space-y-6 p-8">
        <ErrorNote>{error}</ErrorNote>
        {tab === 'overview' && <AgentOverview agent={a} onError={setError} />}
        {tab === 'edit' && <AgentEditor existing={a} />}
        {tab === 'briefings' && <BriefingHistory agent={a} />}
        {tab === 'workspace' && <WorkspaceBrowser agent={a.name} />}
        {tab === 'artifacts' && <AgentArtifacts agent={a.name} />}
      </div>
      <RunDialog agent={a} open={running} onClose={() => setRunning(false)} />
    </>
  );
}

function AgentOverview({ agent: a, onError }: { agent: Agent; onError: (e: string | null) => void }) {
  const [raise, setRaise] = useState(false);
  const [budget, setBudget] = useState(String(a.budget_usd));
  const pct = Math.min(100, ((a.spent_usd ?? 0) / Math.max(0.0001, a.budget_usd)) * 100);
  return (
    <>
      <div className="grid gap-3 md:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-muted">Budget</div>
          <div className="mt-1 font-serif text-2xl">
            {money(a.spent_usd)} <span className="text-base text-muted">of {money(a.budget_usd)}</span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover">
            <div className={cn('h-full', pct >= 100 ? 'bg-danger' : 'bg-accent')} style={{ width: `${pct}%` }} />
          </div>
          <Button size="sm" className="mt-3" onClick={() => setRaise(true)}>
            <Wallet /> Change Budget
          </Button>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Jobs</div>
          <div className="mt-1 font-serif text-2xl">
            {a.running ?? 0} <span className="text-base text-muted">running</span> · {a.queued ?? 0}{' '}
            <span className="text-base text-muted">queued</span>
          </div>
          <div className="mt-2 text-xs text-muted">max {a.max_parallel} in parallel</div>
          {a.upcoming?.map((u) => (
            <div key={u.at + u.type} className="mt-1 text-xs text-muted" title={new Date(u.at).toLocaleString()}>
              Next {u.type === 'delay' ? 'wake-up' : 'cron run'} {ago(u.at)}
            </div>
          ))}
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Works On</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {a.projects.map((p) => (
              <a key={p} href={href('projects', p)}>
                <Badge tone="accent">{p}</Badge>
              </a>
            ))}
            {a.resources.map((r) => (
              <a key={r} href={href('resources', r)}>
                <Badge tone="info">{r}</Badge>
              </a>
            ))}
            {!a.projects.length && !a.resources.length && <span className="text-sm text-muted">No projects or resources</span>}
          </div>
        </Card>
      </div>
      <Section title="Briefing">
        <Card className="max-h-72 overflow-auto p-4 text-sm">
          {a.briefing ? <Markdown>{a.briefing}</Markdown> : <span className="text-muted">Empty</span>}
        </Card>
      </Section>
      <Section title="Jobs">
        <JobList agent={a.name} />
      </Section>
      <Dialog
        open={raise}
        onClose={() => setRaise(false)}
        title="Change Budget"
        footer={
          <>
            <Button onClick={() => setRaise(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={async () => {
                onError(null);
                try {
                  await api(`/api/agents/${a.name}`, { method: 'PATCH', body: { budget_usd: Number(budget) } });
                  setRaise(false);
                } catch (e) {
                  onError((e as Error).message);
                }
              }}
            >
              Save
            </Button>
          </>
        }
      >
        <Field
          label="Budget in USD"
          hint={`Spent so far: ${money(a.spent_usd)}. Jobs stopped by the budget can be continued after raising it.`}
        >
          <Input type="number" min="0" step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} autoFocus />
        </Field>
      </Dialog>
    </>
  );
}

// ---------- editor ----------

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
  max_parallel: a.max_parallel,
  triggers: a.triggers,
  projects: a.projects,
  resources: a.resources,
  guardrails: a.guardrails,
});

export function AgentEditor({ existing }: { existing?: Agent }) {
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [draft, setDraft] = useState<Agent>(existing ? { ...existing } : blank());
  const [yaml, setYaml] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const projects = useApi<Project[]>('/api/projects');
  const resources = useApi<Resource[]>('/api/resources');
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
  const inbox = draft.triggers.some((t) => 'inbox' in t);
  const setTriggers = (c: string[], i: boolean) =>
    set('triggers', [...c.map((cron) => ({ cron })), ...(i ? [{ inbox: true as const }] : [])]);

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
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Name" hint="Lowercase letters, digits and dashes.">
            <Input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="social-scout" />
          </Field>
          <Field label="Allowed models" hint="From your LiteLLM proxy. Jobs run with the primary." group>
            <ModelPicker value={draft.models} onChange={(v) => set('models', v)} />
          </Field>
          <Field label="Briefing" className="md:col-span-2">
            <Textarea
              className="min-h-48"
              value={draft.briefing}
              onChange={(e) => set('briefing', e.target.value)}
              placeholder="What this agent is for, its loop, and its limits."
            />
          </Field>
          <Field label="Budget (USD)" hint="What the agent may spend on itself.">
            <Input type="number" min="0" step="0.5" value={draft.budget_usd} onChange={(e) => set('budget_usd', Number(e.target.value))} />
          </Field>
          <Field label="Max parallel jobs">
            <Input type="number" min="1" value={draft.max_parallel} onChange={(e) => set('max_parallel', Number(e.target.value))} />
          </Field>
          <Field label="Schedule" className="md:col-span-2" group>
            <SchedulePicker value={crons} onChange={(v) => setTriggers(v, inbox)} />
          </Field>
          <Field label="Inbox trigger" hint="A new message starts a job." className="md:col-span-2">
            <div className="flex h-9 items-center">
              <Switch checked={inbox} onChange={(v) => setTriggers(crons, v)} label="Inbox trigger" />
            </div>
          </Field>
          <Field label="Projects" group>
            <MultiPicker
              noun="Project"
              emptyText="No projects"
              options={projects.data?.map((p) => ({ value: p.name, label: p.title, hint: p.briefing.split('\n')[0] })) ?? []}
              value={draft.projects}
              onChange={(v) => set('projects', v)}
            />
          </Field>
          <Field label="Resources" group>
            <MultiPicker
              noun="Resource"
              emptyText="No resources"
              options={resources.data?.map((r) => ({ value: r.name, hint: r.briefing.split('\n')[0] })) ?? []}
              value={draft.resources}
              onChange={(v) => set('resources', v)}
            />
          </Field>
          <Field label="Guardrails: agent-triggered jobs per hour">
            <Input
              type="number"
              min="0"
              value={draft.guardrails.rate_per_hour ?? ''}
              onChange={(e) =>
                set('guardrails', { ...draft.guardrails, rate_per_hour: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </Field>
          <Field label="Guardrails: cooldown (s) · hop limit">
            <div className="flex gap-2">
              <Input
                type="number"
                min="0"
                value={draft.guardrails.cooldown_seconds ?? ''}
                onChange={(e) =>
                  set('guardrails', { ...draft.guardrails, cooldown_seconds: e.target.value === '' ? undefined : Number(e.target.value) })
                }
              />
              <Input
                type="number"
                min="0"
                value={draft.guardrails.hop_limit ?? ''}
                onChange={(e) =>
                  set('guardrails', { ...draft.guardrails, hop_limit: e.target.value === '' ? undefined : Number(e.target.value) })
                }
              />
            </div>
          </Field>
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

function DeleteAgent({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        <Trash2 /> Delete
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete ${name}?`}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                await api(`/api/agents/${name}`, { method: 'DELETE' });
                go('agents');
              }}
            >
              Delete Agent
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          Running jobs are stopped, and the agent's jobs, sessions and briefing history are removed. Its workspace folder stays on disk.
        </p>
      </Dialog>
    </>
  );
}

// ---------- briefing history ----------

function BriefingHistory({ agent }: { agent: Agent }) {
  const hist = useApi<Array<{ id: number; briefing: string; author: string; created: string }>>(
    `/api/agents/${agent.name}/briefings`,
    agentChanged(agent.name),
  );
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="space-y-2">
      {hist.data?.map((h, i) => (
        <Card key={h.id} className="p-3">
          <div className="flex items-center gap-2 text-sm">
            <History className="size-4 text-muted" />
            <button type="button" className="cursor-pointer font-medium" onClick={() => setOpen(open === h.id ? null : h.id)}>
              Version {hist.data!.length - i}
            </button>
            <span className="text-muted">
              by {h.author} · {ago(h.created)}
            </span>
            {i === 0 ? (
              <Badge tone="ok" className="ml-auto">
                current
              </Badge>
            ) : (
              <Button
                size="sm"
                className="ml-auto"
                onClick={() => void api(`/api/agents/${agent.name}/briefings/${h.id}/revert`, { method: 'POST' })}
              >
                Revert to This
              </Button>
            )}
          </div>
          {open === h.id && <Markdown className="mt-3 border-t border-line pt-3 text-sm">{h.briefing}</Markdown>}
        </Card>
      ))}
    </div>
  );
}

function AgentArtifacts({ agent }: { agent: string }) {
  const arts = useApi<Artifact[]>(`/api/artifacts?agent=${agent}`, (e) => e.type === 'changed' && e.entity === 'artifacts');
  if (arts.data && !arts.data.length) return <div className="text-sm text-muted">No artifacts yet.</div>;
  return <ArtifactGrid artifacts={arts.data ?? []} />;
}

function Examples() {
  const examples = useApi<Array<{ name: string }>>('/api/examples');
  return (
    <a href={href('library')} className="block max-w-3xl">
      <Card className="flex items-center gap-4 p-4 transition-colors hover:border-line-strong">
        <LibraryBig className="size-6 shrink-0 text-accent" />
        <div className="min-w-0">
          <div className="font-medium">Start from an example</div>
          <div className="text-sm text-muted">
            Browse {examples.data?.length ?? 'the'} ready-made agents in the Example Library: what each does, what it needs, and its
            briefing.
          </div>
        </div>
        <span className="ml-auto shrink-0 text-sm text-accent">Open Library →</span>
      </Card>
    </a>
  );
}
