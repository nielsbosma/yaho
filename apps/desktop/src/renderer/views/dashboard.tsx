import { AlertTriangle, ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../components/ui/cn.ts';
import { ago, Card, Empty, money, PageHeader, Section } from '../components/ui/display.tsx';
import { Input } from '../components/ui/form.tsx';
import { useApi } from '../lib/api.ts';
import { href } from '../lib/router.ts';

interface Stats {
  days: number;
  totals: {
    jobs: number;
    finished: number;
    failed: number;
    cost_usd: number;
    avg_cost_usd: number;
    avg_seconds: number;
    messages: number;
    unread: number;
    artifacts: number;
    agents: number;
    active_agents: number;
  };
  previous: { jobs: number; cost_usd: number; failed: number };
  daily: Array<{ day: string; jobs: number; failed: number; cost_usd: number }>;
  by_agent: Array<{ agent: string; jobs: number; failed: number; cost_usd: number; avg_seconds: number; last: string | null }>;
  by_model: Array<{ model: string; jobs: number; cost_usd: number }>;
  by_trigger: Array<{ trigger: string; jobs: number }>;
  heatmap: Array<{ dow: number; hour: number; jobs: number }>;
  artifact_kinds: Array<{ kind: string; count: number }>;
  failures: Array<{ id: string; agent: string; status: string; reason: string | null; created: string }>;
}

const PERIODS = [7, 30, 90];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TRIGGERS: Record<string, string> = {
  cron: 'Schedule',
  inbox: 'Inbox',
  manual: 'Run Now',
  delay: 'Woke From Sleep',
  continue: 'Continue',
  followup: 'Follow Up',
};

const seconds = (s: number) => (!s ? '–' : s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const shortDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function DashboardView() {
  const [days, setDays] = useState(30);
  const stats = useApi<Stats>(`/api/stats?days=${days}`, (e) => e.type === 'job' || e.type === 'message' || e.type === 'changed');
  const s = stats.data;
  return (
    <>
      <PageHeader
        title="Dashboard"
        sub="What your agents have been up to."
        actions={
          <div className="flex rounded-lg bg-hover p-0.5 text-sm">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setDays(p)}
                className={cn('cursor-pointer rounded-md px-2.5 py-1', days === p ? 'bg-panel shadow-sm' : 'text-muted hover:text-ink')}
              >
                {p} Days
              </button>
            ))}
          </div>
        }
      />
      {s && <Body s={s} />}
    </>
  );
}

function Body({ s }: { s: Stats }) {
  const t = s.totals;
  if (!t.agents) return <Empty title="Nothing to show yet">Create an agent, and its jobs, spend and output show up here.</Empty>;
  const done = t.finished + t.failed;
  return (
    <div className="space-y-8 p-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <Kpi label="Jobs" value={String(t.jobs)} trend={trend(t.jobs, s.previous.jobs)} />
        <Kpi label="Spend" value={money(t.cost_usd)} trend={trend(t.cost_usd, s.previous.cost_usd)} invert />
        <Kpi label="Success Rate" value={done ? `${Math.round((t.finished / done) * 100)}%` : '–'} note={`${t.failed} failed`} />
        <Kpi label="Avg Job" value={seconds(t.avg_seconds)} note={`${money(t.avg_cost_usd)} each`} />
        <Kpi label="Messages" value={String(t.messages)} note={t.unread ? `${t.unread} unread` : 'all read'} to={href('inbox')} />
        <Kpi label="Artifacts" value={String(t.artifacts)} note={`${t.active_agents} of ${t.agents} agents active`} to={href('artifacts')} />
      </div>

      <Section title="Next 24 Hours">
        <ScheduleTimeline />
      </Section>

      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="Jobs per Day">
          <Card className="p-4">
            <Bars
              data={s.daily.map((d) => ({ label: d.day, value: d.jobs, part: d.failed }))}
              tip={(d) => `${shortDay(d.label)}: ${d.value} jobs${d.part ? `, ${d.part} failed` : ''}`}
            />
          </Card>
        </Section>
        <Section title="Spend per Day">
          <Card className="p-4">
            <Bars data={s.daily.map((d) => ({ label: d.day, value: d.cost_usd }))} tip={(d) => `${shortDay(d.label)}: ${money(d.value)}`} money />
          </Card>
        </Section>
      </div>

      <Section title="Agents">
        <AgentTable rows={s.by_agent} />
      </Section>

      <div className="grid gap-6 xl:grid-cols-3">
        <Section title="When Jobs Run" className="xl:col-span-2">
          <Card className="p-4">
            <Heatmap cells={s.heatmap} />
          </Card>
        </Section>
        <Section title="How Jobs Start">
          <Card className="space-y-3 p-4">
            {s.by_trigger.map((x) => (
              <Meter key={x.trigger} title={TRIGGERS[x.trigger] ?? x.trigger} value={x.jobs} max={s.by_trigger[0]!.jobs} label={String(x.jobs)} />
            ))}
            {!s.by_trigger.length && <p className="text-sm text-muted">No jobs in this period.</p>}
          </Card>
        </Section>
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <Section title="Spend by Model">
          <TopMeters
            rows={s.by_model}
            value={(m) => m.cost_usd}
            title={(m) => m.model}
            label={(m) => `${money(m.cost_usd)} · ${m.jobs} jobs`}
            empty="No jobs in this period."
          />
        </Section>
        <Section title="Artifacts by Kind">
          <TopMeters rows={s.artifact_kinds} value={(k) => k.count} title={(k) => k.kind} label={(k) => String(k.count)} empty="No artifacts in this period." />
        </Section>
        <Section title="Recent Failures">
          <Card className="divide-y divide-line">
            {s.failures.map((f) => (
              <a key={f.id} href={href('jobs', f.id)} className="flex gap-2.5 px-4 py-2.5 text-sm hover:bg-hover/50">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
                <span className="min-w-0">
                  <span className="font-medium">{f.agent}</span> <span className="text-muted">· {ago(f.created)}</span>
                  <span className="block truncate text-xs text-muted">{f.reason || f.status.replace('_', ' ')}</span>
                </span>
              </a>
            ))}
            {!s.failures.length && <p className="px-4 py-3 text-sm text-muted">None. Everything finished.</p>}
          </Card>
        </Section>
      </div>
    </div>
  );
}

