import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { cn } from '../../components/ui/cn.ts';
import { ErrorNote } from '../../components/ui/display.tsx';
import { href } from '../../lib/router.ts';

/** One page of Settings: its place in the list on the left, and its content. */
export function Pane({ children }: { id: string; label: string; icon?: ReactNode; children: ReactNode }) {
  return <>{children}</>;
}

/**
 * Settings as a list of sections on the left (in PANE_ORDER) and the chosen one on the right (#/settings/<id>; the first
 * by default).
 * Save Settings in the header saves every section at once.
 */
const PANE_ORDER = [
  'models',
  'harnesses',
  'integrations',
  'guardrails',
  'defaults',
  'server',
  'mcp',
  'updates',
  'appearance',
  'advanced',
  'debug',
];

export function SettingsPanes({ active, error, children }: { active?: string; error: string | null; children: ReactNode }) {
  const rank = (id: string) => (PANE_ORDER.includes(id) ? PANE_ORDER.indexOf(id) : PANE_ORDER.length);
  const panes = (
    Children.toArray(children).filter(isValidElement) as Array<
      ReactElement<{ id: string; label: string; icon?: ReactNode; children: ReactNode }>
    >
  ).sort((a, b) => rank(a.props.id) - rank(b.props.id));
  const current = panes.find((p) => p.props.id === active) ?? panes[0];
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav aria-label="Settings sections" className="shrink-0 border-line px-4 pt-4 md:w-52 md:overflow-y-auto md:border-r md:px-3 md:py-6">
        <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {panes.map((p) => (
            <li key={p.props.id}>
              <a
                href={href('settings', p.props.id)}
                aria-current={p === current ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm whitespace-nowrap',
                  p === current ? 'bg-hover font-medium text-ink' : 'text-muted hover:bg-hover/60 hover:text-ink',
                )}
              >
                {p.props.icon}
                {p.props.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="max-w-3xl space-y-8 p-8">
          <ErrorNote>{error}</ErrorNote>
          {current?.props.children}
        </div>
      </div>
    </div>
  );
}
