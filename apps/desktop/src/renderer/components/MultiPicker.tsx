import { Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui/button.tsx';
import { cn } from './ui/cn.ts';

export interface PickerOption {
  value: string;
  label?: string;
  hint?: string;
}

const LIMIT = 50;

/**
 * Choose any number of items from a list that may run to hundreds: the chosen ones as removable chips, the rest
 * behind a search. Only the first matches render, so a long list stays fast.
 */
export function MultiPicker({
  options,
  value,
  onChange,
  noun,
  emptyText = 'None',
}: {
  options: PickerOption[];
  value: string[];
  onChange: (v: string[]) => void;
  noun: string;
  emptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      options.filter(
        (o) =>
          !value.includes(o.value) &&
          (!q || o.value.toLowerCase().includes(q) || o.label?.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q)),
      ),
    [options, value, q],
  );
  const shown = matches.slice(0, LIMIT);

  const add = (v: string) => {
    onChange([...value, v]);
    setQuery('');
    setActive(0);
    input.current?.focus();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {value.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-accent/10 py-0.5 pr-1 pl-2 text-xs text-accent"
          >
            {byValue.get(v)?.label ?? v}
            <button
              type="button"
              title={`Remove ${v}`}
              onClick={() => onChange(value.filter((x) => x !== v))}
              className="cursor-pointer rounded p-0.5 hover:bg-accent/15"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {!value.length && <span className="text-sm text-muted">{emptyText}</span>}
      </div>
      <div ref={box} className="relative">
        <Button size="sm" onClick={() => setOpen(!open)} disabled={!options.length}>
          <Plus /> Add {noun}
        </Button>
        {!options.length && <span className="ml-2 text-xs text-muted">No {noun.toLowerCase()}s defined yet</span>}
        {open && (
          <div className="absolute z-40 mt-1 w-80 overflow-hidden rounded-xl border border-line bg-panel shadow-xl">
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
                  if (e.key === 'Escape') setOpen(false);
                  if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, shown.length - 1));
                  if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const pick = shown[active];
                    if (pick) add(pick.value);
                  }
                }}
                placeholder={`Search ${options.length} ${noun.toLowerCase()}s…`}
                className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/70"
              />
            </div>
            <div className="max-h-72 overflow-y-auto py-1">
              {shown.map((o, i) => (
                <button
                  key={o.value}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => add(o.value)}
                  className={cn('block w-full cursor-pointer px-3 py-1.5 text-left', i === active && 'bg-hover')}
                >
                  <div className="truncate text-sm">
                    {o.label ?? o.value}
                    {o.label && o.label !== o.value && <code className="ml-2 text-xs text-muted">{o.value}</code>}
                  </div>
                  {o.hint && <div className="truncate text-xs text-muted">{o.hint}</div>}
                </button>
              ))}
              {!shown.length && <div className="px-3 py-2 text-xs text-muted">{q ? 'No matches' : 'Everything is already added'}</div>}
              {matches.length > LIMIT && (
                <div className="px-3 py-1.5 text-xs text-muted">{matches.length - LIMIT} more; type to narrow down</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
