import { ChevronRight, CircleStop, FileText, Play, RotateCcw, Terminal, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../components/ui/button.tsx';
import { cn } from '../components/ui/cn.ts';
import { ago, Badge, Card, duration, Empty, ErrorNote, money, PageHeader, Section, StatusBadge } from '../components/ui/display.tsx';
import { api, onLive, useApi, type Artifact, type Job, type JobEvent } from '../lib/api.ts';
import { href } from '../lib/router.ts';
import { ArtifactGrid } from './artifacts.tsx';
import type { ViewProps } from './index.tsx';

const jobChanged = (e: { type: string }) => e.type === 'job';

/** Re-render every second while something is running, so runtimes tick. */
function useTick(active: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

export function JobsView({ route }: ViewProps) {
  if (route[1]) return <JobDetail id={route[1]} />;
  return <ActiveJobs />;
}

function ActiveJobs() {
  const active = useApi<Job[]>('/api/jobs?active=1', jobChanged);
  const recent = useApi<Job[]>('/api/jobs?limit=30', jobChanged);
  useTick(!!active.data?.length);
  return (
    <>
      <PageHeader title="Running jobs" sub="Every active job, with its trigger, runtime and cost." />
      <div className="space-y-8 p-8">
        {active.data?.length ? (
          <JobTable jobs={active.data} showAgent />
        ) : (
          <Empty icon={<Play />} title="Nothing running">
            Jobs start from cron schedules, inbox messages, delays, or Run now on an agent.
          </Empty>
        )}
        <Section title="Recent">
          <JobTable jobs={recent.data?.filter((j) => j.status !== 'running' && j.status !== 'queued') ?? []} showAgent />
        </Section>
      </div>
    </>
  );
}

export function JobList({ agent }: { agent: string }) {
  const jobs = useApi<Job[]>(`/api/jobs?agent=${encodeURIComponent(agent)}&limit=50`, jobChanged);
  useTick(!!jobs.data?.some((j) => j.status === 'running'));
  if (jobs.data && !jobs.data.length) return <div className="text-sm text-muted">No jobs yet.</div>;
  return <JobTable jobs={jobs.data ?? []} />;
}

function JobTable({ jobs, showAgent }: { jobs: Job[]; showAgent?: boolean }) {
  if (!jobs.length) return null;
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-line">
            <th className="px-4 py-2 font-medium">Job</th>
            {showAgent && <th className="px-4 py-2 font-medium">Agent</th>}
            <th className="px-4 py-2 font-medium">Trigger</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Runtime</th>
            <th className="px-4 py-2 text-right font-medium">Cost</th>
            <th className="w-10" />
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} className="border-b border-line last:border-0 hover:bg-hover/40">
              <td className="px-4 py-2">
                <a href={href('jobs', j.id)} className="font-mono text-xs hover:text-accent">
                  {j.id}
                </a>
                <div className="text-xs text-muted">{ago(j.created)}</div>
              </td>
              {showAgent && (
                <td className="px-4 py-2">
                  <a href={href('agents', j.agent)} className="hover:text-accent">
                    {j.agent}
                  </a>
                </td>
              )}
              <td className="px-4 py-2 text-muted">{j.trigger_type}</td>
              <td className="px-4 py-2">
                <StatusBadge status={j.status} />
                {j.reason && (
                  <div className="mt-0.5 max-w-64 truncate text-xs text-muted" title={j.reason}>
                    {j.reason}
                  </div>
                )}
              </td>
              <td className="px-4 py-2 text-muted tabular-nums">{duration(j.started, j.status === 'running' ? null : j.ended)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{money(j.cost_usd)}</td>
              <td className="px-2 py-2">
                {(j.status === 'running' || j.status === 'queued') && (
                  <Button size="icon" variant="ghost" title="Stop" onClick={() => void api(`/api/jobs/${j.id}/stop`, { method: 'POST' })}>
                    <CircleStop />
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------- live view ----------

function JobDetail({ id }: { id: string }) {
  const job = useApi<Job>(`/api/jobs/${id}`, (e) => e.type === 'job' && (e as { job: Job }).job.id === id);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const artifacts = useApi<Artifact[]>(
    `/api/artifacts?job=${id}`,
    (e) => e.type === 'changed' && (e as { entity: string }).entity === 'artifacts',
  );
  const bottom = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    let last = 0;
    let alive = true;
    setEvents([]);
    const load = async () => {
      const more = await api<JobEvent[]>(`/api/jobs/${id}/events?after=${last}`);
      if (!alive || !more.length) return;
      last = more[more.length - 1]!.id;
      setEvents((prev) => [...prev, ...more.filter((m) => !prev.some((p) => p.id === m.id))]);
    };
    void load();
    const off = onLive((e) => {
      if (e.type === 'job_event' && e.job === id) {
        last = Math.max(last, e.event.id);
        setEvents((prev) => (prev.some((p) => p.id === e.event.id) ? prev : [...prev, e.event]));
      }
      if (e.type === 'connection' && e.connected) void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [id]);

  useEffect(() => {
    const onScroll = () => {
      const main = document.querySelector('main');
      if (main) follow.current = main.scrollHeight - main.scrollTop - main.clientHeight < 120;
    };
    const main = document.querySelector('main');
    main?.addEventListener('scroll', onScroll);
    return () => main?.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (follow.current) bottom.current?.scrollIntoView({ block: 'end' });
  }, [events.length]);

  const j = job.data;
  useTick(j?.status === 'running');
  const files = useMemo(() => filesTouched(events), [events]);
  if (job.error) return <Empty title="Job not found">{job.error}</Empty>;
  if (!j) return null;

  const act = async (path: string) => {
    setError(null);
    try {
      await api(path, { method: 'POST' });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const live = j.status === 'running' || j.status === 'queued';
  const canContinue = j.status === 'failed' || j.status === 'budget_exhausted' || j.status === 'stopped';

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <a href={href('agents', j.agent)} className="hover:text-accent">
              {j.agent}
            </a>
            <StatusBadge status={j.status} />
          </span>
        }
        sub={
          <span className="flex flex-wrap gap-x-3">
            <span className="font-mono text-xs">{j.id}</span>
            <span>trigger: {j.trigger_type}</span>
            {j.model && <span>model: {j.model}</span>}
            <span className="tabular-nums">runtime: {duration(j.started, live ? null : j.ended)}</span>
            <span className="tabular-nums font-medium text-ink">cost: {money(j.cost_usd)}</span>
          </span>
        }
        actions={
          <>
            {live && (
              <Button onClick={() => void act(`/api/jobs/${j.id}/stop`)}>
                <CircleStop /> Stop
              </Button>
            )}
            {canContinue && (
              <Button variant="primary" onClick={() => void act(`/api/jobs/${j.id}/continue`)}>
                <RotateCcw /> Continue
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-6 p-8 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-2">
          <ErrorNote>{error}</ErrorNote>
          {(j.status === 'failed' || j.status === 'budget_exhausted') && j.reason && (
            <div
              className={cn(
                'rounded-xl border px-4 py-3 text-sm',
                j.status === 'failed' ? 'border-danger/30 bg-danger/8 text-danger' : 'border-warn/30 bg-warn/10 text-warn',
              )}
            >
              <div className="font-medium">{j.status === 'failed' ? 'This job failed' : 'This job ran out of budget'}</div>
              <div className="mt-0.5">{j.reason}</div>
              {j.status === 'budget_exhausted' && (
                <div className="mt-1 text-ink/70">
                  Raise the budget on{' '}
                  <a className="underline" href={href('agents', j.agent)}>
                    {j.agent}
                  </a>
                  , then Continue to resume this job where it stopped.
                </div>
              )}
            </div>
          )}
          {events.map((e) => (
            <EventRow key={e.id} e={e} />
          ))}
          {live && (
            <div className="flex items-center gap-2 px-1 py-2 text-sm text-muted">
              <span className="size-2 animate-pulse rounded-full bg-info" />{' '}
              {j.status === 'queued' ? 'Waiting for a free slot…' : 'Working…'}
            </div>
          )}
          <div ref={bottom} />
        </div>
        <aside className="space-y-6">
          <Section title="Files touched">
            {files.length ? (
              <ul className="space-y-1 text-xs">
                {files.map((f) => (
                  <li key={f} className="flex items-center gap-1.5 truncate text-muted" title={f}>
                    <FileText className="size-3.5 shrink-0" />
                    <span className="truncate">{f.split(/[\\/]/).slice(-2).join('/')}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="text-xs text-muted">None yet</div>
            )}
          </Section>
          <Section title="Artifacts">
            {artifacts.data?.length ? <ArtifactGrid artifacts={artifacts.data} compact /> : <div className="text-xs text-muted">None</div>}
          </Section>
        </aside>
      </div>
    </>
  );
}

function filesTouched(events: JobEvent[]): string[] {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'tool_use') continue;
    const input = (e.data.input ?? {}) as Record<string, unknown>;
    const p = input.file_path ?? input.path ?? input.notebook_path;
    if (typeof p === 'string' && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(String(e.data.name))) out.add(p);
  }
  return [...out];
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.description === 'string') return input.description;
  const s = JSON.stringify(input);
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function EventRow({ e }: { e: JobEvent }) {
  const [open, setOpen] = useState(false);
  const d = e.data;
  switch (e.kind) {
    case 'text':
      return <div className="prose-yaho rounded-xl px-1 py-1.5 text-[14.5px]">{String(d.text ?? '')}</div>;
    case 'tool_use': {
      const input = (d.input ?? {}) as Record<string, unknown>;
      return (
        <div className="rounded-lg border border-line bg-panel text-sm">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left"
          >
            <ChevronRight className={cn('size-3.5 shrink-0 text-muted transition-transform', open && 'rotate-90')} />
            {String(d.name) === 'Bash' ? (
              <Terminal className="size-3.5 shrink-0 text-muted" />
            ) : (
              <Wrench className="size-3.5 shrink-0 text-muted" />
            )}
            <span className="font-medium">{String(d.name)}</span>
            <code className="truncate text-muted">{toolSummary(String(d.name), input)}</code>
          </button>
          {open && <pre className="overflow-auto border-t border-line px-3 py-2 whitespace-pre-wrap">{JSON.stringify(input, null, 2)}</pre>}
        </div>
      );
    }
    case 'tool_result': {
      const out = String(d.output ?? '');
      return (
        <div className={cn('ml-6 rounded-lg text-xs', d.is_error ? 'text-danger' : 'text-muted')}>
          <button type="button" onClick={() => setOpen(!open)} className="flex cursor-pointer items-center gap-1.5">
            <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
            {d.is_error ? 'error' : 'result'} · {out.split('\n')[0]!.slice(0, 100) || '(empty)'}
          </button>
          {open && <pre className="mt-1 max-h-96 overflow-auto rounded-md bg-code p-2 whitespace-pre-wrap">{out}</pre>}
        </div>
      );
    }
    case 'prompt':
      return (
        <div className="text-xs">
          <button type="button" onClick={() => setOpen(!open)} className="flex cursor-pointer items-center gap-1.5 text-muted">
            <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} /> Prompt sent to the harness
          </button>
          {open && (
            <div className="mt-1 space-y-2">
              <pre className="max-h-96 overflow-auto rounded-md bg-code p-3 whitespace-pre-wrap">{String(d.system ?? '')}</pre>
              <pre className="max-h-96 overflow-auto rounded-md bg-code p-3 whitespace-pre-wrap">{String(d.user ?? '')}</pre>
            </div>
          )}
        </div>
      );
    case 'cost':
      return null;
    case 'result':
      return d.summary ? (
        <Card className="border-ok/30 p-3 text-sm">
          <div className="mb-1 text-xs font-medium text-ok">Result</div>
          <div className="prose-yaho">{String(d.summary)}</div>
        </Card>
      ) : null;
    case 'stderr':
      return <pre className="text-xs whitespace-pre-wrap text-warn">{String(d.text ?? '')}</pre>;
    default:
      return (
        <div className="flex items-center gap-2 py-1 text-xs text-muted">
          <Badge>{e.kind}</Badge> {String(d.text ?? JSON.stringify(d))}
          <span className="ml-auto">{ago(e.created)}</span>
        </div>
      );
  }
}
