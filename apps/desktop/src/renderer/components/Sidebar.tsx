import { Resizer, usePanelWidth } from './Resizer.tsx';
import {
  Bot,
  FolderKanban,
  Images,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LibraryBig,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Settings,
  Sparkles,
  Sun,
} from 'lucide-react';
import { useTheme, type Theme } from '../lib/theme.ts';
import { useEffect, useState, type ReactNode } from 'react';
import type { AppState } from '../App.tsx';
import { useApi, type Agent } from '../lib/api.ts';
import { href } from '../lib/router.ts';
import { cn } from './ui/cn.ts';
import { Wordmark } from './Wordmark.tsx';
import { AgentTree } from './AgentTree.tsx';
import { CountPill, money } from './ui/display.tsx';

function NavItem({
  to,
  icon,
  label,
  active,
  count,
  countTone,
  collapsed,
}: {
  collapsed?: boolean;
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
      title={collapsed ? (count ? `${label} (${count})` : label) : undefined}
      className={cn(
        'relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors [&_svg]:size-4 [&_svg]:shrink-0',
        active ? 'bg-hover font-medium text-ink' : 'text-ink/85 hover:bg-hover/70',
      )}
    >
      {icon}
      {collapsed ? (
        count ? (
          <span className={cn('absolute top-1 right-1.5 size-1.5 rounded-full', countTone === 'muted' ? 'bg-muted' : 'bg-accent')} />
        ) : null
      ) : (
        <>
          <span className="truncate">{label}</span>
          <CountPill n={count ?? 0} tone={countTone} />
        </>
      )}
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
  const [width, setWidth] = usePanelWidth('sidebar', 256, 200, 420);
  const [collapsed, setCollapsed] = useCollapsed();
  // The width animates; the content follows: the rail appears once the panel has closed, the full sidebar at once
  // when it opens (clipped while it grows). Icons sit at the same x in both, so only the labels come and go.
  const [settled, setSettled] = useState(collapsed);
  // The rail only once the panel has finished closing; the full sidebar the moment it starts opening.
  const c = collapsed && settled;
  const [animating, setAnimating] = useState(false);
  useEffect(() => {
    setAnimating(true);
    const t = setTimeout(() => {
      setSettled(collapsed);
      setAnimating(false);
    }, ANIMATION_MS);
    return () => clearTimeout(t);
  }, [collapsed]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setCollapsed(!collapsed);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapsed, setCollapsed]);
  const toggle = (
    <button
      type="button"
      onClick={() => setCollapsed(!collapsed)}
      title={collapsed ? 'Expand Sidebar (Ctrl+B)' : 'Collapse Sidebar (Ctrl+B)'}
      className="cursor-pointer rounded-md p-1 text-muted hover:bg-hover hover:text-ink [&_svg]:size-4"
    >
      {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
    </button>
  );
  const chatButton = (
    <button
      type="button"
      onClick={onAssistant}
      title="Chat with Yaho (Ctrl+J)"
      aria-pressed={assistantOpen}
      className={cn(
        'cursor-pointer rounded-md p-1 transition-colors [&_svg]:size-4',
        assistantOpen ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-hover hover:text-ink',
      )}
    >
      <Sparkles />
    </button>
  );
  return (
    <aside
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden border-r border-line bg-sidebar whitespace-nowrap',
        animating && 'transition-[width] duration-200 ease-out',
      )}
      style={{ width: collapsed ? RAIL : width }}
    >
      {!c && <Resizer width={width} onChange={setWidth} side="right" initial={256} />}
      {c ? (
        <div className="app-drag titlebar-left relative flex h-16 shrink-0 items-center justify-center">
          {toggle}
          <span
            title={connected ? 'Connected to the core' : 'Reconnecting to the core…'}
            className={cn('absolute top-3 right-3 size-1.5 rounded-full', connected ? 'bg-ok' : 'animate-pulse bg-warn')}
          />
        </div>
      ) : (
        <div className="app-drag titlebar-left flex h-16 shrink-0 items-center gap-2 px-4">
          <Wordmark className="h-[41px] text-ink" />
          {state?.version && <span className="text-[11px] text-muted tabular-nums">v{state.version}</span>}
          <span
            title={connected ? 'Connected to the core' : 'Reconnecting to the core…'}
            className={cn('ml-auto size-2 rounded-full', connected ? 'bg-ok' : 'animate-pulse bg-warn')}
          />
          {chatButton}
          {toggle}
        </div>
      )}

      {/* Collapsed, the chat sits in the rail with the pages; expanded, it is the small icon next to the collapse button. */}
      {c && <div className="flex justify-center pb-2">{chatButton}</div>}
      <nav className="flex flex-col gap-0.5 px-2">
        <NavItem collapsed={c} to={href('inbox')} icon={<Inbox />} label="Inbox" active={at === 'inbox'} count={state?.unread} />
        <NavItem
          collapsed={c}
          to={href('jobs')}
          icon={<Play />}
          label="Running Jobs"
          active={at === 'jobs'}
          count={(state?.running ?? 0) + (state?.queued ?? 0)}
          countTone="muted"
        />
        <NavItem collapsed={c} to={href('dashboard')} icon={<LayoutDashboard />} label="Dashboard" active={at === 'dashboard'} />
        <NavItem collapsed={c} to={href('projects')} icon={<FolderKanban />} label="Projects" active={at === 'projects'} />
        <NavItem collapsed={c} to={href('artifacts')} icon={<Images />} label="Artifacts" active={at === 'artifacts'} />
        <NavItem collapsed={c} to={href('resources')} icon={<KeyRound />} label="Resources" active={at === 'resources'} />
        <NavItem collapsed={c} to={href('library')} icon={<LibraryBig />} label="Library" active={at === 'library'} />
      </nav>

      {c ? (
        <nav className="mt-3 flex flex-1 flex-col gap-0.5 border-t border-line px-2 pt-3">
          <NavItem
            collapsed
            to={href('agents')}
            icon={<Bot />}
            label="Agents"
            active={at === 'agents'}
            count={agents.data?.filter((a) => a.running).length}
            countTone="muted"
          />
        </nav>
      ) : (
        <AgentTree agents={agents.data} active={at === 'agents' ? (route[1] ?? null) : null} />
      )}

      <div className="border-t border-line p-2">
        {state && !c && (
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
            <NavItem collapsed={c} to={href('settings')} icon={<Settings />} label="Settings" active={at === 'settings'} />
          </div>
          {!c && <ThemeSwitch />}
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

const COLLAPSED = 'yaho-sidebar-collapsed';
/** Width of the collapsed rail: the icons' left inset (18px) on both sides of a 16px icon. */
const RAIL = 52;
const ANIMATION_MS = 200;

/** Whether the sidebar is folded to an icon rail; kept per device. */
function useCollapsed(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSED) === '1';
    } catch {
      return false;
    }
  });
  return [
    v,
    (next) => {
      setV(next);
      try {
        localStorage.setItem(COLLAPSED, next ? '1' : '0');
      } catch {
        /* this session only */
      }
    },
  ];
}