/** Change against the period before, as a fraction; null when there is nothing to compare with. */
const trend = (now: number, before: number) => (before ? (now - before) / before : null);

function Kpi({ label, value, note, trend, invert, to }: { label: string; value: string; note?: string; trend?: number | null; invert?: boolean; to?: string }) {
  const up = (trend ?? 0) > 0;
  const good = invert ? !up : up;
  const body = (
    <Card className={cn('h-full p-4', to && 'transition-colors hover:border-line-strong')}>
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 font-serif text-[28px] leading-none tabular-nums">{value}</div>
      <div className="mt-2 flex items-center gap-1 text-xs text-muted">
        {trend != null && Math.abs(trend) >= 0.005 ? (
          <span className={cn('flex items-center', good ? 'text-ok' : 'text-danger')}>
            {up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
            {Math.round(Math.abs(trend) * 100)}%
          </span>
        ) : null}
        {note ?? (trend != null ? 'vs. the period before' : 'nothing to compare with yet')}
      </div>
    </Card>
  );
  return to ? <a href={to}>{body}</a> : body;
}

function Meter({ title, value, max, label }: { title?: ReactNode; value: number; max: number; label: string }) {
  return (
    <div className="space-y-1">
      {title && <div className="truncate text-sm">{title}</div>}
      <div className="flex items-center gap-2">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-hover">
          <div className="h-full rounded-full bg-accent" style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }} />
        </div>
        <span className="w-28 shrink-0 text-right text-xs text-muted tabular-nums">{label}</span>
      </div>
    </div>
  );
}

interface Bar {
  label: string;
  value: number;
  /** Part of the value drawn in red (failed jobs). */
  part?: number;
}

