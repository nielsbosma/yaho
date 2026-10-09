import { Bot, FolderKanban, Images, Inbox, KeyRound, Monitor, Moon, Play, Plus, Settings, Sparkles, Sun } from 'lucide-react';
import { useTheme, type Theme } from '../lib/theme.ts';
import type { ReactNode } from 'react';
import type { AppState } from '../App.tsx';
import { useApi, type Agent } from '../lib/api.ts';
import { href } from '../lib/router.ts';
import { cn } from './ui/cn.ts';
import { CountPill, money } from './ui/display.tsx';

function NavItem({
  to,
  icon,
  label,
  active,
  count,
  countTone,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  active: boolean;
  count?: number;
  countTone?: 'accent' | 'muted';
}) {
  return (
    <a
      href={to}
      className={cn(
        'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
        active ? 'bg-hover font-medium text-ink' : 'text-ink/85 hover:bg-hover/70',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      <CountPill n={count ?? 0} tone={countTone} />
    </a>
  );
}

export function Sidebar({
  route,
  state,
  connected,
  assistantOpen,
  onAssistant,
}: {
  route: string[];
  state: AppState | null;
  connected: boolean;
  assistantOpen: boolean;
  onAssistant: () => void;
}) {
  const agents = useApi<Agent[]>(
    '/api/agents',
    (e) => (e.type === 'changed' && e.entity === 'agents') || e.type === 'job' || e.type === 'message',
  );
  const at = route[0];
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-sidebar">
      <div className="flex h-14 items-center gap-2 px-4">
        <div className="flex size-7 items-center justify-center rounded-lg bg-accent font-serif text-[15px] text-white">Y</div>
        <span className="font-serif text-lg text-ink">YAHO</span>
        <span
          title={connected ? 'Connected to the core' : 'Reconnecting to the core…'}
          className={cn('ml-auto size-2 rounded-full', connected ? 'bg-ok' : 'animate-pulse bg-warn')}
        />
      </div>

      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={onAssistant}
          title="Chat with Yaho (Ctrl+J)"
          className={cn(
            'flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 text-sm transition-colors [&_svg]:size-4',
            assistantOpen ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line bg-panel text-ink/85 hover:border-line-strong',
          )}
        >
          <Sparkles /> Chat with Yaho
          <kbd className="ml-auto text-[10px] text-muted">Ctrl J</kbd>
        </button>
      </div>
      <nav className="flex flex-col gap-0.5 px-2">
        <NavItem to={href('inbox')} icon={<Inbox />} label="Inbox" active={at === 'inbox'} count={state?.unread} />
        <NavItem
          to={href('jobs')}
          icon={<Play />}
          label="Running Jobs"
          active={at === 'jobs'}
          count={(state?.running ?? 0) + (state?.queued ?? 0)}
          countTone="muted"
        />
        <NavItem to={href('projects')} icon={<FolderKanban />} label="Projects" active={at === 'projects'} />
        <NavItem to={href('artifacts')} icon={<Images />} label="Artifacts" active={at === 'artifacts'} />
        <NavItem to={href('resources')} icon={<KeyRound />} label="Resources" active={at === 'resources'} />
      </nav>

      <div className="mt-5 flex items-center justify-between px-4 pb-1">
        <a href={href('agents')} className="text-xs font-semibold tracking-wide text-muted uppercase hover:text-ink">
          Agents
        </a>
        <a href={href('agents', 'new')} title="New agent" className="rounded p-0.5 text-muted hover:bg-hover hover:text-ink">
          <Plus className="size-3.5" />
        </a>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2">
        {agents.data?.map((a) => (
          <a
            key={a.name}
            href={href('agents', a.name)}
            className={cn(
              'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors',
              at === 'agents' && route[1] === a.name ? 'bg-hover font-medium' : 'hover:bg-hover/70',
              !a.enabled && 'text-muted',
            )}
          >
            <Bot className={cn('size-4 shrink-0', a.running ? 'text-info' : 'text-muted')} />
            <span className="truncate">{a.name}</span>
            {a.running ? <span className="ml-auto size-1.5 animate-pulse rounded-full bg-info" /> : null}
          </a>
        ))}
        {agents.data?.length === 0 && <div className="px-2.5 py-1 text-xs text-muted">No agents yet</div>}
      </div>

      <div className="border-t border-line p-2">
        {state && (
          <div className="px-2.5 pb-2 text-xs text-muted" title="Total spend against the global cap">
            Spend {money(state.spent_usd)} of {money(state.global_spend_cap_usd)}
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-hover">
              <div
                className="h-full bg-accent"
                style={{ width: `${Math.min(100, (state.spent_usd / Math.max(0.01, state.global_spend_cap_usd)) * 100)}%` }}
              />
            </div>
          </div>
        )}
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <NavItem to={href('settings')} icon={<Settings />} label="Settings" active={at === 'settings'} />
          </div>
          <ThemeSwitch />
        </div>
      </div>
    </aside>
  );
}

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  const options: Array<[Theme, typeof Sun, string]> = [
    ['system', Monitor, 'Match System'],
    ['light', Sun, 'Light'],
    ['dark', Moon, 'Dark'],
  ];
  return (
    <div className="flex shrink-0 rounded-lg bg-hover p-0.5" role="radiogroup" aria-label="Theme">
      {options.map(([t, Icon, label]) => (
        <button
          key={t}
          type="button"
          role="radio"
          aria-checked={theme === t}
          title={label}
          onClick={() => setTheme(t)}
          className={cn('cursor-pointer rounded-md p-1 text-muted', theme === t && 'bg-panel text-ink shadow-sm')}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
