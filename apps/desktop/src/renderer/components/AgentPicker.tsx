import { Check, ChevronDown, Folder, Search } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApi, type Agent } from '../lib/api.ts';
import { cn } from './ui/cn.ts';

/**
 * Pick one agent: a searchable list grouped by sidebar folder, agents outside a folder last. The list is positioned
 * fixed so a dialog's scrolling body does not clip it.
 */
export function AgentPicker({
  agents,
  value,
  onChange,
  placeholder = 'Choose an Agent…',
}: {
  agents: Agent[] | null | undefined;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const folders = useApi<string[]>('/api/folders');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    if (open) setRect(trigger.current?.getBoundingClientRect() ?? null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: MouseEvent) =>
      !list.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node) && setOpen(false);
    const onMove = () => setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const known = folders.data ?? [];
    const matches = (agents ?? []).filter((a) => !q || a.name.toLowerCase().includes(q) || (a.folder ?? '').toLowerCase().includes(q));
    const byName = (a: Agent, b: Agent) => a.name.localeCompare(b.name);
    const out: Array<[string | null, Agent[]]> = known
      .map((f): [string, Agent[]] => [f, matches.filter((a) => a.folder === f).sort(byName)])
      .filter(([, as]) => as.length);
    const loose = matches.filter((a) => !a.folder || !known.includes(a.folder)).sort(byName);
    if (loose.length) out.push([null, loose]);
    return out;
  }, [agents, folders.data, q]);
  const flat = groups.flatMap(([, as]) => as.map((a) => a.name));

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
    setQuery('');
    setActive(0);
    trigger.current?.focus();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === 'ArrowDown' || e.key === 'Enter') && (e.preventDefault(), setOpen(true))}
        className={cn(
          'relative flex h-9 w-full cursor-pointer items-center rounded-lg border border-line bg-panel px-3 pr-9 text-left text-sm focus:border-accent/50 focus:ring-2 focus:ring-accent/30 focus:outline-none',
          value ? 'text-ink' : 'text-muted',
        )}
      >
        <span className="truncate">{value || placeholder}</span>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted" />
      </button>
      {open && rect && (
        <div
          ref={list}
          style={{ top: rect.bottom + 4, left: rect.left, width: rect.width }}
          className="fixed z-[60] overflow-hidden rounded-xl border border-line bg-panel shadow-xl"
        >
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="size-4 text-muted" />
            <input
              ref={input}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setOpen(false);
                }
                if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, flat.length - 1));
                if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (flat[active]) pick(flat[active]);
                }
              }}
              placeholder="Search agents…"
              spellCheck={false}
              className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/70"
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {!agents && <div className="px-3 py-2 text-xs text-muted">Loading agents…</div>}
            {agents && !flat.length && <div className="px-3 py-2 text-xs text-muted">No agents match.</div>}
            {groups.map(([folder, as]) => (
              <div key={folder ?? ''}>
                {(folder || groups.length > 1) && (
                  <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
                    {folder && <Folder className="size-3" />}
                    {folder ?? 'No Folder'}
                  </div>
                )}
                {as.map((a) => {
                  const i = flat.indexOf(a.name);
                  return (
                    <button
                      key={a.name}
                      type="button"
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(a.name)}
                      className={cn(
                        'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm',
                        i === active && 'bg-hover',
                      )}
                    >
                      <span className="flex-1 truncate">{a.name}</span>
                      {a.name === value && <Check className="size-3.5 text-muted" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