/** A bar per day with a hover tip; labels on the first, middle and last day. */
function Bars({ data, tip, money: isMoney }: { data: Bar[]; tip: (b: Bar) => string; money?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 600;
  const H = 110;
  const max = Math.max(...data.map((d) => d.value), isMoney ? 0.01 : 1);
  const step = W / data.length;
  const bw = Math.max(2, step * 0.7);
  const y = (v: number) => H - (v / max) * H;
  const total = data.reduce((t, d) => t + d.value, 0);
  const marks = [0, Math.floor((data.length - 1) / 2), data.length - 1];
  const h = hover !== null ? data[hover] : undefined;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between text-xs text-muted">
        <span>{h ? tip(h) : `Total ${isMoney ? money(total) : total}`}</span>
        <span>max {isMoney ? money(max) : max}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full" onMouseLeave={() => setHover(null)}>
        <title>{isMoney ? 'Spend per day' : 'Jobs per day'}</title>
        <line x1={0} x2={W} y1={H + 0.5} y2={H + 0.5} stroke="var(--c-line)" />
        {data.map((d, i) => {
          const x = i * step + (step - bw) / 2;
          return (
            <g key={d.label} onMouseEnter={() => setHover(i)}>
              <rect x={i * step} y={0} width={step} height={H} fill={hover === i ? 'var(--c-hover)' : 'transparent'} />
              {d.value > 0 && <rect x={x} y={y(d.value)} width={bw} height={H - y(d.value)} rx={Math.min(3, bw / 3)} fill="var(--c-accent)" />}
              {!!d.part && <rect x={x} y={y(d.part)} width={bw} height={H - y(d.part)} rx={Math.min(3, bw / 3)} fill="var(--c-danger)" />}
            </g>
          );
        })}
        {[...new Set(marks)].map((i) => (
          <text
            key={i}
            x={i * step + step / 2}
            y={H + 14}
            fontSize={11}
            fill="var(--c-muted)"
            textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}
          >
            {shortDay(data[i]!.label)}
          </text>
        ))}
      </svg>
    </div>
  );
}

