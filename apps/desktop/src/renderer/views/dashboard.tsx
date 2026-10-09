import { AlertTriangle, ArrowDownRight, ArrowUpRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { cn } from '../components/ui/cn.ts';
import { ago, Card, Empty, money, PageHeader, Section } from '../components/ui/display.tsx';
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
const TRIGGERS: Record<string, string> = { cron: 'Schedule', inbox: 'Inbox', manual: 'Run Now', delay: 'Sleep / continue' };

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
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs text-muted">
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
              {s.by_agent.map((a) => (
                <tr key={a.agent} className="border-b border-line last:border-0 hover:bg-hover/50">
                  <td className="px-4 py-2">
                    <a href={href('agents', a.agent)} className="font-medium hover:text-accent">
                      {a.agent}
                    </a>
                  </td>
                  <td className="w-2/5 px-4 py-2">
                    <Meter value={a.cost_usd} max={s.by_agent[0]?.cost_usd ?? 0} label={money(a.cost_usd)} />
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{a.jobs}</td>
                  <td className={cn('px-4 py-2 text-right tabular-nums', a.failed ? 'text-danger' : 'text-muted')}>{a.failed}</td>
                  <td className="px-4 py-2 text-right text-muted tabular-nums">{seconds(a.avg_seconds)}</td>
                  <td className="px-4 py-2 whitespace-nowrap text-right text-muted">{ago(a.last)}</td>
                </tr>
              ))}
              {!s.by_agent.length && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-muted">
                    No jobs in this period.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
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
          <Card className="space-y-3 p-4">
            {s.by_model.map((m) => (
              <Meter
                key={m.model}
                title={m.model}
                value={m.cost_usd}
                max={s.by_model[0]!.cost_usd}
                label={`${money(m.cost_usd)} · ${m.jobs} jobs`}
              />
            ))}
            {!s.by_model.length && <p className="text-sm text-muted">No jobs in this period.</p>}
          </Card>
        </Section>
        <Section title="Artifacts by Kind">
          <Card className="space-y-3 p-4">
            {s.artifact_kinds.map((k) => (
              <Meter key={k.kind} title={k.kind} value={k.count} max={s.artifact_kinds[0]!.count} label={String(k.count)} />
            ))}
            {!s.artifact_kinds.length && <p className="text-sm text-muted">No artifacts in this period.</p>}
          </Card>
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

/** Jobs by weekday and hour, Monday first, in this computer's time zone. */
function Heatmap({ cells }: { cells: Stats['heatmap'] }) {
  const max = Math.max(1, ...cells.map((c) => c.jobs));
  const at = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c.jobs]));
  const cw = 22;
  const ch = 18;
  const left = 34;
  return (
    <svg viewBox={`0 0 ${left + 24 * cw} ${7 * ch + 16}`} className="w-full">
      <title>Jobs by weekday and hour</title>
      {[1, 2, 3, 4, 5, 6, 0].map((dow, row) => (
        <g key={dow}>
          <text x={0} y={row * ch + 13} fontSize={11} fill="var(--c-muted)">
            {DAYS[dow]}
          </text>
          {Array.from({ length: 24 }, (_, hour) => {
            const n = at.get(`${dow}-${hour}`) ?? 0;
            return (
              <rect
                key={hour}
                x={left + hour * cw + 1}
                y={row * ch + 1}
                width={cw - 2}
                height={ch - 2}
                rx={3}
                fill={n ? 'var(--c-accent)' : 'var(--c-hover)'}
                fillOpacity={n ? 0.25 + 0.75 * (n / max) : 1}
              >
                <title>{`${DAYS[dow]} ${String(hour).padStart(2, '0')}:00: ${n} jobs`}</title>
              </rect>
            );
          })}
        </g>
      ))}
      {[0, 6, 12, 18, 23].map((hour) => (
        <text key={hour} x={left + hour * cw + cw / 2} y={7 * ch + 13} fontSize={11} fill="var(--c-muted)" textAnchor="middle">
          {String(hour).padStart(2, '0')}
        </text>
      ))}
    </svg>
  );
}
