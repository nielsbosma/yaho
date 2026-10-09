import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.ts';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-line bg-panel', className)} {...props} />;
}

const tones = {
  neutral: 'bg-hover text-muted',
  accent: 'bg-accent/12 text-accent',
  ok: 'bg-ok/12 text-ok',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/12 text-danger',
  info: 'bg-info/12 text-info',
};

export function Badge({ tone = 'neutral', className, children }: { tone?: keyof typeof tones; className?: string; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', tones[tone], className)}>
      {children}
    </span>
  );
}

const statusTone: Record<string, keyof typeof tones> = {
  running: 'info',
  queued: 'neutral',
  finished: 'ok',
  sleeping: 'accent',
  failed: 'danger',
  budget_exhausted: 'warn',
  stopped: 'neutral',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={statusTone[status] ?? 'neutral'}>
      {status === 'running' && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {status.replace('_', ' ')}
    </Badge>
  );
}

export function CountPill({ n, tone = 'accent' }: { n: number; tone?: 'accent' | 'muted' }) {
  if (!n) return null;
  return (
    <span
      className={cn(
        'ml-auto min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-semibold',
        tone === 'accent' ? 'bg-accent text-white' : 'bg-hover text-muted',
      )}
    >
      {n}
    </span>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-muted">
      {icon && <div className="text-muted/60 [&_svg]:size-8">{icon}</div>}
      <div className="font-serif text-lg text-ink">{title}</div>
      {children && <div className="max-w-sm text-sm">{children}</div>}
    </div>
  );
}

/** A way back: links to the pages above this one, shown over the title. */
export type Crumb = { label: string; to: string };

export function PageHeader({ title, sub, actions, crumbs }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; crumbs?: Crumb[] }) {
  return (
    <div className="sticky top-0 z-20 flex flex-wrap items-start justify-between gap-3 border-b border-line bg-bg px-8 pt-7 pb-5">
      <div className="min-w-0">
        {crumbs?.length ? (
          <nav aria-label="Breadcrumb" className="-mt-3 mb-1.5 flex items-center gap-1 text-xs text-muted">
            {crumbs.map((c) => (
              <span key={c.to} className="flex items-center gap-1">
                <a href={c.to} className="hover:text-accent">
                  {c.label}
                </a>
                <span aria-hidden>›</span>
              </span>
            ))}
          </nav>
        ) : null}
        <h1 className="truncate font-serif text-[26px] leading-tight text-ink">{title}</h1>
        {sub && <div className="mt-1 text-sm text-muted">{sub}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Section({
  title,
  actions,
  children,
  className,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: Array<{ id: T; label: ReactNode }>;
}) {
  return (
    <div className="flex gap-1 border-b border-line px-8">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={cn(
            '-mb-px cursor-pointer border-b-2 px-3 py-2.5 text-sm transition-colors',
            value === t.id ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-sm text-danger">{children}</div>;
}

export const money = (n: number | undefined | null) => `$${(n ?? 0).toFixed(n && n < 1 ? 3 : 2)}`;

export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 0) {
    const f = -s;
    if (f < 60) return `in ${Math.round(f)}s`;
    if (f < 3600) return `in ${Math.round(f / 60)}m`;
    if (f < 86400) return `in ${Math.round(f / 3600)}h`;
    return `in ${Math.round(f / 86400)}d`;
  }
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function duration(from: string | null, to: string | null): string {
  if (!from) return '';
  const s = Math.max(0, ((to ? new Date(to) : new Date()).getTime() - new Date(from).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}