/** Jobs by weekday and hour. HTML, not a scaled SVG, so the labels keep the dashboard's 11px at any width. */
function Heatmap({ cells }: { cells: Stats['heatmap'] }) {
  const max = Math.max(1, ...cells.map((c) => c.jobs));
  const at = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c.jobs]));
  const cols = { gridTemplateColumns: '2.25rem repeat(24, minmax(0, 1fr))' };
  return (
    <div role="img" aria-label="Jobs by weekday and hour" className="text-[11px] text-muted">
      {[1, 2, 3, 4, 5, 6, 0].map((dow) => (
        <div key={dow} className="grid items-center gap-[3px] pb-[3px]" style={cols}>
          <span>{DAYS[dow]}</span>
          {Array.from({ length: 24 }, (_, hour) => {
            const n = at.get(`${dow}-${hour}`) ?? 0;
            return (
              <div
                key={hour}
                title={`${DAYS[dow]} ${String(hour).padStart(2, '0')}:00: ${n} jobs`}
                className={cn('h-4 rounded-[3px]', n ? 'bg-accent' : 'bg-hover')}
                style={n ? { opacity: 0.25 + 0.75 * (n / max) } : undefined}
              />
            );
          })}
        </div>
      ))}
      <div className="grid gap-[3px] pt-1 tabular-nums" style={cols}>
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="text-center">
            {hour % 6 === 0 || hour === 23 ? String(hour).padStart(2, '0') : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

interface Schedule {
  from: string;
  to: string;
  hours: number;
  runs: Array<{ agent: string; type: 'cron' | 'delay'; at: string; cron?: string; enabled: boolean }>;
  agents: string[];
  duration_seconds: Record<string, number>;
}

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Rows shown before the timeline scrolls, and agents in the table before "Show All". */
const TOP = 10;

/**
 * The next 24 hours: a load strip with every agent's runs per hour, then a row per agent (soonest first) with a bar
 * per run, as long as the agent's typical job. With many agents the rows scroll and can be filtered.
 */
export function ScheduleTimeline() {
  const sched = useApi<Schedule>('/api/schedule?hours=24', (e) => e.type === 'changed' || e.type === 'job');
  const [, setTick] = useState(0);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    const t = setInterval(() => {
      setTick((n) => n + 1);
      void sched.reload();
    }, 60_000);
    return () => clearInterval(t);
  }, []);
  const s = sched.data;
  if (!s) return null;
  if (!s.runs.length)
    return <Card className="p-6 text-center text-sm text-muted">No scheduled runs in the next 24 hours. Agents with a cron trigger show up here.</Card>;

  const from = new Date(s.from).getTime();
  const span = new Date(s.to).getTime() - from;
  const pct = (t: number) => ((t - from) / span) * 100;
  // Ticks on every third whole hour; a stronger line at midnight with the day's name.
  const ticks: Array<{ t: number; midnight: boolean }> = [];
  const first = new Date(from);
  first.setMinutes(0, 0, 0);
  for (let t = first.getTime() + 3_600_000; t < from + span; t += 3_600_000) {
    const h = new Date(t).getHours();
    if (h % 3 === 0) ticks.push({ t, midnight: h === 0 });
  }

  const byAgent = new Map<string, Schedule['runs']>();
  for (const r of s.runs) byAgent.set(r.agent, [...(byAgent.get(r.agent) ?? []), r]);
  const live = s.runs.filter((r) => r.enabled);
  const q = filter.trim().toLowerCase();
  const agents = [...byAgent.keys()]
    .filter((a) => !q || a.toLowerCase().includes(q))
    .map((a) => ({ a, next: byAgent.get(a)!.find((r) => r.enabled)?.at }))
    // Soonest next run first; agents that will not run (disabled) last.
    .sort((x, y) => (x.next && y.next ? x.next.localeCompare(y.next) : x.next ? -1 : y.next ? 1 : x.a.localeCompare(y.a)))
    .map((x) => x.a);

  // Runs per hour across all agents, for the load strip.
  const buckets = Array.from({ length: s.hours }, () => 0);
  for (const r of live) buckets[Math.min(s.hours - 1, Math.floor((new Date(r.at).getTime() - from) / 3_600_000))]!++;
  const peak = Math.max(1, ...buckets);

  const grid = ticks.map((k) => (
    <div key={k.t} className={cn('absolute inset-y-0 w-px', k.midnight ? 'bg-line-strong' : 'bg-line')} style={{ left: `${pct(k.t)}%` }} />
  ));

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-sm text-muted">
        <span>
          <span className="font-medium text-ink tabular-nums">{live.length}</span> runs from{' '}
          <span className="font-medium text-ink tabular-nums">{new Set(live.map((r) => r.agent)).size}</span> agents
        </span>
        {byAgent.size > TOP && (
          <Input className="ml-auto h-7 w-48 text-xs" placeholder="Filter agents" value={filter} onChange={(e) => setFilter(e.target.value)} />
        )}
      </div>
      <div className="px-4 pt-3">
        <div className="flex">
          <div className="w-44 shrink-0" />
          <div className="relative h-5 flex-1 text-[11px] text-muted">
            <span className="absolute left-0">Now</span>
            {ticks
              .filter((k) => pct(k.t) > 7)
              .map((k) => (
                <span key={k.t} className={cn('absolute -translate-x-1/2 tabular-nums', k.midnight && 'font-medium text-ink')} style={{ left: `${pct(k.t)}%` }}>
                  {k.midnight ? new Date(k.t).toLocaleDateString(undefined, { weekday: 'short' }) : clock(new Date(k.t))}
                </span>
              ))}
          </div>
        </div>
        <div className="flex items-end border-b border-line pb-1.5">
          <div className="w-44 shrink-0 pr-3 text-xs text-muted">Runs per hour</div>
          <div className="flex h-8 flex-1 items-end gap-px">
            {buckets.map((n, i) => (
              <div
                key={i}
                title={`${clock(new Date(from + i * 3_600_000))}: ${n} run${n === 1 ? '' : 's'}`}
                className={cn('flex-1 rounded-t-sm', n ? 'bg-accent/70' : 'bg-hover')}
                style={{ height: n ? `${Math.max(12, (n / peak) * 100)}%` : '2px' }}
              />
            ))}
          </div>
        </div>
      </div>
      <div className={cn('divide-y divide-line px-4', agents.length > TOP && 'max-h-[340px] overflow-y-auto')}>
        {agents.map((agent) => {
          const runs = byAgent.get(agent)!;
          const off = runs.every((r) => !r.enabled);
          const dur = s.duration_seconds[agent] ?? 0;
          return (
            <div key={agent} className="flex items-center py-1">
              <a
                href={href('agents', agent)}
                title={agent}
                className={cn('flex w-44 shrink-0 items-baseline pr-3 text-sm hover:text-accent', off && 'text-muted')}
              >
                <span className="truncate">{agent}</span>
                <span className="ml-1.5 shrink-0 text-xs text-muted tabular-nums">{off ? 'off' : `×${runs.length}`}</span>
              </a>
              <div className="relative h-4 flex-1 overflow-hidden rounded bg-hover/60">
                {grid}
                {runs.map((r) => {
                  const at = new Date(r.at);
                  const tip = `${agent} · ${at.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${
                    r.type === 'delay' ? ' · wakes from sleep' : ` · ${r.cron}`
                  }${dur ? ` · usually ${seconds(dur)}` : ''}${r.enabled ? '' : ' · agent is disabled, will not run'}`;
                  return (
                    <div
                      key={r.at + r.type}
                      title={tip}
                      className={cn(
                        'absolute inset-y-0.5 min-w-1.5 rounded-sm',
                        !r.enabled ? 'border border-dashed border-line-strong bg-transparent' : r.type === 'delay' ? 'bg-accent/50' : 'bg-accent',
                      )}
                      style={{ left: `${pct(at.getTime())}%`, width: `${((dur * 1000) / span) * 100}%` }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
        {!agents.length && <div className="py-4 text-center text-sm text-muted">No agent matches “{filter}”.</div>}
      </div>
      <div className="flex flex-wrap gap-4 border-t border-line px-4 py-2.5 text-xs text-muted">
        <Legend className="bg-accent">Scheduled run</Legend>
        <Legend className="bg-accent/50">Wakes from sleep</Legend>
        <Legend className="border border-dashed border-line-strong">Agent disabled</Legend>
        <span className="ml-auto">Bar length is the agent's typical job.</span>
      </div>
    </Card>
  );
}

/** Spend per agent: the top ones by spend, the rest behind Show All, with a filter once there are many. */
function AgentTable({ rows }: { rows: Stats['by_agent'] }) {
  const [all, setAll] = useState(false);
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const matching = q ? rows.filter((a) => a.agent.toLowerCase().includes(q)) : rows;
  const shown = all || q ? matching : matching.slice(0, TOP);
  const max = rows[0]?.cost_usd ?? 0;
  return (
    <Card className="overflow-hidden">
      {rows.length > TOP && (
        <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-sm text-muted">
          {q ? `${matching.length} of ${rows.length} agents` : all ? `All ${rows.length} agents` : `Top ${TOP} of ${rows.length} agents by spend`}
          <Input className="ml-auto h-7 w-48 text-xs" placeholder="Filter agents" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <div className={cn(all && !q && rows.length > 25 && 'max-h-[520px] overflow-y-auto')}>
        <table className="w-full text-sm">
          <thead className="sticky top-0 border-b border-line bg-panel text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Agent</th>
              <th className="px-4 py-2 font-medium">Spend</th>
              <th className="px-4 py-2 text-right font-medium">Jobs</th>
              <th className="px-4 py-2 text-right font-medium">Failed</th>
              <th className="px-4 py-2 text-right font-medium">Avg Job</th>
              <th className="px-4 py-2 text-right font-medium">Last Run</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a.agent} className="border-b border-line last:border-0 hover:bg-hover/50">
                <td className="max-w-56 truncate px-4 py-2">
                  <a href={href('agents', a.agent)} title={a.agent} className="font-medium hover:text-accent">
                    {a.agent}
                  </a>
                </td>
                <td className="w-2/5 px-4 py-2">
                  <Meter value={a.cost_usd} max={max} label={money(a.cost_usd)} />
                </td>
                <td className="px-4 py-2 text-right tabular-nums">{a.jobs}</td>
                <td className={cn('px-4 py-2 text-right tabular-nums', a.failed ? 'text-danger' : 'text-muted')}>{a.failed}</td>
                <td className="px-4 py-2 text-right text-muted tabular-nums">{seconds(a.avg_seconds)}</td>
                <td className="px-4 py-2 whitespace-nowrap text-right text-muted">{ago(a.last)}</td>
              </tr>
            ))}
            {!shown.length && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-muted">
                  {q ? `No agent matches “${filter}”.` : 'No jobs in this period.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length > TOP && !q && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="w-full cursor-pointer border-t border-line py-2 text-xs font-medium text-muted hover:bg-hover/50 hover:text-ink"
        >
          {all ? `Show Top ${TOP}` : `Show All ${rows.length} Agents`}
        </button>
      )}
    </Card>
  );
}

/** A meter list capped at a few rows, with the rest summed in one line. */
function TopMeters<T>({ rows, value, title, label, empty }: { rows: T[]; value: (r: T) => number; title: (r: T) => string; label: (r: T) => string; empty: string }) {
  const shown = rows.slice(0, 6);
  const rest = rows.slice(6);
  const max = rows[0] ? value(rows[0]) : 0;
  return (
    <Card className="space-y-3 p-4">
      {shown.map((r) => (
        <Meter key={title(r)} title={title(r)} value={value(r)} max={max} label={label(r)} />
      ))}
      {rest.length > 0 && (
        <p className="text-xs text-muted" title={rest.map(title).join(', ')}>
          and {rest.length} more
        </p>
      )}
      {!rows.length && <p className="text-sm text-muted">{empty}</p>}
    </Card>
  );
}

function Legend({ className, children }: { className: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('inline-block h-2.5 w-4 rounded-sm', className)} />
      {children}
    </span>
  );
}
